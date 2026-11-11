/**
 * Redis-backed subscription storage.
 *
 * The other durable option: a push subscription is a small record read by user
 * id and deleted by endpoint, which is exactly what a key and a set do. An
 * application already running Redis for its cache or its queue can keep
 * subscriptions there instead of adding a table.
 *
 * No import of a Redis package. The client is taken structurally — `get` and
 * `eval`, in the shape ioredis gives them, which a `@c9up/quasar` connection
 * merges in — the same contract `@c9up/bay` and `@c9up/eclipse` take.
 *
 *   // config/nova.ts
 *   import redis from '@c9up/quasar/services/main'
 *   import { defineConfig, RedisSubscriptionStore } from '@c9up/nova'
 *
 *   export default defineConfig({
 *     store: new RedisSubscriptionStore(redis.connection()),
 *   })
 *
 * Several processes share one Redis, so no check may run in one process and
 * the write it guards in another command: two processes would both read a
 * user under the cap and both add, or an old owner would delete an endpoint
 * another process moved to someone else in between. Every write is a script
 * on ONE key, which the server runs whole, and which a Redis Cluster serves
 * from the node holding that key:
 *
 * - `<prefix>:sub:<endpoint>`, the record (JSON, with its owner), is only
 *   replaced or deleted if it still holds what was read: the owner and key
 *   checks run on what is actually stored.
 * - `<prefix>:user:<userId>`, the user's endpoints, is a sorted set scored by
 *   when each was saved. Adding one and evicting the oldest past the cap is
 *   one script, so the cap holds whoever adds at once.
 *
 * The record keys are the ones earlier versions wrote. The user key was a
 * plain set; the first script that touches one converts it in place, its
 * members scored 0, the oldest.
 *
 * Durability is the server's, not this class's: a Redis with no persistence
 * loses every subscription on restart, which is the failure the in-memory
 * driver has. Browsers re-subscribe on their next visit, so the cost is a
 * missed notification rather than a broken account — but if that matters, use
 * a persistent Redis or {@link SqlSubscriptionStore}.
 */

import { assertMayTakeOver } from "./_internal/ownership.js";
import { perUserCap } from "./_internal/per-user-cap.js";
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

/** Minimal Redis client — compatible with ioredis and quasar. */
export interface SubscriptionRedisClient {
	get(key: string): Promise<string | null>;
	/** `EVAL script numKeys key... arg...` — every write is one. */
	eval(
		script: string,
		numKeys: number,
		...args: Array<string | number>
	): Promise<unknown>;
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
	 * When it was stored, in ms: the score of the endpoint in its owner's
	 * set. Records written before it existed read as 0, the oldest.
	 */
	createdAt: number;
}

/**
 * Replace or delete a record only if it still holds what was read.
 * ARGV: `1` and the value read, or `0` when it was absent; then `set` and
 * the new value, or `del`.
 */
const SWAP_RECORD = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '1' then
  if current ~= ARGV[2] then return 0 end
elseif current then
  return 0
end
if ARGV[3] == 'del' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], ARGV[4])
end
return 1
`;

/** A user's set as a sorted set, converted in place from a plain one. */
const USER_INDEX = `
local function index(key)
  if redis.call('TYPE', key).ok == 'set' then
    local members = redis.call('SMEMBERS', key)
    redis.call('DEL', key)
    for _, member in ipairs(members) do
      redis.call('ZADD', key, 0, member)
    end
  end
