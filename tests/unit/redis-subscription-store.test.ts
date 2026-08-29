import { beforeEach, describe, expect, it } from "vitest";
import {
	NovaError,
	type PushSubscription,
	RedisSubscriptionStore,
	type SubscriptionRedisClient,
} from "../../src/index.js";

/**
 * The Redis store, against an in-process Redis that behaves like one.
 *
 * The fake implements the six commands the contract asks for with real Redis
 * semantics — a set is a set, `get` on a missing key is `null`, `srem` takes
 * several members — so what these exercise is the store's own logic: who owns
 * an endpoint, what happens to the previous owner, and what a half-written
 * record does to a listing.
 */
class FakeRedis implements SubscriptionRedisClient {
	readonly strings = new Map<string, string>();
	readonly sets = new Map<string, Set<string>>();

	async get(key: string): Promise<string | null> {
		return this.strings.get(key) ?? null;
	}

	async set(key: string, value: string): Promise<unknown> {
		this.strings.set(key, value);
		return "OK";
	}

	async del(key: string | string[]): Promise<number> {
		const keys = Array.isArray(key) ? key : [key];
		let removed = 0;
		for (const one of keys) if (this.strings.delete(one)) removed += 1;
		return removed;
	}

	async sadd(key: string, ...members: string[]): Promise<number> {
		const set = this.sets.get(key) ?? new Set<string>();
		this.sets.set(key, set);
		let added = 0;
		for (const member of members) {
			if (!set.has(member)) {
				set.add(member);
				added += 1;
			}
		}
		return added;
	}

	async srem(key: string, ...members: string[]): Promise<number> {
		const set = this.sets.get(key);
		if (!set) return 0;
		let removed = 0;
		for (const member of members) if (set.delete(member)) removed += 1;
		return removed;
	}

	async smembers(key: string): Promise<string[]> {
		return [...(this.sets.get(key) ?? [])];
	}
}

function subscription(
	endpoint: string,
	expirationTime: number | null = null,
): PushSubscription {
	return {
		endpoint,
		expirationTime,
		keys: { p256dh: `p256dh-${endpoint}`, auth: `auth-${endpoint}` },
	};
}

describe("nova > RedisSubscriptionStore", () => {
	let redis: FakeRedis;
	let store: RedisSubscriptionStore;

	beforeEach(() => {
		redis = new FakeRedis();
		store = new RedisSubscriptionStore(redis);
	});

	it("stores a subscription and reads it back whole", async () => {
		await store.save(
			"user-A",
			subscription("https://push.example/one", 1893456000000),
		);

		expect(await store.listByUser("user-A")).toEqual([
			{
				endpoint: "https://push.example/one",
				expirationTime: 1893456000000,
				keys: {
					p256dh: "p256dh-https://push.example/one",
					auth: "auth-https://push.example/one",
				},
			},
		]);
	});

	it("moves an endpoint to its new owner instead of leaving it on both", async () => {
		const endpoint = "https://push.example/shared";
		await store.save("user-A", subscription(endpoint));
		await store.save("user-B", subscription(endpoint));

		expect(await store.listByUser("user-A")).toEqual([]);
		expect(await store.listByUser("user-B")).toHaveLength(1);
		// And the old owner's set no longer names it — not merely filtered out
		// on read, actually removed.
		expect(await redis.smembers("nova:push:user:user-A")).toEqual([]);
	});

	it("deletes an endpoint and its membership together", async () => {
		await store.save("user-A", subscription("https://push.example/dead"));
		await store.delete("https://push.example/dead");

		expect(await store.listByUser("user-A")).toEqual([]);
		expect(redis.strings.size).toBe(0);
		expect(await redis.smembers("nova:push:user:user-A")).toEqual([]);
	});

	it("prunes a member whose record is gone", async () => {
		await store.save("user-A", subscription("https://push.example/one"));
		// What a process that died between the two writes leaves behind.
		redis.strings.delete("nova:push:sub:https://push.example/one");

		expect(await store.listByUser("user-A")).toEqual([]);
		expect(await redis.smembers("nova:push:user:user-A")).toEqual([]);
	});

	it("treats an unreadable record as absent rather than failing the account", async () => {
		await store.save("user-A", subscription("https://push.example/one"));
		await store.save("user-A", subscription("https://push.example/two"));
		redis.strings.set("nova:push:sub:https://push.example/one", "{not json");

		const found = await store.listByUser("user-A");
		expect(found).toHaveLength(1);
		expect(found[0]?.endpoint).toBe("https://push.example/two");
	});

	it("keeps two applications apart with a prefix", async () => {
		const other = new RedisSubscriptionStore(redis, { prefix: "other:push" });
		await store.save("user-A", subscription("https://push.example/mine"));
		await other.save("user-A", subscription("https://push.example/theirs"));

		expect((await store.listByUser("user-A")).map((s) => s.endpoint)).toEqual([
			"https://push.example/mine",
		]);
		expect((await other.listByUser("user-A")).map((s) => s.endpoint)).toEqual([
			"https://push.example/theirs",
		]);
	});

	it("refuses a prefix that cannot be a Redis key", () => {
		expect(
			() => new RedisSubscriptionStore(redis, { prefix: "no spaces" }),
		).toThrow(NovaError);
	});
});
