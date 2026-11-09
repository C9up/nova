import {
	type FakeHttpClient,
	fakeHttp,
	HttpClientError,
} from "@c9up/ream/http-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Nova, type PushPayload } from "../../src/Nova.js";
import {
	MemorySubscriptionDriver,
	type PushSubscription,
} from "../../src/SubscriptionStore.js";
import { generateVapidKeys } from "../../src/vapid.js";

// Real keys: the payload is encrypted for the subscription's p256dh, which has
// to be a point on P-256 for that to work.
const VALID_VAPID = {
	...generateVapidKeys(),
	subject: "mailto:noreply@example.com",
};

const SUB_A: PushSubscription = {
	endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
	expirationTime: null,
	keys: {
		p256dh: generateVapidKeys().publicKey,
		auth: "tBHItJI5sVmRaTQX6w4qEA",
	},
};

const SUB_B: PushSubscription = {
	endpoint: "https://updates.push.services.mozilla.com/wpush/v2/xyz789",
	expirationTime: null,
	keys: {
		p256dh: generateVapidKeys().publicKey,
		auth: "AbCdEfGhIjKlMnOpQrStUg",
	},
};

const PAYLOAD: PushPayload = {
	title: "Hello",
	body: "Test push",
	icon: "/icon.png",
	url: "/news/1",
};

let http: FakeHttpClient;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	// Configured like the client Nova builds for itself.
	http = fakeHttp({ maxRedirects: 0 });
	consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeNova(opts?: {
	vapid?: typeof VALID_VAPID | undefined;
	store?: MemorySubscriptionDriver;
}): { nova: Nova; store: MemorySubscriptionDriver } {
	const store = opts?.store ?? new MemorySubscriptionDriver();
	const nova = new Nova(store, opts?.vapid ?? VALID_VAPID, { http });
	return { nova, store };
}

/** Every endpoint answers `status`. */
function answer(status: number, headers: Record<string, string> = {}): void {
	http.on("POST", () => true, { status, headers });
}

function sentHeader(index: number, name: string): string | undefined {
	return http.requests[index]?.headers[name];
}

/** aes128gcm, one record: 86-byte header + plaintext + 1 delimiter + 16 tag. */
function plaintextLength(index: number): number | undefined {
	const body = http.requests[index]?.body;
	return body === undefined ? undefined : body.length - 86 - 1 - 16;
}

describe("Nova > push() — success path", () => {
	it("returns ok=true on 201 from the push service", async () => {
		answer(201);
		const { nova } = makeNova();
		const result = await nova.push(SUB_A, PAYLOAD);
		expect(result).toEqual({ ok: true, status: 201, endpoint: SUB_A.endpoint });
	});

	it("posts to the subscription endpoint", async () => {
		answer(201);
		const { nova } = makeNova();
		await nova.push(SUB_A, PAYLOAD);
		expect(http.requests).toHaveLength(1);
		expect(http.requests[0]?.method).toBe("POST");
		expect(http.requests[0]?.url).toBe(SUB_A.endpoint);
	});

	it("signs with the instance's own VAPID key (no global setVapidDetails)", async () => {
		answer(201);
		const { nova } = makeNova();
		await nova.push(SUB_A, PAYLOAD);
		expect(sentHeader(0, "authorization")).toMatch(
			new RegExp(`^vapid t=ey[^,]+, k=${VALID_VAPID.publicKey}$`),
		);
		expect(sentHeader(0, "content-encoding")).toBe("aes128gcm");
	});

	it("defaults TTL to 60 when not provided", async () => {
		answer(201);
		const { nova } = makeNova();
		await nova.push(SUB_A, PAYLOAD);
		expect(sentHeader(0, "ttl")).toBe("60");
	});

	it("forwards ttl/urgency/topic options when provided", async () => {
		answer(201);
		const { nova } = makeNova();
		await nova.push(SUB_A, PAYLOAD, {
			ttl: 3600,
			urgency: "high",
			topic: "news",
		});
		expect(sentHeader(0, "ttl")).toBe("3600");
		expect(sentHeader(0, "urgency")).toBe("high");
		expect(sentHeader(0, "topic")).toBe("news");
	});

	it("encrypts the JSON-serialised payload in a single record", async () => {
		answer(201);
		const { nova } = makeNova();
		await nova.push(SUB_A, PAYLOAD);
		expect(plaintextLength(0)).toBe(Buffer.byteLength(JSON.stringify(PAYLOAD)));
		expect(http.requests[0]?.body?.includes(Buffer.from("Hello"))).toBe(false);
	});
});

