/**
 * The Redis store, against a real server.
 *
 * Its writes are scripts the server runs whole; what is under test is that
 * the cap and the owner checks hold there, whoever writes at once. Two store
 * instances on one server stand for two application processes behind a load
 * balancer: each has its own connection, so their commands really
 * interleave on the server, and nothing in one instance can order the
 * other's writes.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { NovaError, RedisSubscriptionStore } from "../../src/index.js";
import {
	describeRedis,
	dropPrefix,
	freshPrefix,
	RespClient,
	redisUrl,
} from "../__helpers__/redis.js";
import {
	realAuth,
	realP256dh,
	subscription,
} from "../__helpers__/subscription.js";

/** One real key pair, so a written record and the expected read agree. */
const P256DH = realP256dh();
const AUTH = realAuth();

const clients: RespClient[] = [];
const prefixes: string[] = [];

beforeAll(async () => {
	if (redisUrl === "") return;
	for (let i = 0; i < 3; i++) clients.push(await RespClient.open(redisUrl));
});

afterAll(async () => {
	const [admin] = clients;
	if (admin) for (const prefix of prefixes) await dropPrefix(admin, prefix);
	for (const client of clients) await client.close();
});

/** The connection tests look and seed with, and a prefix of their own. */
function fresh(label: string): { admin: RespClient; prefix: string } {
	const [admin] = clients;
	if (!admin) throw new Error("clients not open");
	const prefix = freshPrefix(label);
	prefixes.push(prefix);
	return { admin, prefix };
}

/** The endpoints a user's set holds, oldest first. */
async function indexed(
	admin: RespClient,
	prefix: string,
	userId: string,
): Promise<unknown> {
	return admin.command("ZRANGE", `${prefix}:user:${userId}`, 0, -1);
}

describeRedis("nova > RedisSubscriptionStore", () => {
	let admin: RespClient;
	let prefix: string;
	let store: RedisSubscriptionStore;

	beforeEach(() => {
		({ admin, prefix } = fresh("one"));
		const [, client] = clients;
		if (!client) throw new Error("clients not open");
		store = new RedisSubscriptionStore(client, { prefix });
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
		expect(await indexed(admin, prefix, "user-A")).toEqual([]);
	});

	it("deletes an endpoint and its membership together", async () => {
		await store.save("user-A", subscription("https://push.example/dead"));
		await store.delete("https://push.example/dead");

		expect(await store.listByUser("user-A")).toEqual([]);
		expect(await admin.command("KEYS", `${prefix}:*`)).toEqual([]);
	});

	it("prunes a member whose record is gone", async () => {
		await store.save("user-A", subscription("https://push.example/one"));
		// What a process that died between the two writes leaves behind.
		await admin.command("DEL", `${prefix}:sub:https://push.example/one`);

		expect(await store.listByUser("user-A")).toEqual([]);
		expect(await indexed(admin, prefix, "user-A")).toEqual([]);
	});

	it("treats an unreadable record as absent rather than failing the account", async () => {
		await store.save("user-A", subscription("https://push.example/one"));
		await store.save("user-A", subscription("https://push.example/two"));
		await admin.command(
			"SET",
			`${prefix}:sub:https://push.example/one`,
			"{not json",
		);

		const found = await store.listByUser("user-A");
		expect(found).toHaveLength(1);
		expect(found[0]?.endpoint).toBe("https://push.example/two");
	});

	it("keeps two applications apart with a prefix", async () => {
		const [, client] = clients;
		if (!client) throw new Error("clients not open");
		const other = new RedisSubscriptionStore(client, {
			prefix: fresh("other").prefix,
		});
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
			() => new RedisSubscriptionStore(admin, { prefix: "no spaces" }),
		).toThrow(NovaError);
	});

	it("converts a user's set an earlier version wrote, oldest first", async () => {
		const old = subscription("https://push.example/old");
		await admin.command(
			"SET",
			`${prefix}:sub:${old.endpoint}`,
			JSON.stringify({
				userId: "user-A",
				expirationTime: null,
				p256dh: old.keys.p256dh,
				auth: old.keys.auth,
				createdAt: 1_700_000_000_000,
			}),
		);
		await admin.command("SADD", `${prefix}:user:user-A`, old.endpoint);

		expect(await store.listByUser("user-A")).toEqual([old]);
		expect(await admin.command("TYPE", `${prefix}:user:user-A`)).toBe("zset");

		const next = subscription("https://push.example/new");
		await store.save("user-A", next, { maxPerUser: 1 });
		expect(await store.listByUser("user-A")).toEqual([next]);
		expect(await admin.command("GET", `${prefix}:sub:${old.endpoint}`)).toBe(
			null,
		);
	});
});

/**
 * The rules `_internal/subscription.ts` states — checked on the way in and on
 * the way out — applied to the store that keeps its records as opaque JSON,
 * the same way the file store applies them.
 */
