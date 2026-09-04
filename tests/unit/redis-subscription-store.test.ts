import { beforeEach, describe, expect, it } from "vitest";
import {
	NovaError,
	RedisSubscriptionStore,
	type SubscriptionRedisClient,
} from "../../src/index.js";
import { keyOfLength, subscription } from "../__helpers__/subscription.js";

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

describe("nova > RedisSubscriptionStore", () => {
	let redis: FakeRedis;
	let store: RedisSubscriptionStore;

	beforeEach(() => {
		redis = new FakeRedis();
		store = new RedisSubscriptionStore(redis);
	});

	it("stores a subscription and reads it back whole", async () => {
		const sent = subscription("https://push.example/one", 1893456000000);
		await store.save("user-A", sent);

		expect(await store.listByUser("user-A")).toEqual([sent]);
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

/**
 * The rules `_internal/subscription.ts` states — checked on the way in and on
 * the way out — applied to the store that keeps its records as opaque JSON,
 * the same way the file store applies them.
 */
describe("nova > RedisSubscriptionStore > what it will and will not read back", () => {
	let redis: FakeRedis;
	let store: RedisSubscriptionStore;

	beforeEach(() => {
		redis = new FakeRedis();
		store = new RedisSubscriptionStore(redis);
	});

	/** Put a record in by hand, the way an older writer or an edit would. */
	function seed(endpoint: string, record: Record<string, unknown>): void {
		redis.strings.set(`nova:push:sub:${endpoint}`, JSON.stringify(record));
		redis.sets.set("nova:push:user:user-A", new Set([endpoint]));
	}

	it("does not hand the push layer a record with a truncated key", async () => {
		seed("https://push.example/one", {
			userId: "user-A",
			expirationTime: null,
			p256dh: "TRUNCATED",
			auth: keyOfLength("auth", 22),
		});

		// It used to come back whole. web-push then fails on it as an
		// encryption error naming neither the key nor the endpoint, and nothing
		// cleans it up: cleanup runs on a 404/410 from the push service, and
		// that request was never made.
		expect(await store.listByUser("user-A")).toEqual([]);
		expect(await redis.smembers("nova:push:user:user-A")).toEqual([]);
	});

	it("does not hand back a record whose `expirationTime` is missing", async () => {
		seed("https://push.example/two", {
			userId: "user-A",
			p256dh: keyOfLength("p256dh", 87),
			auth: keyOfLength("auth", 22),
		});

		// The type says `number | null`. The guard used to check three strings
		// and say yes, so `expirationTime` arrived as undefined.
		expect(await store.listByUser("user-A")).toEqual([]);
	});

	it("does not hand back a record whose endpoint is not an https URL", async () => {
		seed("ftp://push.example/three", {
			userId: "user-A",
			expirationTime: null,
			p256dh: keyOfLength("p256dh", 87),
			auth: keyOfLength("auth", 22),
		});

		expect(await store.listByUser("user-A")).toEqual([]);
	});

	it("still hands back a record that holds what a browser sends", async () => {
		const sent = subscription("https://push.example/four", 1893456000000);
		seed("https://push.example/four", {
			userId: "user-A",
			expirationTime: 1893456000000,
			p256dh: sent.keys.p256dh,
			auth: sent.keys.auth,
		});

		expect(await store.listByUser("user-A")).toEqual([sent]);
	});

	it("refuses to store what it would refuse to read", async () => {
		// Otherwise the store writes a record it later drops in silence, and
		// the subscription is gone with nothing to point at.
		await expect(
			store.save("user-A", {
				endpoint: "https://push.example/five",
				expirationTime: null,
				keys: { p256dh: "too-short", auth: keyOfLength("auth", 22) },
			}),
		).rejects.toMatchObject({
			code: "E_NOVA_INVALID_SUBSCRIPTION",
			message: /p256dh/,
		});
		expect(redis.strings.size).toBe(0);
	});
});
