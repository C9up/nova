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

/**
 * The id `pushToUser` looks up, or the TypeError it throws — one function, so
 * `FakeNova` fails on exactly the ids `Nova` fails on, with the same message.
 * A fake that recorded `"undefined"` would hide the unloaded relation the real
 * method was written to catch.
 */
export function pushToUserKey(userId: unknown): string {
	const key = normaliseUserId(userId);
	if (key === undefined) {
		throw new TypeError(
			`[nova] pushToUser: ${String(userId)} is not a user id (a non-empty string or an integer)`,
		);
	}
	return key;
}
