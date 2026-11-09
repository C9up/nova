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

export interface PushSubscription {
	endpoint: string;
	expirationTime: number | null;
	keys: { p256dh: string; auth: string };
}

export interface SubscriptionStore {
	save(userId: string, subscription: PushSubscription): Promise<void>;
	listByUser(userId: string): Promise<PushSubscription[]>;
	delete(endpoint: string): Promise<void>;
}

export class MemorySubscriptionDriver implements SubscriptionStore {
	#byUser = new Map<string, Map<string, PushSubscription>>();

	async save(userId: string, subscription: PushSubscription): Promise<void> {
		// Push endpoints are globally unique per push service (FCM, Mozilla
		// AutoPush, WNS). Without this de-dup step, a browser subscription
		// reused across a logout/login pair (the most common shared-device
		// scenario) would remain attached to BOTH users — `listByUser`
		// would return stale entries on the old account, and notifications
		// would fan out to whoever logged in last. Reuse the existing
		// `delete(endpoint)` sweep so the rule lives in one place.
		assertMayTakeOver(
			subscription.endpoint,
			userId,
			this.#ownerOf(subscription.endpoint),
			subscription.keys,
		);
		await this.delete(subscription.endpoint);

		let bucket = this.#byUser.get(userId);
		if (!bucket) {
			bucket = new Map();
			this.#byUser.set(userId, bucket);
		}
		bucket.set(subscription.endpoint, subscription);
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
		const emptied: string[] = [];
		for (const [userId, bucket] of this.#byUser) {
			if (bucket.delete(endpoint) && bucket.size === 0) {
				emptied.push(userId);
			}
		}
		for (const userId of emptied) this.#byUser.delete(userId);
	}
}
