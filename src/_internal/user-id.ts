/**
 * A user id as the stores key it: text. Numbers and bigints are what an
 * auto-increment primary key arrives as; anything else — an empty string, NaN,
 * a fraction, an object — is not an id, and `String()` would make one up.
 */
export function normaliseUserId(id: unknown): string | undefined {
	if (typeof id === "string") return id.length > 0 ? id : undefined;
	if (typeof id === "number") {
		return Number.isSafeInteger(id) ? String(id) : undefined;
	}
	if (typeof id === "bigint") return String(id);
	return undefined;
}