describe("Nova > push() — error mapping", () => {
	it("maps 410 to gone with cleanup", async () => {
		answer(410);
		const { nova, store } = makeNova();
		await store.save("u1", SUB_A);
		const result = await nova.push(SUB_A, PAYLOAD);
		expect(result).toEqual({
			ok: false,
			status: 410,
			endpoint: SUB_A.endpoint,
			reason: "gone",
			cleaned: true,
		});
		expect(await store.listByUser("u1")).toEqual([]);
	});

	it("maps 404 to gone with cleanup", async () => {
		answer(404);
		const { nova, store } = makeNova();
		await store.save("u1", SUB_A);
		const result = await nova.push(SUB_A, PAYLOAD);
		expect(result).toMatchObject({
			ok: false,
			status: 404,
			reason: "gone",
			cleaned: true,
		});
		expect(await store.listByUser("u1")).toEqual([]);
	});

	it("maps 413 to too-large without cleanup", async () => {
		answer(413);
		const { nova } = makeNova();
		const result = await nova.push(SUB_A, PAYLOAD);
		expect(result).toMatchObject({
			ok: false,
			status: 413,
			reason: "too-large",
			cleaned: false,
		});
	});

	it("maps 429 to rate-limited without cleanup", async () => {
		answer(429);
		const { nova } = makeNova();
		const result = await nova.push(SUB_A, PAYLOAD);
		expect(result).toMatchObject({
			ok: false,
			status: 429,
			reason: "rate-limited",
			cleaned: false,
		});
	});

	it.each([400, 401, 403])(
		"maps %i to rejected without cleanup",
		async (status) => {
			answer(status);
			const { nova } = makeNova();
			const result = await nova.push(SUB_A, PAYLOAD);
			expect(result).toMatchObject({ ok: false, status, reason: "rejected" });
			expect(consoleWarnSpy).toHaveBeenCalled();
		},
	);

	it.each([500, 502, 503])(
		"maps %i to server-error without cleanup",
		async (status) => {
			answer(status);
			const { nova } = makeNova();
			const result = await nova.push(SUB_A, PAYLOAD);
			expect(result).toMatchObject({
				ok: false,
				status,
				reason: "server-error",
			});
			expect(consoleErrorSpy).toHaveBeenCalled();
		},
	);

	it.each([302, 307, 999])(
		"maps %i to server-error (a push service does not redirect)",
		async (status) => {
			answer(status, { location: "https://elsewhere.example/" });
			const { nova } = makeNova();
			const result = await nova.push(SUB_A, PAYLOAD);
			expect(result).toMatchObject({
				ok: false,
				status,
				reason: "server-error",
			});
			expect(http.requests).toHaveLength(1);
		},
	);

	it.each(["unreachable", "timedOut", "tooLarge"] as const)(
		"maps a %s transport failure to server-error with status 0",
		async (reason) => {
			http.on(
				"POST",
				() => true,
				() => {
					throw new HttpClientError(reason, SUB_A.endpoint, "boom");
				},
			);
			const { nova, store } = makeNova();
			await store.save("u1", SUB_A);
			const result = await nova.push(SUB_A, PAYLOAD);
			expect(result).toEqual({
				ok: false,
				status: 0,
				endpoint: SUB_A.endpoint,
				reason: "server-error",
				cleaned: false,
			});
			// Not an answer from the push service: the subscription stays.
			expect(await store.listByUser("u1")).toHaveLength(1);
		},
	);

	it("re-throws an error that is not a transport failure", async () => {
		const foreign = new Error("from some HTTP middleware");
		Object.assign(foreign, { statusCode: 503 });
		const { nova } = makeNova();
		const client = {
			request: async () => {
				throw foreign;
			},
		};
		const custom = new Nova(new MemorySubscriptionDriver(), VALID_VAPID, {
			http: client,
		});
		await expect(custom.push(SUB_A, PAYLOAD)).rejects.toBe(foreign);
		expect(nova).toBeInstanceOf(Nova);
	});

	it("sets cleaned=false when store.delete throws on 410", async () => {
		answer(410);
		const store = new MemorySubscriptionDriver();
		vi.spyOn(store, "delete").mockRejectedValue(new Error("DB down"));
		const nova = new Nova(store, VALID_VAPID, { http });
		const result = await nova.push(SUB_A, PAYLOAD);
		expect(result).toMatchObject({
			ok: false,
			status: 410,
			reason: "gone",
			cleaned: false,
		});
		expect(consoleErrorSpy).toHaveBeenCalled();
	});
});

