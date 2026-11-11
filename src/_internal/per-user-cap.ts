/**
 * How many subscriptions one user may hold.
 *
 * Every subscription is a request the server sends, toward a URL the browser
 * chose, on each notification for that user. A user has a handful of devices;
 * an account posting thousands of endpoints turns one notification into
 * thousands of TLS handshakes and encryptions. The bound lives in each store's
 * `save`, where the rows are, so it holds whoever calls it and however many
 * subscribes arrive at once.
 */

export const DEFAULT_MAX_SUBSCRIPTIONS_PER_USER = 20;

/** The cap a save runs under: the caller's, checked, or the default. */
export function perUserCap(maxPerUser: number | undefined): number {
	const max = maxPerUser ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_USER;
	if (!Number.isSafeInteger(max) || max < 1) {
		throw new TypeError(
			`[nova] invalid \`maxPerUser\`: expected a positive integer, got ${String(max)}`,
		);
	}
	return max;
}

/**
 * The endpoints to evict so `held` fits under `max`, given oldest first.
 *
 * Always the oldest: the order is a total one every caller agrees on, so two
 * subscribes trimming the same user at once evict the same rows instead of
 * each other's, and the user ends at the cap rather than under it.
 */
export function overCap(held: readonly string[], max: number): string[] {
	return held.length > max ? held.slice(0, held.length - max) : [];
}