end
index(KEYS[1])
`;

/**
 * Add an endpoint (ARGV[1]) saved at ARGV[2], and evict the oldest past the
 * cap (ARGV[3]); answers the evicted endpoints and their scores. Equal scores
 * order by endpoint, so the order is total.
 */
const ADD_TO_USER = `${USER_INDEX}
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
local over = redis.call('ZCARD', KEYS[1]) - tonumber(ARGV[3])
if over <= 0 then return {} end
local evicted = redis.call('ZRANGE', KEYS[1], 0, over - 1, 'WITHSCORES')
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, over - 1)
return evicted
`;

/** The user's endpoints and their scores, oldest first. */
const USER_MEMBERS = `${USER_INDEX}
return redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
`;

/**
 * Remove endpoints from a user's set, each given with the score it was read
 * at, or an empty score for any. A member saved again since has a new score
 * and stays; one converted from a plain set, scored 0, goes. Answers how many
 * went.
 */
const REMOVE_FROM_USER = `${USER_INDEX}
local removed = 0
for i = 1, #ARGV, 2 do
  local score = redis.call('ZSCORE', KEYS[1], ARGV[i])
  if score and (ARGV[i + 1] == '' or tonumber(score) == 0
      or tonumber(score) == tonumber(ARGV[i + 1])) then
    removed = removed + redis.call('ZREM', KEYS[1], ARGV[i])
  end