describe("Nova > VAPID validation", () => {
	it("throws E_NOVA_VAPID_NOT_CONFIGURED on first push when vapid is undefined", async () => {
		const nova = new Nova(new MemorySubscriptionDriver(), undefined, { http });
		await expect(nova.push(SUB_A, PAYLOAD)).rejects.toMatchObject({
			code: "E_NOVA_VAPID_NOT_CONFIGURED",
		});
		expect(http.requests).toHaveLength(0);
	});

	it("does NOT throw at construction time (lazy)", () => {
		expect(
			() => new Nova(new MemorySubscriptionDriver(), undefined),
		).not.toThrow();
	});

	// Audit 2026-06-13: the message pointed at `ream nova:vapid:generate`, a CLI
	// command that does not exist. It must reference the real public API.
	it("VAPID-missing error points at generateVapidKeys(), not a nonexistent CLI command", async () => {
		const nova = new Nova(new MemorySubscriptionDriver(), undefined, { http });
		await expect(nova.push(SUB_A, PAYLOAD)).rejects.toThrow(
			/generateVapidKeys/,
		);
	});

	it("throws E_NOVA_VAPID_NOT_CONFIGURED when subject has wrong prefix", async () => {
		const nova = new Nova(
			new MemorySubscriptionDriver(),
			{ ...VALID_VAPID, subject: "ftp://nope" },
			{ http },
		);
		await expect(nova.push(SUB_A, PAYLOAD)).rejects.toMatchObject({
			code: "E_NOVA_VAPID_NOT_CONFIGURED",
		});
	});

	it("caches validation across calls (validates once)", async () => {
		answer(201);
		const { nova } = makeNova();
		await nova.push(SUB_A, PAYLOAD);
		await nova.push(SUB_A, PAYLOAD);
		expect(http.requests).toHaveLength(2);
	});
});

