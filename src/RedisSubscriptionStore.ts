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

import { assertMayTakeOver } from "./_internal/ownership.js";
import { overCap, perUserCap } from "./_internal/per-user-cap.js";
import {
	isSubscriptionFields,
	subscriptionProblem,
} from "./_internal/subscription.js";
import { NovaError } from "./errors.js";
import type {
	PushSubscription,
	SaveSubscriptionOptions,
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

/**
 * The client itself, or something that answers with one. A config file is
 * loaded before the application boots, so the connection does not exist yet
 * there — a function defers the lookup to the first push.
 */
export type SubscriptionRedisResolver =
	| SubscriptionRedisClient
	| (() => SubscriptionRedisClient | Promise<SubscriptionRedisClient>);

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
	/**
	 * When it was stored, in ms. A set has no order, and `listByUser` answers
	 * oldest first like the other stores. Records written before it existed
	 * read as 0, the oldest.
	 */
	createdAt: number;
}

export class RedisSubscriptionStore implements SubscriptionStore {
	readonly #source: SubscriptionRedisResolver;
	#resolved: SubscriptionRedisClient | undefined;
	readonly #prefix: string;
	/**
	 * Serialises this instance's writes. The contract is six plain commands —
	 * what every client and a Redis Cluster serve — so a write is several round
	 * trips, and two subscribes interleaving between them would each read a
	 * state the other is changing. Queued, they run one after the other.
	 */
	#queue: Promise<unknown> = Promise.resolve();

	constructor(
		redis: SubscriptionRedisResolver,
		options: RedisSubscriptionStoreOptions = {},
	) {
		const prefix = options.prefix ?? "nova:push";
		if (prefix.includes(" ")) {
			throw new NovaError(
				"E_NOVA_INVALID_PREFIX",
				`Invalid key prefix "${prefix}" — a Redis key cannot contain a space.`,
			);
		}
		this.#source = redis;
		this.#prefix = prefix;
	}

