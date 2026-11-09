/**
 * The keys of a subscription are what the payload is encrypted for, so a
 * subscription whose keys cannot be used is refused where it arrives — not
 * stored, failed on every push, and never pruned (pruning waits for a 404/410
 * from a push service that is never contacted).
 *
 * RFC 8291 §3.1: `p256dh` is the 65-octet uncompressed P-256 point
 * (0x04 || X || Y). §3.2: `auth` is a 16-octet secret.
 */

import { createECDH } from "node:crypto";
import { describe, expect, it } from "vitest";
import { subscriptionProblem } from "../../src/_internal/subscription.js";
import { SubscribeController } from "../../src/SubscribeController.js";
import { MemorySubscriptionDriver } from "../../src/SubscriptionStore.js";
import { realAuth, realP256dh } from "../__helpers__/subscription.js";

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/keys";

function problemWith(keys: { p256dh: string; auth: string }): string | null {
	return subscriptionProblem({
		endpoint: ENDPOINT,
		expirationTime: null,
		...keys,
	});
}

/** A point whose last coordinate byte is flipped: right size, off the curve. */
function offCurve(): string {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const point = ecdh.getPublicKey();
	point[64] = (point[64] ?? 0) ^ 0x01;
	return point.toString("base64url");
}

describe("subscription keys", () => {
	it("accepts a real browser-shaped pair", () => {
		expect(problemWith({ p256dh: realP256dh(), auth: realAuth() })).toBeNull();
	});

	it.each([
		["86 chars (64 bytes)", "B".repeat(86)],
		["90 chars (67 bytes)", "B".repeat(90)],
		["87 chars, no 0x04 prefix", Buffer.alloc(65, 7).toString("base64url")],
		["87 chars, not on the curve", offCurve()],
		[
			"the point at zero",
			Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString("base64url"),
		],
	])("refuses a p256dh of %s", (_label, p256dh) => {
		expect(problemWith({ p256dh, auth: realAuth() })).toMatch(/p256dh/);
	});

	it.each([
		["26 chars (19 bytes)", "A".repeat(26)],
		["23 chars", "A".repeat(23)],
		["21 chars", "A".repeat(21)],
		["22 chars with stray trailing bits", "AbCdEfGhIjKlMnOpQrStUv"],
	])("refuses an auth secret of %s", (_label, auth) => {
		expect(problemWith({ p256dh: realP256dh(), auth })).toMatch(/auth/);
	});

	it("answers 400 at the subscribe route and stores nothing", async () => {
		const store = new MemorySubscriptionDriver();
		const controller = new SubscribeController(store);
		let status = 0;
		await controller.handle({
			request: {
				body: () => ({
					endpoint: ENDPOINT,
					expirationTime: null,
					keys: { p256dh: offCurve(), auth: realAuth() },
				}),
			},
			response: {
				status(code: number) {
					status = code;
					return { json: () => {} };
				},
			},
			auth: { user: { id: "u1" } },
		});
		expect(status).toBe(400);
		expect(await store.listByUser("u1")).toEqual([]);
	});
});