end
return removed
`;

/**
 * How many times a write reads a record again after another process changed
 * it between the read and the write. Each retry means another write landed
 * on the same endpoint, so running out means a flood on one endpoint.
 */
const ATTEMPTS = 16;

/** An endpoint in a user's set, with the score it was found at. */
type Member = readonly [endpoint: string, score: number | undefined];

export class RedisSubscriptionStore implements SubscriptionStore {
	readonly #source: SubscriptionRedisResolver;
	#resolved: SubscriptionRedisClient | undefined;
	readonly #prefix: string;

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

	/** The sorted set of endpoints one user has registered. */
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
		// readRecord can only ever be triggered by a hand-written key — never by
		// this store writing a record it will later refuse to read, which would
		// drop the subscription silently on the next listing.
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

		const redis = await this.#redis();
		const { endpoint } = subscription;
		const key = this.#subscriptionKey(endpoint);
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			const raw = await redis.get(key);
			const previous = raw === null ? undefined : parseRecord(endpoint, raw);
			// On what is stored now: the swap below writes only if it still is.
			assertMayTakeOver(
				endpoint,
				userId,
				previous && {
					userId: previous.userId,
					keys: { p256dh: previous.p256dh, auth: previous.auth },
				},
				subscription.keys,
			);
			const stored: StoredSubscription = {
				userId,
				expirationTime: subscription.expirationTime,
				p256dh: subscription.keys.p256dh,
				auth: subscription.keys.auth,
				createdAt: nextStamp(),
			};
			if (!(await this.#swap(redis, key, raw, JSON.stringify(stored)))) {
				continue;
			}

			if (previous && previous.userId !== userId) {
				await this.#removeFromUser(redis, previous.userId, [
					[endpoint, previous.createdAt],
				]);
			}
			const evicted = await this.#addToUser(
				redis,
				userId,
				endpoint,
				stored.createdAt,
				max,
			);
			for (const [gone, score] of evicted) {
				await this.#dropOwned(redis, userId, gone, score);
			}
			return;
		}
		throw busy();
	}

	/**
	 * Every subscription `userId` has registered, oldest first.
	 *
	 * A member whose record is gone or now someone else's is dropped from the
	 * set on the way past: the record and the set are written one after the
	 * other, so a process that died between them leaves a dangling member,
	 * and nothing else would ever clean it up.
	 */
	async listByUser(userId: string): Promise<PushSubscription[]> {
		const redis = await this.#redis();
		const members = pairs(
			await redis.eval(USER_MEMBERS, 1, this.#userKey(userId)),
		);
		const found: Array<PushSubscription & { createdAt: number }> = [];
		const dangling: Member[] = [];

		for (const [endpoint, score] of members) {
			const raw = await redis.get(this.#subscriptionKey(endpoint));
			const stored = raw === null ? undefined : parseRecord(endpoint, raw);
			if (!stored || stored.userId !== userId) {
				dangling.push([endpoint, score]);
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
			await this.#removeFromUser(redis, userId, dangling);
		}
		found.sort(oldestFirst);
		return found.map(({ endpoint, expirationTime, keys }) => ({
			endpoint,
			expirationTime,
			keys,
		}));
	}

	/** Forget one subscription, whoever owns it. */
	async delete(endpoint: string): Promise<void> {
		const redis = await this.#redis();
		const key = this.#subscriptionKey(endpoint);
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			const raw = await redis.get(key);
			if (raw === null) return;
			if (!(await this.#swap(redis, key, raw, null))) continue;
			const stored = parseRecord(endpoint, raw);
			if (stored) {
				await this.#removeFromUser(redis, stored.userId, [
					[endpoint, stored.createdAt],
				]);
			}
			return;
		}
		throw busy();
	}

	/**
	 * Forget `endpoint` if `userId` holds it.
	 *
	 * The user's own set is emptied first, so from that command on no push
	 * for this user goes to the endpoint. The record goes only if it is still
	 * this user's when it is deleted: an endpoint another process moved to
	 * someone else in between stays theirs.
	 */
	async deleteForUser(userId: string, endpoint: string): Promise<boolean> {
		const redis = await this.#redis();
		const listed = await this.#removeFromUser(redis, userId, [
			[endpoint, undefined],
		]);
		const dropped = await this.#dropOwned(redis, userId, endpoint, undefined);
		return listed > 0 || dropped;
	}

	/**
	 * Delete the record of `endpoint` if `userId` owns it and, when `score` is
	 * a stamp, it is the save that stamp was given to.
	 */
	async #dropOwned(
		redis: SubscriptionRedisClient,
		userId: string,
		endpoint: string,
		score: number | undefined,
	): Promise<boolean> {
		const key = this.#subscriptionKey(endpoint);
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			const raw = await redis.get(key);
			const stored = raw === null ? undefined : parseRecord(endpoint, raw);
			if (raw === null || !stored || stored.userId !== userId) return false;
			if (score !== undefined && score !== 0 && stored.createdAt !== score) {
				return false;
			}
			if (await this.#swap(redis, key, raw, null)) return true;
		}
		throw busy();
	}

	/** Write `next` (or delete, for null) if the record still holds `read`. */
	async #swap(
		redis: SubscriptionRedisClient,
		key: string,
		read: string | null,
		next: string | null,
	): Promise<boolean> {
		const swapped = await redis.eval(
			SWAP_RECORD,
			1,
			key,
			read === null ? "0" : "1",
			read ?? "",
			next === null ? "del" : "set",
			next ?? "",
		);
		return Number(swapped) === 1;
	}

	async #addToUser(
		redis: SubscriptionRedisClient,
		userId: string,
		endpoint: string,
		stamp: number,
		max: number,
	): Promise<Member[]> {
		return pairs(
			await redis.eval(
				ADD_TO_USER,
				1,
				this.#userKey(userId),
				endpoint,
				String(stamp),
				String(max),
			),
		);
	}

	async #removeFromUser(
		redis: SubscriptionRedisClient,
		userId: string,
		members: readonly Member[],
	): Promise<number> {
		const args = members.flatMap(([endpoint, score]) => [
			endpoint,
			score === undefined ? "" : String(score),
		]);
		return Number(
			await redis.eval(REMOVE_FROM_USER, 1, this.#userKey(userId), ...args),
		);
	}
}

/** A `ZRANGE ... WITHSCORES` reply as endpoint and score pairs. */
function pairs(reply: unknown): Member[] {
	if (!Array.isArray(reply)) return [];
	const members: Member[] = [];
	for (let i = 0; i + 1 < reply.length; i += 2) {
		const endpoint: unknown = reply[i];
		const score = Number(reply[i + 1]);
		if (typeof endpoint === "string" && Number.isFinite(score)) {
			members.push([endpoint, score]);
		}
	}
	return members;
}

function busy(): NovaError {
	return new NovaError(
		"E_NOVA_STORE_BUSY",
		`A subscription changed under every one of ${ATTEMPTS} attempts to write it.`,
		{
			hint: "Something rewrites this endpoint's record continuously; retry later.",
		},
	);
}

/**
 * Read a stored record, treating an unusable one as absent.
 *
 * Throwing here would make one corrupted key break `listByUser` for the
 * whole account; absent means the endpoint is pruned from the set instead,
 * and the browser re-subscribes on its next visit.
 */
function parseRecord(
	endpoint: string,
	raw: string,
): StoredSubscription | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	return readRecord(endpoint, parsed);
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
