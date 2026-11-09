/**
 * A subscription shaped like a browser's.
 *
 * The keys have to be real base64url of the real lengths — an uncompressed
 * P-256 point and a 16-byte secret — because every store applies the same rules
 * to what it writes as the subscribe endpoint applies to what arrives. A
 * fixture the stores would refuse proves nothing about the stores.
 */
import { createECDH, randomBytes } from "node:crypto";
import type { PushSubscription } from "../../src/index.js";

const ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** A deterministic base64url string of exactly `length` characters. */
export function keyOfLength(seed: string, length: number): string {
	let out = "";
	for (let index = 0; index < length; index++) {
		out += ALPHABET[(seed.charCodeAt(index % seed.length) + index) % 64];
	}
	return out;
}

/** A fresh uncompressed P-256 point, base64url — what a browser sends. */
export function realP256dh(): string {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return ecdh.getPublicKey().toString("base64url");
}

/** A fresh 16-byte auth secret, base64url. */
export function realAuth(): string {
	return randomBytes(16).toString("base64url");
}

/** One key pair per endpoint, so two fixtures for the same endpoint agree. */
const keysByEndpoint = new Map<string, { p256dh: string; auth: string }>();

export function subscription(
	endpoint: string,
	expirationTime: number | null = null,
): PushSubscription {
	let keys = keysByEndpoint.get(endpoint);
	if (keys === undefined) {
		keys = { p256dh: realP256dh(), auth: realAuth() };
		keysByEndpoint.set(endpoint, keys);
	}
	return { endpoint, expirationTime, keys: { ...keys } };
}
