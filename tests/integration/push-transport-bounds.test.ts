/**
 * The push request is sent to a URL a browser — or an attacker posing as one —
 * handed to the server, so the server must bound what it reads back and how
 * long it waits. Neither web-push's own transport does: it buffers the whole
 * response into a string (a large enough body throws `Invalid string length`
 * from a stream listener, outside every promise, and kills the process) and it
 * has no deadline unless one is asked for.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { HttpClient } from "@c9up/ream/http-client";
import nock from "nock";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { NovaVapidConfig } from "../../src/config.js";
import { Nova } from "../../src/Nova.js";
import {
	MemorySubscriptionDriver,
	type PushSubscription,
} from "../../src/SubscriptionStore.js";
import { generateVapidKeys } from "../../src/vapid.js";

const HOST = "https://fcm.googleapis.com";
const SLOW_PATH = "/fcm/send/slow";
const OK_PATH = "/fcm/send/fine";

const TLS_DIR = new URL("./fixtures/tls/", import.meta.url);
const CERT = readFileSync(new URL("cert.pem", TLS_DIR), "utf8");
const KEY = readFileSync(new URL("key.pem", TLS_DIR), "utf8");
const OFFERED = 64 * 1024 * 1024;

let VAPID: NovaVapidConfig;
let P256DH: string;
const defaultCAs = getCACertificates("default");

function sub(endpoint: string): PushSubscription {
	return {
		endpoint,
		expirationTime: null,
		keys: { p256dh: P256DH, auth: "tBHItJI5sVmRaTQX6w4qEA" },
	};
}

beforeAll(() => {
	VAPID = { ...generateVapidKeys(), subject: "mailto:test@example.com" };
	P256DH = generateVapidKeys().publicKey;
	// The flood has to come from a real socket — a mocked one hands the whole
	// body over whether the client is still reading or not.
	setDefaultCACertificates([...defaultCAs, CERT]);
});

afterAll(() => {
	setDefaultCACertificates(defaultCAs);
});

beforeEach(() => {
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	nock.cleanAll();
	nock.enableNetConnect();
	vi.restoreAllMocks();
});

interface Flood {
	url: string;
	/** Bytes the server managed to hand to the socket. */
	written(): number;
	/** Resolves when the client has hung up. */
	hungUp: Promise<void>;
	close(): Promise<void>;
}

/** An HTTPS endpoint that answers `status` and streams 64 MiB unless stopped. */
async function flood(
	status: number,
	headers: Record<string, string> = {},
): Promise<Flood> {
	let written = 0;
	let hungUp: () => void = () => {};
	const hangUp = new Promise<void>((resolve) => {
		hungUp = resolve;
	});
	const chunk = Buffer.alloc(64 * 1024, 0x61);
	const server: Server = createServer({ cert: CERT, key: KEY }, (req, res) => {
		req.resume();
		res.on("close", () => hungUp());
		res.writeHead(status, headers);
		const pump = (): void => {
			while (written < OFFERED && !res.destroyed) {
				written += chunk.length;
				if (!res.write(chunk)) {
					res.once("drain", pump);
					return;
				}
			}
			if (!res.destroyed) res.end();
		};
		pump();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = addressOf(server);
	return {
		url: `https://127.0.0.1:${port}/push/flood`,
		written: () => written,
		hungUp: hangUp,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

function addressOf(server: Server): AddressInfo {
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("the test server has no TCP address");
	}
	return address;
}

/** The real guarded client, with the loopback test server exempted. */
function clientFor(url: string): HttpClient {
	return new HttpClient({ allowHosts: [new URL(url).host], maxRedirects: 0 });
}

describe("nova.push() — response size is bounded", () => {
	it.each([500, 201])(
		"hangs up on an endless %i body and answers a PushResult",
		async (status) => {
			const server = await flood(status);
			try {
				const nova = new Nova(new MemorySubscriptionDriver(), VAPID, {
					http: clientFor(server.url),
					allowHosts: [new URL(server.url).host],
				});
				const result = await nova.push(sub(server.url), { title: "x" });

				expect(result).toEqual({
					ok: false,
					status: 0,
					endpoint: server.url,
					reason: "server-error",
					cleaned: false,
				});
				await server.hungUp;
				// What got out is socket buffering, not the 64 MiB on offer.
				expect(server.written()).toBeLessThan(OFFERED / 4);
			} finally {
				await server.close();
			}
		},
		10_000,
	);

	it("hangs up on a declared content-length over the cap", async () => {
		const server = await flood(201, {
			"content-length": String(OFFERED),
		});
		try {
			const nova = new Nova(new MemorySubscriptionDriver(), VAPID, {
				http: clientFor(server.url),
				allowHosts: [new URL(server.url).host],
			});
			const result = await nova.push(sub(server.url), { title: "x" });

			expect(result).toMatchObject({
				ok: false,
				status: 0,
				reason: "server-error",
			});
			await server.hungUp;
			expect(server.written()).toBeLessThan(OFFERED / 4);
		} finally {
			await server.close();
		}
	}, 10_000);
});

describe("nova.push() — every request has a deadline", () => {
	it("answers server-error, status 0, once the timeout passes", async () => {
		nock.disableNetConnect();
		nock(HOST).post(SLOW_PATH).delay(10_000).reply(201, "");

		const nova = new Nova(new MemorySubscriptionDriver(), VAPID, {
			timeout: 150,
		});
		const started = Date.now();
		const result = await nova.push(sub(`${HOST}${SLOW_PATH}`), { title: "x" });

		expect(Date.now() - started).toBeLessThan(2_000);
		expect(result).toEqual({
			ok: false,
			status: 0,
			endpoint: `${HOST}${SLOW_PATH}`,
			reason: "server-error",
			cleaned: false,
		});
	}, 5_000);

	it("a silent endpoint does not hold back the rest of the fan-out", async () => {
		nock.disableNetConnect();
		nock(HOST).post(SLOW_PATH).delay(10_000).reply(201, "");
		nock(HOST).post(OK_PATH).reply(201, "");

		const store = new MemorySubscriptionDriver();
		await store.save("u1", sub(`${HOST}${SLOW_PATH}`));
		await store.save("u1", sub(`${HOST}${OK_PATH}`));
		const nova = new Nova(store, VAPID, { timeout: 150 });

		const results = await nova.pushToUser("u1", { title: "x" });

		expect(results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					endpoint: `${HOST}${SLOW_PATH}`,
					ok: false,
					status: 0,
					reason: "server-error",
				}),
				{ ok: true, status: 201, endpoint: `${HOST}${OK_PATH}` },
			]),
		);
	}, 5_000);

	it("refuses a timeout that is not a positive integer", () => {
		for (const timeout of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				() => new Nova(new MemorySubscriptionDriver(), VAPID, { timeout }),
			).toThrow(/timeout/);
		}
	});
});
