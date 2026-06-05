import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { Nova, type PushPayload } from "../../src/Nova.js";
import {
	MemorySubscriptionDriver,
	type PushSubscription,
} from "../../src/SubscriptionStore.js";

const VALID_VAPID = {
	publicKey:
		"BNcRdreALRFXTkOiHpMpfHJoDRvSgGUgmCNNxPaLyzPnlJSNiy3Y0VFm8eq2RRvODPHc4P10qOrjTlnmyUrpbyA",
	privateKey: "tBHItJI5sVmRaTQX6w4qEAtBHItJI5sVmRaTQX6w4qE",
	subject: "mailto:noreply@example.com",
};

const SUB_A: PushSubscription = {
	endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
	expirationTime: null,
	keys: {
		p256dh:
			"BNcRdreALRFXTkOiHpMpfHJoDRvSgGUgmCNNxPaLyzPnlJSNiy3Y0VFm8eq2RRvODPHc4P10qOrjTlnmyUrpbyA",
		auth: "tBHItJI5sVmRaTQX6w4qEA",
	},
};

const SUB_B: PushSubscription = {
	endpoint: "https://updates.push.services.mozilla.com/wpush/v2/xyz789",
	expirationTime: null,
	keys: {
		p256dh:
			"BD0eMcWmQXAcXzeYxbIsCe5jhNbCIRcNB4FTQqg4opS1jKCUrzSKuFQiMqSYxXNJtNTKQ2N1aBzx8aiB6F-aQEA",
		auth: "AbCdEfGhIjKlMnOpQrStUv",
	},
};

const PAYLOAD: PushPayload = {
	title: "Hello",
	body: "Test push",
	icon: "/icon.png",
	url: "/news/1",
};

let sendNotificationSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	sendNotificationSpy = vi.spyOn(webpush, "sendNotification");
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
	const nova = new Nova(store, opts?.vapid ?? VALID_VAPID);
	return { nova, store };
}

function webPushError(statusCode: number, endpoint = SUB_A.endpoint): Error {
	const err = new Error(`webpush ${statusCode}`);
	err.name = "WebPushError";
	Object.assign(err, {
		statusCode,
		endpoint,
		body: "",
		headers: {},
	});
	return err;
}

describe("Nova > push() — success path", () => {
	it("returns ok=true on 201 from the push service", async () => {
		sendNotificationSpy.mockResolvedValue({
			statusCode: 201,
			body: "",
			headers: {},
		});
		const { nova } = makeNova();
		const result = await nova.push(SUB_A, PAYLOAD);
		expect(result).toEqual({ ok: true, status: 201, endpoint: SUB_A.endpoint });
	});

	it("passes vapidDetails per call (no global setVapidDetails)", async () => {
		sendNotificationSpy.mockResolvedValue({
			statusCode: 201,
			body: "",
			headers: {},
		});
		const { nova } = makeNova();
		await nova.push(SUB_A, PAYLOAD);
		const args = sendNotificationSpy.mock.calls[0];
		expect(args?.[2]?.vapidDetails).toEqual({
			subject: VALID_VAPID.subject,
			publicKey: VALID_VAPID.publicKey,
			privateKey: VALID_VAPID.privateKey,
		});
		expect(args?.[2]?.contentEncoding).toBe("aes128gcm");
	});

	it("defaults TTL to 60 when not provided", async () => {
		sendNotificationSpy.mockResolvedValue({
			statusCode: 201,
			body: "",
			headers: {},
		});
		const { nova } = makeNova();
		await nova.push(SUB_A, PAYLOAD);
		expect(sendNotificationSpy.mock.calls[0]?.[2]?.TTL).toBe(60);
	});

	it("forwards ttl/urgency/topic options when provided", async () => {
		sendNotificationSpy.mockResolvedValue({
			statusCode: 201,
			body: "",
			headers: {},
		});
		const { nova } = makeNova();
		await nova.push(SUB_A, PAYLOAD, {
			ttl: 3600,
			urgency: "high",
			topic: "news",
		});
		const opts = sendNotificationSpy.mock.calls[0]?.[2];
		expect(opts?.TTL).toBe(3600);
		expect(opts?.urgency).toBe("high");
		expect(opts?.topic).toBe("news");
	});

	it("serializes the payload as JSON", async () => {
		sendNotificationSpy.mockResolvedValue({
			statusCode: 201,
			body: "",
			headers: {},
		});
		const { nova } = makeNova();
		await nova.push(SUB_A, PAYLOAD);
		expect(sendNotificationSpy.mock.calls[0]?.[1]).toBe(
			JSON.stringify(PAYLOAD),
		);
	});
});

