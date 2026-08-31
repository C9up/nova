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

/**
 * The `endpoint VARCHAR(768)` storage column (InnoDB primary-key index budget)
 * — an over-long endpoint is refused at the boundary rather than failing deep
 * with a dialect-specific length error on insert. Real endpoints (FCM, Mozilla
 * autopush, Apple) are all under 200 characters.
 */
export const MAX_ENDPOINT_LENGTH = 768;

const BASE64URL_CHARS = /^[A-Za-z0-9_-]+$/;
/** An uncompressed P-256 point, base64url: 65 bytes. */
const P256DH_LENGTH_RANGE: readonly [number, number] = [86, 90];
/** The auth secret, base64url: 16 bytes. */
const AUTH_LENGTH_RANGE: readonly [number, number] = [22, 26];

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

function base64UrlProblem(
	value: unknown,
	name: string,
	[min, max]: readonly [number, number],
): string | null {
	if (typeof value !== "string" || value.length === 0) {
		return `the \`${name}\` key is not a string`;
	}
	if (value.length < min || value.length > max) {
		return `the \`${name}\` key is ${value.length} characters, outside the ${min}–${max} a valid one has`;
	}
	if (!BASE64URL_CHARS.test(value)) {
		return `the \`${name}\` key is not base64url`;
	}
	return null;
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
	// of them — so the check is null-or-number, never truthiness.
	if (expirationTime !== null) {
		if (
			typeof expirationTime !== "number" ||
			!Number.isFinite(expirationTime) ||
			expirationTime < 0
		) {
			return "the `expirationTime` is neither null nor a finite, non-negative number";
		}
	}
	return (
		base64UrlProblem(p256dh, "p256dh", P256DH_LENGTH_RANGE) ??
		base64UrlProblem(auth, "auth", AUTH_LENGTH_RANGE)
	);
}

/** The same check, as a predicate, for callers that go on to use the values. */
export function isSubscriptionFields(
	fields: UncheckedSubscriptionFields,
): fields is SubscriptionFields {
	return subscriptionProblem(fields) === null;
}
