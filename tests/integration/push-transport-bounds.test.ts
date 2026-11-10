/**
 * The push request is sent to a URL a browser — or an attacker posing as one —
 * handed to the server, so the server must bound what it reads back and how
 * long it waits. Nova asks the outbound client for both bounds on every
 * request and turns the client giving up into a PushResult rather than a
 * throw. Enforcing the bounds on a real socket is the client's own contract,
 * tested with it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NovaVapidConfig } from "../../src/config.js";
import { Nova } from "../../src/Nova.js";
import {
	MemorySubscriptionDriver,
	type PushSubscription,
} from "../../src/SubscriptionStore.js";
import { generateVapidKeys } from "../../src/vapid.js";
import {
	type FakePushHttp,
	fakePushHttp,
	transportError,
} from "../__helpers__/http.js";

const HOST = "https://fcm.googleapis.com";
const SLOW = `${HOST}/fcm/send/slow`;
const OK = `${HOST}/fcm/send/fine`;

const VAPID: NovaVapidConfig = {
	...generateVapidKeys(),
	subject: "mailto:test@example.com",
};
const P256DH = generateVapidKeys().publicKey;

function sub(endpoint: string): PushSubscription {
	return {
		endpoint,
		expirationTime: null,
		keys: { p256dh: P256DH, auth: "tBHItJI5sVmRaTQX6w4qEA" },
	};
}

let http: FakePushHttp;

beforeEach(() => {
	http = fakePushHttp();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** An endpoint that stays silent until the request's own deadline passes. */
function silentUntilDeadline(url: string): void {
	http.on("POST", url, async (request) => {
		await new Promise((resolve) => setTimeout(resolve, request.timeout));
		throw transportError("timedOut", url);
	});
}

describe("nova.push() — response size is bounded", () => {
	it("caps every response at 16 KiB", async () => {
		http.on("POST", OK, { status: 201 });
		const nova = new Nova(new MemorySubscriptionDriver(), VAPID, { http });
		await nova.push(sub(OK), { title: "x" });
		expect(http.requests[0]?.maxResponseBytes).toBe(16 * 1024);
	});

	it("answers a PushResult when the client hangs up on an oversized body", async () => {
		http.on("POST", OK, () => {
			throw transportError("tooLarge", OK);
		});
		const nova = new Nova(new MemorySubscriptionDriver(), VAPID, { http });
		expect(await nova.push(sub(OK), { title: "x" })).toEqual({
			ok: false,
			status: 0,
			endpoint: OK,
			reason: "server-error",
			cleaned: false,
		});
	});
});

describe("nova.push() — every request has a deadline", () => {
	it("defaults the deadline to 10 seconds", async () => {
		http.on("POST", OK, { status: 201 });
		const nova = new Nova(new MemorySubscriptionDriver(), VAPID, { http });
		await nova.push(sub(OK), { title: "x" });
		expect(http.requests[0]?.timeout).toBe(10_000);
	});

	it("answers server-error, status 0, once the timeout passes", async () => {
		silentUntilDeadline(SLOW);
		const nova = new Nova(new MemorySubscriptionDriver(), VAPID, {
			http,
			timeout: 300,
		});
		const started = Date.now();
		const result = await nova.push(sub(SLOW), { title: "x" });

		expect(http.requests[0]?.timeout).toBe(300);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(result).toEqual({
			ok: false,
			status: 0,
			endpoint: SLOW,
			reason: "server-error",
			cleaned: false,
		});
	});

	it("a silent endpoint does not hold back the rest of the fan-out", async () => {
		silentUntilDeadline(SLOW);
		http.on("POST", OK, { status: 201 });

		const store = new MemorySubscriptionDriver();
		await store.save("u1", sub(SLOW));
		await store.save("u1", sub(OK));
		const nova = new Nova(store, VAPID, { http, timeout: 300 });

		const results = await nova.pushToUser("u1", { title: "x" });

		expect(results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					endpoint: SLOW,
					ok: false,
					status: 0,
					reason: "server-error",
				}),
				{ ok: true, status: 201, endpoint: OK },
			]),
		);
		// The silent one keeps its subscription: no answer is not a 404/410.
		expect(await store.listByUser("u1")).toHaveLength(2);
	});

	it("refuses a timeout that is not a positive integer", () => {
		for (const timeout of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				() => new Nova(new MemorySubscriptionDriver(), VAPID, { timeout }),
			).toThrow(/timeout/);
		}
	});
});
