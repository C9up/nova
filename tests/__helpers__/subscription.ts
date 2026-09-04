/**
 * A subscription shaped like a browser's.
 *
 * The keys have to be real base64url of the real lengths — an uncompressed
 * P-256 point and a 16-byte secret — because every store applies the same rules
 * to what it writes as the subscribe endpoint applies to what arrives. A
 * fixture the stores would refuse proves nothing about the stores.
 */
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

export function subscription(
	endpoint: string,
	expirationTime: number | null = null,
): PushSubscription {
	return {
		endpoint,
		expirationTime,
		keys: {
			p256dh: keyOfLength(`p256dh-${endpoint}`, 87),
			auth: keyOfLength(`auth-${endpoint}`, 22),
		},
	};
}
