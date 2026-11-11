/**
 * Subscription persistence — interface + in-memory driver.
 *
 * The interface is consumed structurally by 48-3's `AtlasSubscriptionDriver`
 * (no cross-package import — Atlas implements the same shape).
 * `MemorySubscriptionDriver` ships in 48-1 so the integration tests + any
 * dev environment without a database can register subscribers immediately.
 *
 * Endpoint URLs are globally unique per push service (FCM, Mozilla AutoPush,
 * WNS), so `delete(endpoint)` removes the subscription regardless of which
 * user owns it; `save()` is upsert-by-endpoint within the user's bucket.
 */

import { assertMayTakeOver } from "./_internal/ownership.js";
import { overCap, perUserCap } from "./_internal/per-user-cap.js";

export interface PushSubscription {
	endpoint: string;
	expirationTime: number | null;
	keys: { p256dh: string; auth: string };
}

export interface SaveSubscriptionOptions {
	/**
	 * Subscriptions this user may hold once the save is done. Default 20. The
	 * oldest are evicted past it, as part of the same save: a store that
	 * accepted the (cap+1)th row and left the trimming to its caller would be
	 * unbounded for every other caller, and racy for this one.
	 */
	maxPerUser?: number;
}

export interface SubscriptionStore {
	/**
	 * Store `subscription` for `userId`, then evict that user's oldest
	 * subscriptions past `options.maxPerUser` (default 20).
	 */
	save(
		userId: string,
		subscription: PushSubscription,
		options?: SaveSubscriptionOptions,
	): Promise<void>;
	listByUser(userId: string): Promise<PushSubscription[]>;
	delete(endpoint: string): Promise<void>;
}

export class MemorySubscriptionDriver implements SubscriptionStore {
	#byUser = new Map<string, Map<string, PushSubscription>>();

	/**
	 * Synchronous from the ownership check to the trim: nothing awaits in
	 * between, so concurrent saves cannot interleave inside one.
	 */
	async save(
		userId: string,
		subscription: PushSubscription,
		options: SaveSubscriptionOptions = {},
	): Promise<void> {
		const max = perUserCap(options.maxPerUser);
		// Push endpoints are globally unique per push service (FCM, Mozilla
		// AutoPush, WNS). Without this de-dup step, a browser subscription
		// reused across a logout/login pair (the most common shared-device
		// scenario) would remain attached to BOTH users — `listByUser`
		// would return stale entries on the old account, and notifications
		// would fan out to whoever logged in last. Reuse the
		// `delete(endpoint)` sweep so the rule lives in one place.
		assertMayTakeOver(
			subscription.endpoint,
			userId,
			this.#ownerOf(subscription.endpoint),
			subscription.keys,
		);
		this.#remove(subscription.endpoint);

		let bucket = this.#byUser.get(userId);
		if (!bucket) {
			bucket = new Map();
			this.#byUser.set(userId, bucket);
		}
		// Removed above, so the endpoint lands last: insertion order is age.
		bucket.set(subscription.endpoint, subscription);
		for (const endpoint of overCap([...bucket.keys()], max)) {
			bucket.delete(endpoint);
		}
	}

	#ownerOf(
		endpoint: string,
	): { userId: string; keys: PushSubscription["keys"] } | undefined {
		for (const [userId, bucket] of this.#byUser) {
			const stored = bucket.get(endpoint);
			if (stored) return { userId, keys: stored.keys };
		}
		return undefined;
	}

	async listByUser(userId: string): Promise<PushSubscription[]> {
		const bucket = this.#byUser.get(userId);
		if (!bucket) return [];
		return Array.from(bucket.values());
	}

	async delete(endpoint: string): Promise<void> {
		this.#remove(endpoint);
	}

	#remove(endpoint: string): void {
		const emptied: string[] = [];
		for (const [userId, bucket] of this.#byUser) {
			if (bucket.delete(endpoint) && bucket.size === 0) {
				emptied.push(userId);
			}
		}
		for (const userId of emptied) this.#byUser.delete(userId);
	}
}
