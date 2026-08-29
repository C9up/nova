/**
 * Redis-backed subscription storage.
 *
 * The other durable option: a push subscription is a small record read by user
 * id and deleted by endpoint, which is exactly what a key and a set do. An
 * application already running Redis for its cache or its queue can keep
 * subscriptions there instead of adding a table.
 *
 * No import of a Redis package. The client is taken structurally — the same
 * minimal contract `@c9up/echo` and `@c9up/bay` take, satisfied by ioredis and
 * node-redis alike, and by `@c9up/quasar`'s connection, which merges the
 * ioredis surface in.
 *
 *   // config/nova.ts
 *   import redis from '@c9up/quasar/services/main'
 *   import { defineConfig, RedisSubscriptionStore } from '@c9up/nova'
 *
 *   export default defineConfig({
 *     store: new RedisSubscriptionStore(redis.connection()),
 *   })
 *
 * Durability is the server's, not this class's: a Redis with no persistence
 * loses every subscription on restart, which is the failure the in-memory
 * driver has. Browsers re-subscribe on their next visit, so the cost is a
 * missed notification rather than a broken account — but if that matters, use
 * a persistent Redis or {@link SqlSubscriptionStore}.
 */

import { NovaError } from "./errors.js";
import type {
	PushSubscription,
	SubscriptionStore,
} from "./SubscriptionStore.js";

/** Minimal Redis client — compatible with ioredis, node-redis and quasar. */
export interface SubscriptionRedisClient {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
	del(key: string | string[]): Promise<number>;
	sadd(key: string, ...members: string[]): Promise<number>;
	srem(key: string, ...members: string[]): Promise<number>;
	smembers(key: string): Promise<string[]>;
}

export interface RedisSubscriptionStoreOptions {
	/**
	 * Prefix every key this store owns. Default `"nova:push"`. Change it to run
	 * two applications against one Redis database.
	 */
	prefix?: string;
}

/** What is stored under the endpoint key: the subscription plus its owner. */
interface StoredSubscription {
	userId: string;
	expirationTime: number | null;
	p256dh: string;
	auth: string;
}

export class RedisSubscriptionStore implements SubscriptionStore {
	readonly #redis: SubscriptionRedisClient;
	readonly #prefix: string;

	constructor(
		redis: SubscriptionRedisClient,
		options: RedisSubscriptionStoreOptions = {},
	) {
		const prefix = options.prefix ?? "nova:push";
		if (prefix.includes(" ")) {
			throw new NovaError(
				"E_NOVA_INVALID_PREFIX",
				`Invalid key prefix "${prefix}" — a Redis key cannot contain a space.`,
			);
		}
		this.#redis = redis;
		this.#prefix = prefix;
	}

	/** The subscription itself, keyed by the endpoint that identifies it. */
	#subscriptionKey(endpoint: string): string {
		return `${this.#prefix}:sub:${endpoint}`;
	}

	/** The set of endpoints one user has registered. */
	#userKey(userId: string): string {
		return `${this.#prefix}:user:${userId}`;
	}

	/**
	 * Store a subscription for `userId`.
	 *
	 * The endpoint's previous owner is looked up first and dropped: a push
	 * endpoint is globally unique per push service, so a browser reused across a
	 * logout/login pair would otherwise stay in BOTH users' sets, and the next
	 * notification for the old account would land on the new user's screen.
	 * Same rule as the other two drivers.
	 */
	async save(userId: string, subscription: PushSubscription): Promise<void> {
		const key = this.#subscriptionKey(subscription.endpoint);
		const previous = await this.#read(key);
		if (previous && previous.userId !== userId) {
			await this.#redis.srem(
				this.#userKey(previous.userId),
				subscription.endpoint,
			);
		}

		const stored: StoredSubscription = {
			userId,
			expirationTime: subscription.expirationTime,
			p256dh: subscription.keys.p256dh,
			auth: subscription.keys.auth,
		};
		await this.#redis.set(key, JSON.stringify(stored));
		await this.#redis.sadd(this.#userKey(userId), subscription.endpoint);
	}

	/**
	 * Every subscription `userId` has registered.
	 *
	 * A member whose record is gone is dropped from the set on the way past:
	 * the two keys are written separately, so a process that died between them
	 * leaves a dangling member, and nothing else would ever clean it up.
	 */
	async listByUser(userId: string): Promise<PushSubscription[]> {
		const endpoints = await this.#redis.smembers(this.#userKey(userId));
		const found: PushSubscription[] = [];
		const dangling: string[] = [];

		for (const endpoint of endpoints) {
			const stored = await this.#read(this.#subscriptionKey(endpoint));
			if (!stored || stored.userId !== userId) {
				dangling.push(endpoint);
				continue;
			}
			found.push({
				endpoint,
				expirationTime: stored.expirationTime,
				keys: { p256dh: stored.p256dh, auth: stored.auth },
			});
		}

		if (dangling.length > 0) {
			await this.#redis.srem(this.#userKey(userId), ...dangling);
		}
		return found;
	}

	/** Forget one subscription, whoever owns it. */
	async delete(endpoint: string): Promise<void> {
		const key = this.#subscriptionKey(endpoint);
		const stored = await this.#read(key);
		if (stored) {
			await this.#redis.srem(this.#userKey(stored.userId), endpoint);
		}
		await this.#redis.del(key);
	}

	/**
	 * Read a stored record, treating unreadable JSON as absent.
	 *
	 * Throwing here would make one corrupted key break `listByUser` for the
	 * whole account; absent means the endpoint is pruned from the set instead,
	 * and the browser re-subscribes on its next visit.
	 */
	async #read(key: string): Promise<StoredSubscription | undefined> {
		const raw = await this.#redis.get(key);
		if (raw === null) return undefined;
		try {
			const parsed: unknown = JSON.parse(raw);
			return isStored(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
}

function isStored(value: unknown): value is StoredSubscription {
	if (typeof value !== "object" || value === null) return false;
	return (
		"userId" in value &&
		typeof value.userId === "string" &&
		"p256dh" in value &&
		typeof value.p256dh === "string" &&
		"auth" in value &&
		typeof value.auth === "string"
	);
}