describe("Nova > pushToUser()", () => {
	it("returns [] for an unknown user", async () => {
		answer(201);
		const { nova } = makeNova();
		expect(await nova.pushToUser("nobody", PAYLOAD)).toEqual([]);
		expect(http.requests).toHaveLength(0);
	});

	it("pushes to every subscription for the user", async () => {
		answer(201);
		const { nova, store } = makeNova();
		await store.save("u1", SUB_A);
		await store.save("u1", SUB_B);
		const results = await nova.pushToUser("u1", PAYLOAD);
		expect(results).toHaveLength(2);
		expect(results.every((r) => r.ok === true)).toBe(true);
		expect(http.requests).toHaveLength(2);
	});

	it("isolates per-subscription failures (one 410, one 201 → both reported, gone one cleaned)", async () => {
		http.on("POST", SUB_A.endpoint, { status: 410 });
		http.on("POST", SUB_B.endpoint, { status: 201 });
		const { nova, store } = makeNova();
		await store.save("u1", SUB_A);
		await store.save("u1", SUB_B);
		const results = await nova.pushToUser("u1", PAYLOAD);
		expect(results).toHaveLength(2);
		const goneResult = results.find((r) => r.endpoint === SUB_A.endpoint);
		const okResult = results.find((r) => r.endpoint === SUB_B.endpoint);
		expect(goneResult).toMatchObject({
			ok: false,
			status: 410,
			reason: "gone",
			cleaned: true,
		});
		expect(okResult).toMatchObject({ ok: true, status: 201 });
		expect(await store.listByUser("u1")).toHaveLength(1);
		expect((await store.listByUser("u1"))[0]?.endpoint).toBe(SUB_B.endpoint);
	});
});

describe("Nova > push() — ttl/topic validation (review patches)", () => {
	it("throws on ttl: NaN", async () => {
		const { nova } = makeNova();
		await expect(
			nova.push(SUB_A, PAYLOAD, { ttl: Number.NaN }),
		).rejects.toThrow(/invalid push option `ttl`/);
	});

	it("throws on negative ttl", async () => {
		const { nova } = makeNova();
		await expect(nova.push(SUB_A, PAYLOAD, { ttl: -1 })).rejects.toThrow(
			/invalid push option `ttl`/,
		);
	});

	it("throws on fractional ttl", async () => {
		const { nova } = makeNova();
		await expect(nova.push(SUB_A, PAYLOAD, { ttl: 1.5 })).rejects.toThrow(
			/invalid push option `ttl`/,
		);
	});

	it("throws on topic > 32 chars", async () => {
		const { nova } = makeNova();
		await expect(
			nova.push(SUB_A, PAYLOAD, { topic: "a".repeat(33) }),
		).rejects.toThrow(/invalid push option `topic`/);
	});

	it("throws on topic with non-base64url chars (header injection guard)", async () => {
		const { nova } = makeNova();
		await expect(
			nova.push(SUB_A, PAYLOAD, { topic: "news/breaking" }),
		).rejects.toThrow(/invalid push option `topic`/);
	});

	it("accepts topic of exactly 32 base64url chars", async () => {
		answer(201);
		const { nova } = makeNova();
		const topic = "a".repeat(32);
		const result = await nova.push(SUB_A, PAYLOAD, { topic });
		expect(result.ok).toBe(true);
		expect(sentHeader(0, "topic")).toBe(topic);
	});

	it("ignores empty-string topic (treated as absent)", async () => {
		answer(201);
		const { nova } = makeNova();
		await nova.push(SUB_A, PAYLOAD, { topic: "" });
		expect(sentHeader(0, "topic")).toBeUndefined();
	});
});

describe("Nova > pushToUser per-subscription error isolation (review patch)", () => {
	it("isolates a thrown error on one device — others still get a result", async () => {
		const failing = new Error("not a transport failure");
		const client = {
			request: async (url: string) => {
				if (url === SUB_A.endpoint) throw failing;
				return { status: 201, header: () => undefined };
			},
		};
		const store = new MemorySubscriptionDriver();
		const nova = new Nova(store, VALID_VAPID, { http: client });
		await store.save("u1", SUB_A);
		await store.save("u1", SUB_B);
		const results = await nova.pushToUser("u1", PAYLOAD);
		expect(results).toHaveLength(2);
		const aResult = results.find((r) => r.endpoint === SUB_A.endpoint);
		const bResult = results.find((r) => r.endpoint === SUB_B.endpoint);
		expect(aResult).toMatchObject({
			ok: false,
			status: 0,
			reason: "server-error",
			cleaned: false,
		});
		expect(bResult).toMatchObject({ ok: true, status: 201 });
		expect(consoleErrorSpy).toHaveBeenCalled();
	});

	it("isolates a JSON.stringify failure (BigInt payload) from breaking the fan-out", async () => {
		answer(201);
		const { nova, store } = makeNova();
		await store.save("u1", SUB_A);
		await store.save("u1", SUB_B);
		const badPayload: PushPayload = {
			title: "hi",
			data: { count: 1n },
		};
		const results = await nova.pushToUser("u1", badPayload);
		expect(results).toHaveLength(2);
		// Both fail with server-error since JSON.stringify throws for both calls
		expect(results.every((r) => !r.ok && r.reason === "server-error")).toBe(
			true,
		);
		expect(http.requests).toHaveLength(0);
	});
});

