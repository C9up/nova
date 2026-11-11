/**
 * What makes a push subscription usable, in one place.
 *
 * These rules were written for the HTTP boundary, where a browser posts a
 * `PushSubscription`. They belong just as much to a store reading its own file
 * back: a record that reaches the push layer with a truncated `p256dh` fails
 * there, in a message naming neither the file nor the endpoint. Checking the
 * same things on the way in and on the way out means a corrupted record is
 * refused where it can still be pointed at.
 */

import { createPublicKey } from "node:crypto";

/**
 * The `endpoint VARCHAR(768)` storage column (InnoDB primary-key index budget)
 * — an over-long endpoint is refused at the boundary rather than failing deep
 * with a dialect-specific length error on insert. Real endpoints (FCM, Mozilla
 * autopush, Apple) are all under 200 characters.
 */
export const MAX_ENDPOINT_LENGTH = 768;

const BASE64URL_CHARS = /^[A-Za-z0-9_-]+$/;
/** RFC 8291 §3.1: the uncompressed P-256 point, 0x04 || X || Y. */
const P256DH_BYTES = 65;
/** RFC 8291 §3.2: the auth secret. */
const AUTH_BYTES = 16;

/** A subscription flattened to its four values, however it was stored. */
export interface SubscriptionFields {
	endpoint: string;
	expirationTime: number | null;
	p256dh: string;
	auth: string;
}

/** The same four, before anything is known about them. */
export interface UncheckedSubscriptionFields {
	endpoint: unknown;
	expirationTime: unknown;
	p256dh: unknown;
	auth: unknown;
}

/** The bytes a base64url key decodes to, or a reason it does not. */
function decodeKey(
	value: unknown,
	name: string,
	bytes: number,
): Buffer | string {
	if (typeof value !== "string" || value.length === 0) {
		return `the \`${name}\` key is not a string`;
	}
	if (!BASE64URL_CHARS.test(value)) {
		return `the \`${name}\` key is not base64url`;
	}
	const decoded = Buffer.from(value, "base64url");
	if (decoded.length !== bytes) {
		return `the \`${name}\` key decodes to ${decoded.length} bytes, not the ${bytes} a valid one has`;
	}
	// Re-encoding catches what the lenient decoder drops: stray trailing bits.
	if (decoded.toString("base64url") !== value) {
		return `the \`${name}\` key is not canonical base64url`;
	}
	return decoded;
}

function p256dhProblem(value: unknown): string | null {
	const point = decodeKey(value, "p256dh", P256DH_BYTES);
	if (typeof point === "string") return point;
	if (point[0] !== 0x04) {
		return "the `p256dh` key is not an uncompressed point";
	}
	// The payload is encrypted against this point; one off the curve fails
	// every push, and would sit in the store failing forever.
	try {
		createPublicKey({
			key: {
				kty: "EC",
				crv: "P-256",
				x: point.subarray(1, 33).toString("base64url"),
				y: point.subarray(33).toString("base64url"),
			},
			format: "jwk",
		});
	} catch {
		return "the `p256dh` key is not a point on P-256";
	}
	return null;
}

function authProblem(value: unknown): string | null {
	const secret = decodeKey(value, "auth", AUTH_BYTES);
	return typeof secret === "string" ? secret : null;
}

/** What makes the encryption keys unusable, or null when nothing does. */
export function keysProblem(p256dh: unknown, auth: unknown): string | null {
	return p256dhProblem(p256dh) ?? authProblem(auth);
}

/** What is wrong with a subscription, or null when nothing is. */
export function subscriptionProblem(
	fields: UncheckedSubscriptionFields,
): string | null {
	const { endpoint, expirationTime, p256dh, auth } = fields;
	if (typeof endpoint !== "string" || endpoint.length === 0) {
		return "the endpoint is not a string";
	}
	if (!/^https:\/\//i.test(endpoint)) {
		return "the endpoint is not an https URL";
	}
	if (endpoint.length > MAX_ENDPOINT_LENGTH) {
		return `the endpoint is ${endpoint.length} characters, over the ${MAX_ENDPOINT_LENGTH} a stored one may be`;
	}
	// `null` is what a subscription that does not expire carries, which is most
	// of them — so the check is null-or-number, never truthiness. A number is
	// an epoch in milliseconds, always whole in a browser, and the SQL column is
	// a BIGINT: a fraction or a value past the safe integers would fail the
	// insert as a 500, or come back from the other stores as something else.
	if (expirationTime !== null) {
		if (
			typeof expirationTime !== "number" ||
			!Number.isSafeInteger(expirationTime) ||
			expirationTime < 0
		) {
			return "the `expirationTime` is neither null nor a non-negative integer of milliseconds";
		}
	}
	return keysProblem(p256dh, auth);
}

/** The same check, as a predicate, for callers that go on to use the values. */
export function isSubscriptionFields(
	fields: UncheckedSubscriptionFields,
): fields is SubscriptionFields {
	return subscriptionProblem(fields) === null;
}