describe("Nova > push() — error mapping", () => {
	it("maps 410 to gone with cleanup", async () => {
		sendNotificationSpy.mockRejectedValue(webPushError(410));
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
		sendNotificationSpy.mockRejectedValue(webPushError(404));
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
		sendNotificationSpy.mockRejectedValue(webPushError(413));
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
		sendNotificationSpy.mockRejectedValue(webPushError(429));
		const { nova } = makeNova();
		const result = await nova.push(SUB_A, PAYLOAD);
		expect(result).toMatchObject({
			ok: false,
			status: 429,
			reason: "rate-limited",
			cleaned: false,
		});
	});

	it.each([
		400, 401, 403,
	])("maps %i to rejected without cleanup", async (status) => {
		sendNotificationSpy.mockRejectedValue(webPushError(status));
		const { nova } = makeNova();
		const result = await nova.push(SUB_A, PAYLOAD);
		expect(result).toMatchObject({ ok: false, status, reason: "rejected" });
		expect(consoleWarnSpy).toHaveBeenCalled();
	});

	it.each([
		500, 502, 503,
	])("maps %i to server-error without cleanup", async (status) => {
		sendNotificationSpy.mockRejectedValue(webPushError(status));
		const { nova } = makeNova();
		const result = await nova.push(SUB_A, PAYLOAD);
		expect(result).toMatchObject({ ok: false, status, reason: "server-error" });
		expect(consoleErrorSpy).toHaveBeenCalled();
	});

	it("maps unknown status to server-error", async () => {
		sendNotificationSpy.mockRejectedValue(webPushError(999));
		const { nova } = makeNova();
		const result = await nova.push(SUB_A, PAYLOAD);
		expect(result).toMatchObject({
			ok: false,
			status: 999,
			reason: "server-error",
		});
	});

	it("re-throws non-WebPushError exceptions (network failure)", async () => {
		const networkErr = new Error("ECONNRESET");
		sendNotificationSpy.mockRejectedValue(networkErr);
		const { nova } = makeNova();
		await expect(nova.push(SUB_A, PAYLOAD)).rejects.toBe(networkErr);
	});

	it("sets cleaned=false when store.delete throws on 410", async () => {
		sendNotificationSpy.mockRejectedValue(webPushError(410));
		const store = new MemorySubscriptionDriver();
		vi.spyOn(store, "delete").mockRejectedValue(new Error("DB down"));
		const nova = new Nova(store, VALID_VAPID);
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
	it("throws NOVA_VAPID_NOT_CONFIGURED on first push when vapid is undefined", async () => {
		const nova = new Nova(new MemorySubscriptionDriver(), undefined);
		await expect(nova.push(SUB_A, PAYLOAD)).rejects.toMatchObject({
			code: "NOVA_VAPID_NOT_CONFIGURED",
		});
	});

	it("does NOT throw at construction time (lazy)", () => {
		expect(
			() => new Nova(new MemorySubscriptionDriver(), undefined),
		).not.toThrow();
	});

	it("throws NOVA_VAPID_NOT_CONFIGURED when subject has wrong prefix", async () => {
		const nova = new Nova(new MemorySubscriptionDriver(), {
			...VALID_VAPID,
			subject: "ftp://nope",
		});
		await expect(nova.push(SUB_A, PAYLOAD)).rejects.toMatchObject({
			code: "NOVA_VAPID_NOT_CONFIGURED",
		});
	});

	it("caches validation across calls (validates once)", async () => {
		sendNotificationSpy.mockResolvedValue({
			statusCode: 201,
			body: "",
			headers: {},
		});
		const { nova } = makeNova();
		await nova.push(SUB_A, PAYLOAD);
		await nova.push(SUB_A, PAYLOAD);
		// Both calls should succeed with the same VAPID — no error from re-validation.
		expect(sendNotificationSpy).toHaveBeenCalledTimes(2);
	});
});

describe("Nova > pushToUser()", () => {
	it("returns [] for an unknown user", async () => {
		sendNotificationSpy.mockResolvedValue({
			statusCode: 201,
			body: "",
			headers: {},
		});
		const { nova } = makeNova();
		expect(await nova.pushToUser("nobody", PAYLOAD)).toEqual([]);
		expect(sendNotificationSpy).not.toHaveBeenCalled();
	});

	it("pushes to every subscription for the user, in parallel", async () => {
		sendNotificationSpy.mockResolvedValue({
			statusCode: 201,
			body: "",
			headers: {},
		});
		const { nova, store } = makeNova();
		await store.save("u1", SUB_A);
		await store.save("u1", SUB_B);
		const results = await nova.pushToUser("u1", PAYLOAD);
		expect(results).toHaveLength(2);
		expect(results.every((r) => r.ok === true)).toBe(true);
		expect(sendNotificationSpy).toHaveBeenCalledTimes(2);
	});

	it("isolates per-subscription failures (one 410, one 200 → both reported, gone one cleaned)", async () => {
		sendNotificationSpy.mockImplementation(async (sub) => {
			if (sub.endpoint === SUB_A.endpoint) {
				const err = webPushError(410, SUB_A.endpoint);
				throw err;
			}
			return { statusCode: 201, body: "", headers: {} };
		});
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
		sendNotificationSpy.mockResolvedValue({
			statusCode: 201,
			body: "",
			headers: {},
		});
		const { nova } = makeNova();
		const topic = "a".repeat(32);
		const result = await nova.push(SUB_A, PAYLOAD, { topic });
		expect(result.ok).toBe(true);
		expect(sendNotificationSpy.mock.calls[0]?.[2]?.topic).toBe(topic);
	});

	it("ignores empty-string topic (treated as absent)", async () => {
		sendNotificationSpy.mockResolvedValue({
			statusCode: 201,
			body: "",
			headers: {},
		});
		const { nova } = makeNova();
		await nova.push(SUB_A, PAYLOAD, { topic: "" });
		expect(sendNotificationSpy.mock.calls[0]?.[2]?.topic).toBeUndefined();
	});
});

describe("Nova > isWebPushError stricter discrimination (review patch)", () => {
	it("re-throws a foreign error with numeric statusCode but no name", async () => {
		const foreign = new Error("from some HTTP middleware");
		Object.assign(foreign, { statusCode: 503 });
		sendNotificationSpy.mockRejectedValue(foreign);
		const { nova } = makeNova();
		await expect(nova.push(SUB_A, PAYLOAD)).rejects.toBe(foreign);
	});

	it("re-throws a real WebPushError with no parsed statusCode (transport failure)", async () => {
		const transport = new Error("ECONNRESET mid-handshake");
		transport.name = "WebPushError";
		// no statusCode → not classifiable as a structured push failure
		sendNotificationSpy.mockRejectedValue(transport);
		const { nova } = makeNova();
		await expect(nova.push(SUB_A, PAYLOAD)).rejects.toBe(transport);
	});
});

describe("Nova > pushToUser per-subscription error isolation (review patch)", () => {
	it("isolates a thrown error on one device — others still get a result", async () => {
		const networkErr = new Error("ECONNRESET");
		sendNotificationSpy.mockImplementation(async (sub) => {
			if (sub.endpoint === SUB_A.endpoint) throw networkErr;
			return { statusCode: 201, body: "", headers: {} };
		});
		const { nova, store } = makeNova();
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
		sendNotificationSpy.mockResolvedValue({
			statusCode: 201,
			body: "",
			headers: {},
		});
		const { nova, store } = makeNova();
		await store.save("u1", SUB_A);
		await store.save("u1", SUB_B);
		const badPayload = {
			title: "hi",
			data: { count: 1n },
		} as unknown as PushPayload;
		const results = await nova.pushToUser("u1", badPayload);
		expect(results).toHaveLength(2);
		// Both fail with server-error since JSON.stringify throws for both calls
		expect(results.every((r) => !r.ok && r.reason === "server-error")).toBe(
			true,
		);
	});
});
