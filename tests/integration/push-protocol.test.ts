/**
 * Integration test — verifies that `nova.push()` produces a Web Push
 * Protocol-compliant outbound HTTP request (RFC 8030 / RFC 8291).
 *
 * Uses `nock` to intercept the outbound POST and assert on headers + body.
 * Body is encrypted (AES-128-GCM via web-push's RFC 8188 aes128gcm path),
 * so we assert it is non-empty bytes that do NOT contain the plaintext.
 */

import nock from "nock";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NovaVapidConfig } from "../../src/config.js";
import { Nova } from "../../src/Nova.js";
import {
	MemorySubscriptionDriver,
	type PushSubscription,
} from "../../src/SubscriptionStore.js";
import { generateVapidKeys } from "../../src/vapid.js";

const ENDPOINT_HOST = "https://fcm.googleapis.com";
const ENDPOINT_PATH = "/fcm/send/integration-test-token";
const ENDPOINT = `${ENDPOINT_HOST}${ENDPOINT_PATH}`;

// Real-shape subscription generated for the test (deterministic-ish bytes
// from a fresh ephemeral key pair so encryption succeeds end-to-end).
let SUB: PushSubscription;
let VAPID: NovaVapidConfig;

beforeAll(async () => {
	VAPID = { ...generateVapidKeys(), subject: "mailto:test@example.com" };
	const ephemeral = generateVapidKeys();
	// Reuse the public-key encoding helper for the receiver's p256dh.
	SUB = {
		endpoint: ENDPOINT,
		expirationTime: null,
		keys: {
			p256dh: ephemeral.publicKey,
			auth: "tBHItJI5sVmRaTQX6w4qEA",
		},
	};
});

beforeEach(() => {
	nock.disableNetConnect();
});

afterEach(() => {
	nock.cleanAll();
	nock.enableNetConnect();
});

describe("nova.push() — Web Push Protocol headers + body", () => {
	it("sends a POST with aes128gcm encoding, vapid auth, and TTL header", async () => {
		let capturedHeaders: Record<string, string | string[]> = {};
		let capturedBody: Buffer | undefined;

		const scope = nock(ENDPOINT_HOST)
			.post(ENDPOINT_PATH)
			.reply(function (_uri, requestBody) {
				capturedHeaders = this.req.headers as Record<string, string | string[]>;
				capturedBody = Buffer.isBuffer(requestBody)
					? requestBody
					: Buffer.from(requestBody as string, "binary");
				return [201, "", {}];
			});

		const nova = new Nova(new MemorySubscriptionDriver(), VAPID);
		const result = await nova.push(SUB, { title: "ping", body: "pong" });

		expect(scope.isDone()).toBe(true);
		expect(result).toEqual({ ok: true, status: 201, endpoint: ENDPOINT });

		expect(capturedHeaders["content-encoding"]).toBe("aes128gcm");
		expect(capturedHeaders.ttl).toBe("60");

		const auth = capturedHeaders.authorization;
		expect(auth).toBeDefined();
		const authStr = Array.isArray(auth) ? auth[0] : auth;
		expect(authStr).toMatch(/^vapid /);
		expect(authStr).toMatch(/t=ey/); // JWT prefix (ES256 header is `eyJ...`)
		expect(authStr).toMatch(/k=B/); // base64url-encoded public key starts with B (uncompressed P-256 0x04 prefix)

		expect(capturedBody).toBeDefined();
		expect(capturedBody?.length).toBeGreaterThan(0);
		// Plaintext "ping" / "pong" must NOT appear in the encrypted body.
		expect(capturedBody?.toString("utf8")).not.toContain("ping");
		expect(capturedBody?.toString("utf8")).not.toContain("pong");
	});

	it("forwards urgency + topic + custom TTL when provided", async () => {
		let capturedHeaders: Record<string, string | string[]> = {};
		nock(ENDPOINT_HOST)
			.post(ENDPOINT_PATH)
			.reply(function () {
				capturedHeaders = this.req.headers as Record<string, string | string[]>;
				return [201, "", {}];
			});

		const nova = new Nova(new MemorySubscriptionDriver(), VAPID);
		await nova.push(
			SUB,
			{ title: "high-priority" },
			{ ttl: 3600, urgency: "high", topic: "alert" },
		);

		expect(capturedHeaders.ttl).toBe("3600");
		expect(capturedHeaders.urgency).toBe("high");
		expect(capturedHeaders.topic).toBe("alert");
	});
});