describeRedis(
	"nova > RedisSubscriptionStore > what it will and will not read back",
	() => {
		let admin: RespClient;
		let prefix: string;
		let store: RedisSubscriptionStore;

		beforeEach(() => {
			({ admin, prefix } = fresh("read"));
			const [, client] = clients;
			if (!client) throw new Error("clients not open");
			store = new RedisSubscriptionStore(client, { prefix });
		});

		/** Put a record in by hand, the way an older writer or an edit would. */
		async function seed(
			endpoint: string,
			record: Record<string, unknown>,
		): Promise<void> {
			await admin.command(
				"SET",
				`${prefix}:sub:${endpoint}`,
				JSON.stringify(record),
			);
			await admin.command("ZADD", `${prefix}:user:user-A`, 1, endpoint);
		}

		it("does not hand the push layer a record with a truncated key", async () => {
			await seed("https://push.example/one", {
				userId: "user-A",
				expirationTime: null,
				p256dh: "TRUNCATED",
				auth: AUTH,
			});

			// It used to come back whole. web-push then fails on it as an
			// encryption error naming neither the key nor the endpoint, and
			// nothing cleans it up: cleanup runs on a 404/410 from the push
			// service, and that request was never made.
			expect(await store.listByUser("user-A")).toEqual([]);
			expect(await indexed(admin, prefix, "user-A")).toEqual([]);
		});

		it("does not hand back a record whose `expirationTime` is missing", async () => {
			await seed("https://push.example/two", {
				userId: "user-A",
				p256dh: P256DH,
				auth: AUTH,
			});

			// The type says `number | null`. The guard used to check three
			// strings and say yes, so `expirationTime` arrived as undefined.
			expect(await store.listByUser("user-A")).toEqual([]);
		});

		it("does not hand back a record whose endpoint is not an https URL", async () => {
			await seed("ftp://push.example/three", {
				userId: "user-A",
				expirationTime: null,
				p256dh: P256DH,
				auth: AUTH,
			});

			expect(await store.listByUser("user-A")).toEqual([]);
		});

		it("still hands back a record that holds what a browser sends", async () => {
			const sent = subscription("https://push.example/four", 1893456000000);
			await seed("https://push.example/four", {
				userId: "user-A",
				expirationTime: 1893456000000,
				p256dh: sent.keys.p256dh,
				auth: sent.keys.auth,
			});

			expect(await store.listByUser("user-A")).toEqual([sent]);
		});

		it("refuses to store what it would refuse to read", async () => {
			// Otherwise the store writes a record it later drops in silence,
			// and the subscription is gone with nothing to point at.
			await expect(
				store.save("user-A", {
					endpoint: "https://push.example/five",
					expirationTime: null,
					keys: { p256dh: "too-short", auth: AUTH },
				}),
			).rejects.toMatchObject({
				code: "E_NOVA_INVALID_SUBSCRIPTION",
				message: /p256dh/,
			});
			expect(await admin.command("KEYS", `${prefix}:*`)).toEqual([]);
		});
	},
);

describeRedis("nova > RedisSubscriptionStore across processes", () => {
	/** Two processes' stores on one prefix, and a connection to look with. */
	function twoProcesses(label: string): {
		first: RedisSubscriptionStore;
		second: RedisSubscriptionStore;
		admin: RespClient;
		prefix: string;
	} {
		const [, a, b] = clients;
		if (!a || !b) throw new Error("clients not open");
		const { admin, prefix } = fresh(label);
		return {
			first: new RedisSubscriptionStore(a, { prefix }),
			second: new RedisSubscriptionStore(b, { prefix }),
			admin,
			prefix,
		};
	}

	it("holds the cap under 60 concurrent saves split between two processes", async () => {
		const { first, second, admin, prefix } = twoProcesses("cap");
		await Promise.all(
			Array.from({ length: 60 }, (_, n) =>
				(n % 2 === 0 ? first : second).save(
					"user-A",
					subscription(`https://push.example/cap-${n}`),
					{ maxPerUser: 20 },
				),
			),
		);

		expect(await first.listByUser("user-A")).toHaveLength(20);
		expect(await second.listByUser("user-A")).toHaveLength(20);
		// The index itself, not only what a listing filters it down to.
		expect(await admin.command("ZCARD", `${prefix}:user:user-A`)).toBe(20);
		// No record outlives its eviction from the index.
		const records = await admin.command("KEYS", `${prefix}:sub:*`);
		expect(Array.isArray(records) ? records.length : records).toBe(20);
	});

	it("never lets the old owner delete an endpoint another process took over meanwhile", async () => {
		const { first, second, prefix } = twoProcesses("owner");
		const endpoint = "https://push.example/shared-device";
		const browser = subscription(endpoint);
		await first.save("user-A", browser);

		// The old owner's process is about to remove the record; the other
		// process moves the endpoint to user-B right before it does.
		const [, a] = clients;
		if (!a) throw new Error("clients not open");
		const recordKey = `${prefix}:sub:${endpoint}`;
		let tookOver = false;
		const racing = new Proxy(a, {
			get(target, property, receiver) {
				const value: unknown = Reflect.get(target, property, receiver);
				if (typeof value !== "function") return value;
				if (property === "get") {
					return (...args: unknown[]) => Reflect.apply(value, target, args);
				}
				return async (...args: unknown[]) => {
					if (!tookOver && args.includes(recordKey)) {
						tookOver = true;
						await second.save("user-B", browser);
					}
					return Reflect.apply(value, target, args);
				};
			},
		});
		const oldOwner = new RedisSubscriptionStore(racing, { prefix });

		await oldOwner.deleteForUser("user-A", endpoint);

		expect(tookOver).toBe(true);
		expect(await second.listByUser("user-B")).toEqual([browser]);
		expect(await second.listByUser("user-A")).toEqual([]);
	});
});