describe("Nova > push() — only push services are contacted", () => {
	it.each([
		"https://127.0.0.1:36501/internal/admin/purge?confirm=yes",
		"https://[::1]:9200/_all",
		"https://attacker.example.com/push",
		"http://fcm.googleapis.com/fcm/send/x",
	])("refuses a stored %s without sending anything", async (endpoint) => {
		answer(201);
		const { nova, store } = makeNova();
		const stale = { ...SUB_A, endpoint };
		await store.save("u1", stale);
		const result = await nova.push(stale, PAYLOAD);
		expect(result).toEqual({
			ok: false,
			status: 0,
			endpoint,
			reason: "refused",
			cleaned: false,
		});
		expect(http.requests).toHaveLength(0);
		expect(consoleWarnSpy).toHaveBeenCalled();
	});

	it("maps a client-side address refusal to refused", async () => {
		http.on(
			"POST",
			() => true,
			() => {
				throw new HttpClientError("privateAddress", SUB_A.endpoint, "boom");
			},
		);
		const { nova } = makeNova();
		expect(await nova.push(SUB_A, PAYLOAD)).toMatchObject({
			ok: false,
			status: 0,
			reason: "refused",
		});
	});

	it("sends to a push service added in the options", async () => {
		answer(201);
		const store = new MemorySubscriptionDriver();
		const nova = new Nova(store, VALID_VAPID, {
			http,
			pushServices: ["push.example.net"],
		});
		const endpoint = "https://eu.push.example.net/s/1";
		expect(await nova.push({ ...SUB_A, endpoint }, PAYLOAD)).toMatchObject({
			ok: true,
		});
		// Replacing the list drops the defaults.
		expect(await nova.push(SUB_A, PAYLOAD)).toMatchObject({
			reason: "refused",
		});
	});

	it.each(["", ".push.example.net", "*.push.example.net"])(
		"refuses the pushServices entry %j",
		(entry) => {
			expect(
				() =>
					new Nova(new MemorySubscriptionDriver(), VALID_VAPID, {
						pushServices: [entry],
					}),
			).toThrow(/pushServices/);
		},
	);
});

describe("Nova > push() — a subscription whose keys cannot be used", () => {
	it.each([
		["a 64-byte p256dh", "B".repeat(86), "tBHItJI5sVmRaTQX6w4qEA"],
		["a 19-byte auth", generateVapidKeys().publicKey, "A".repeat(26)],
	])(
		"is deleted from the store without a request (%s)",
		async (_label, p256dh, auth) => {
			answer(201);
			const store = new MemorySubscriptionDriver();
			// Stored before the boundary checked keys this closely.
			const dead = { ...SUB_A, keys: { p256dh, auth } };
			await store.save("u1", dead);
			const nova = new Nova(store, VALID_VAPID, { http });

			const result = await nova.push(dead, PAYLOAD);

			expect(result).toEqual({
				ok: false,
				status: 0,
				endpoint: SUB_A.endpoint,
				reason: "gone",
				cleaned: true,
			});
			expect(http.requests).toHaveLength(0);
			expect(await store.listByUser("u1")).toEqual([]);
		},
	);
});
