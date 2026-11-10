/**
 * Integration test — verifies that `nova.push()` produces a Web Push
 * Protocol-compliant outbound HTTP request (RFC 8030 / RFC 8291).
 *
 * A fake outbound client records the POST so its headers and body can be read.
 * Body is encrypted (AES-128-GCM via web-push's RFC 8188 aes128gcm path),
 * so we assert it is non-empty bytes that do NOT contain the plaintext.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NovaVapidConfig } from "../../src/config.js";
import { Nova } from "../../src/Nova.js";
import {
	MemorySubscriptionDriver,
	type PushSubscription,
} from "../../src/SubscriptionStore.js";
import { generateVapidKeys } from "../../src/vapid.js";
import { type FakePushHttp, fakePushHttp } from "../__helpers__/http.js";

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

let http: FakePushHttp;

beforeEach(() => {
	http = fakePushHttp();
});

describe("nova.push() — Web Push Protocol headers + body", () => {
	it("sends a POST with aes128gcm encoding, vapid auth, and TTL header", async () => {
		http.on("POST", ENDPOINT, { status: 201 });

		const nova = new Nova(new MemorySubscriptionDriver(), VAPID, { http });
		const result = await nova.push(SUB, { title: "ping", body: "pong" });

		expect(http.requests).toHaveLength(1);
		expect(http.requests[0]?.method).toBe("POST");
		expect(http.requests[0]?.url).toBe(ENDPOINT);
		expect(result).toEqual({ ok: true, status: 201, endpoint: ENDPOINT });
		const capturedHeaders = http.requests[0]?.headers ?? {};
		const capturedBody = http.requests[0]?.body;

		expect(capturedHeaders["content-encoding"]).toBe("aes128gcm");
		expect(capturedHeaders.ttl).toBe("60");

		const authStr = capturedHeaders.authorization;
		expect(authStr).toBeDefined();
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
		http.on("POST", ENDPOINT, { status: 201 });

		const nova = new Nova(new MemorySubscriptionDriver(), VAPID, { http });
		await nova.push(
			SUB,
			{ title: "high-priority" },
			{ ttl: 3600, urgency: "high", topic: "alert" },
		);

		const capturedHeaders = http.requests[0]?.headers ?? {};
		expect(capturedHeaders.ttl).toBe("3600");
		expect(capturedHeaders.urgency).toBe("high");
		expect(capturedHeaders.topic).toBe("alert");
	});
});