	/** The client, resolved once and kept. */
	async #redis(): Promise<SubscriptionRedisClient> {
		if (this.#resolved) return this.#resolved;
		this.#resolved =
			typeof this.#source === "function" ? await this.#source() : this.#source;
		return this.#resolved;
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
	async save(
		userId: string,
		subscription: PushSubscription,
		options: SaveSubscriptionOptions = {},
	): Promise<void> {
		const max = perUserCap(options.maxPerUser);
		// Checked on the way in as well as on the way out, so the strictness of
		// #read can only ever be triggered by a hand-written key — never by this
		// store writing a record it will later refuse to read, which would drop
		// the subscription silently on the next listing.
		const problem = subscriptionProblem({
			endpoint: subscription.endpoint,
			expirationTime: subscription.expirationTime,
			p256dh: subscription.keys.p256dh,
			auth: subscription.keys.auth,
		});
		if (problem !== null) {
			throw new NovaError(
				"E_NOVA_INVALID_SUBSCRIPTION",
				`This subscription cannot be stored: ${problem}.`,
				{
					hint: "Subscriptions arriving through the subscribe endpoint are already checked; a hand-built one has to hold the same values a browser sends.",
				},
			);
		}

		await this.#serial(() => this.#write(userId, subscription, max));
	}

	async #write(
		userId: string,
		subscription: PushSubscription,
		max: number,
	): Promise<void> {
		const previous = await this.#read(subscription.endpoint);
		assertMayTakeOver(
			subscription.endpoint,
			userId,
			previous && {
				userId: previous.userId,
				keys: { p256dh: previous.p256dh, auth: previous.auth },
			},
			subscription.keys,
		);
		if (previous && previous.userId !== userId) {
			await (await this.#redis()).srem(
				this.#userKey(previous.userId),
				subscription.endpoint,
			);
		}

		const key = this.#subscriptionKey(subscription.endpoint);
		const stored: StoredSubscription = {
			userId,
			expirationTime: subscription.expirationTime,
			p256dh: subscription.keys.p256dh,
			auth: subscription.keys.auth,
			createdAt: nextStamp(),
		};
		await (await this.#redis()).set(key, JSON.stringify(stored));
		await (await this.#redis()).sadd(
			this.#userKey(userId),
			subscription.endpoint,
		);

		const held = (await this.#held(userId))
			.sort(oldestFirst)
			.map(({ endpoint }) => endpoint);
		const evicted = overCap(held, max);
		if (evicted.length > 0) {
			await (await this.#redis()).srem(this.#userKey(userId), ...evicted);
			await (await this.#redis()).del(
				evicted.map((endpoint) => this.#subscriptionKey(endpoint)),
			);
		}
	}

	/** Run one write after the ones already queued, failures included. */
	async #serial<T>(write: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(write);
		// The queue must keep flowing when one write fails, or every later one
		// would inherit that rejection.
		this.#queue = run.catch(() => undefined);
		return run;
	}

	/**
	 * Every subscription `userId` has registered, oldest first.
	 *
	 * A member whose record is gone is dropped from the set on the way past:
	 * the two keys are written separately, so a process that died between them
	 * leaves a dangling member, and nothing else would ever clean it up.
	 */
	async listByUser(userId: string): Promise<PushSubscription[]> {
		const found = await this.#held(userId);
		found.sort(oldestFirst);
		return found.map(({ endpoint, expirationTime, keys }) => ({
			endpoint,
			expirationTime,
			keys,
		}));
	}

	/** The user's live subscriptions with their stamps, dangling members pruned. */
	async #held(
		userId: string,
	): Promise<Array<PushSubscription & { createdAt: number }>> {
		const endpoints = await (await this.#redis()).smembers(
			this.#userKey(userId),
		);
		const found: Array<PushSubscription & { createdAt: number }> = [];
		const dangling: string[] = [];

		for (const endpoint of endpoints) {
			const stored = await this.#read(endpoint);
			if (!stored || stored.userId !== userId) {
				dangling.push(endpoint);
				continue;
			}
			found.push({
				endpoint,
				expirationTime: stored.expirationTime,
				keys: { p256dh: stored.p256dh, auth: stored.auth },
				createdAt: stored.createdAt,
			});
		}

		if (dangling.length > 0) {
			await (await this.#redis()).srem(this.#userKey(userId), ...dangling);
		}
		return found;
	}

	/** Forget one subscription, whoever owns it. */
	async delete(endpoint: string): Promise<void> {
		await this.#serial(() => this.#forget(endpoint));
	}

	/**
	 * Forget `endpoint` if `userId` holds it.
	 *
	 * Queued with every other write of this instance, so a takeover arriving
	 * through the same process cannot land between the check and the removal.
	 * The user's own set is emptied first: `srem` on it is atomic and cannot
	 * reach another account's set, so from that command on no push for this
	 * user goes to the endpoint, whatever another process does meanwhile.
	 */
	async deleteForUser(userId: string, endpoint: string): Promise<boolean> {
		return this.#serial(async () => {
			const redis = await this.#redis();
			const listed = await redis.srem(this.#userKey(userId), endpoint);
			const stored = await this.#read(endpoint);
			if (stored?.userId !== userId) return listed > 0;
			await redis.del(this.#subscriptionKey(endpoint));
			return true;
		});
	}

	async #forget(endpoint: string): Promise<void> {
		const key = this.#subscriptionKey(endpoint);
		const stored = await this.#read(endpoint);
		if (stored) {
			await (await this.#redis()).srem(this.#userKey(stored.userId), endpoint);
		}
		await (await this.#redis()).del(key);
	}

	/**
	 * Read a stored record, treating an unusable one as absent.
	 *
	 * Throwing here would make one corrupted key break `listByUser` for the
	 * whole account; absent means the endpoint is pruned from the set instead,
	 * and the browser re-subscribes on its next visit.
	 */
	async #read(endpoint: string): Promise<StoredSubscription | undefined> {
		const raw = await (await this.#redis()).get(
			this.#subscriptionKey(endpoint),
		);
		if (raw === null) return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return undefined;
		}
		return readRecord(endpoint, parsed);
	}
}

/**
 * Oldest first by the stamp, then by endpoint for two processes that stamped
 * the same millisecond: a total order, so concurrent trims agree on which
 * subscriptions are the oldest and evict the same ones.
 */
function oldestFirst(
	a: { createdAt: number; endpoint: string },
	b: { createdAt: number; endpoint: string },
): number {
	if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
	if (a.endpoint === b.endpoint) return 0;
	return a.endpoint < b.endpoint ? -1 : 1;
}

let lastStamp = 0;

/**
 * Now, in ms, but never twice the same in this process: two subscribes in
 * one millisecond would otherwise tie, and the order between them is lost.
 */
function nextStamp(): number {
	lastStamp = Math.max(Date.now(), lastStamp + 1);
	return lastStamp;
}

/**
 * One stored record, or undefined when it is not usable.
 *
 * The rules are the ones the subscribe endpoint applies to an arriving
 * subscription, the same way the file store applies them to a record it reads
 * back. Checking only that three fields were strings let a truncated `p256dh`
 * — or a record with no `expirationTime` at all, which the return type says
 * cannot happen — reach the push layer, where it fails as an encryption error
 * naming neither the key nor the endpoint, and nothing ever cleans it up:
 * cleanup runs on a 404/410 from the push service, and that request was never
 * made.
 */
function readRecord(
	endpoint: string,
	value: unknown,
): StoredSubscription | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	if (!("userId" in value) || typeof value.userId !== "string") {
		return undefined;
	}
	const fields = {
		endpoint,
		expirationTime:
			"expirationTime" in value ? value.expirationTime : undefined,
		p256dh: "p256dh" in value ? value.p256dh : undefined,
		auth: "auth" in value ? value.auth : undefined,
	};
	if (!isSubscriptionFields(fields)) return undefined;
	// The guard narrows the fields, so the record is rebuilt from checked values
	// rather than asserted into shape.
	const createdAt =
		"createdAt" in value &&
		typeof value.createdAt === "number" &&
		Number.isFinite(value.createdAt)
			? value.createdAt
			: 0;
	return {
		userId: value.userId,
		expirationTime: fields.expirationTime,
		p256dh: fields.p256dh,
		auth: fields.auth,
		createdAt,
	};
}
