import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
	NovaError,
	type PushSubscription,
	SqlSubscriptionStore,
	type SubscriptionDatabase,
} from "../../src/index.js";

/**
 * The durable store, against a real SQL engine.
 *
 * `configure` writes the `push_subscriptions` migration; until this class
 * existed nothing used it, so an application that followed the onboarding had
 * the table and still lost every subscription on restart. These run the actual
 * statements — a driver whose SQL is only asserted as a string is a driver
 * nobody has run.
 */

/** The migration's schema, in SQLite terms. */
const SCHEMA = `
  CREATE TABLE push_subscriptions (
    endpoint VARCHAR(768) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    p256dh VARCHAR(100) NOT NULL,
    auth VARCHAR(50) NOT NULL,
    expiration_time BIGINT,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
  );
  CREATE INDEX push_subscriptions_user_id ON push_subscriptions (user_id);
`;

/** `node:sqlite` behind the three methods the store asks for. */
function sqliteConnection(): SubscriptionDatabase & { close(): void } {
	const db = new DatabaseSync(":memory:");
	db.exec(SCHEMA);
	return {
		dialect: "sqlite",
		async execute(sql, params = []) {
			const result = db.prepare(sql).run(...(params as never[]));
			return { rowsAffected: Number(result.changes) };
		},
		async query<T>(sql: string, params: unknown[] = []) {
			return db.prepare(sql).all(...(params as never[])) as T[];
		},
		close: () => db.close(),
	};
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

describe("nova > SqlSubscriptionStore", () => {
	let db: SubscriptionDatabase & { close(): void };
	let store: SqlSubscriptionStore;

	beforeEach(() => {
		db = sqliteConnection();
		store = new SqlSubscriptionStore(db);
	});

	it("stores a subscription and reads it back whole", async () => {
		await store.save(
			"user-A",
			subscription("https://push.example/one", 1893456000000),
		);

		const [found] = await store.listByUser("user-A");
		expect(found).toEqual({
			endpoint: "https://push.example/one",
			expirationTime: 1893456000000,
			keys: {
				p256dh: "p256dh-https://push.example/one",
				auth: "auth-https://push.example/one",
			},
		});
	});

	it("keeps a null expiry null, rather than turning it into 0", async () => {
		await store.save("user-A", subscription("https://push.example/two"));

		const [found] = await store.listByUser("user-A");
		expect(found?.expirationTime).toBeNull();
	});

	it("moves an endpoint to its new owner instead of leaving it on both", async () => {
		// The shared-device case: one browser, a logout, another login. A push
		// endpoint is globally unique, so leaving the old row would send the next
		// notification for the previous account to whoever logged in after.
		const endpoint = "https://push.example/shared";
		await store.save("user-A", subscription(endpoint));
		await store.save("user-B", subscription(endpoint));

		expect(await store.listByUser("user-A")).toEqual([]);
		expect(await store.listByUser("user-B")).toHaveLength(1);
	});

	it("re-saving the same endpoint for the same user leaves one row", async () => {
		const endpoint = "https://push.example/again";
		await store.save("user-A", subscription(endpoint));
		await store.save("user-A", subscription(endpoint, 42));

		const found = await store.listByUser("user-A");
		expect(found).toHaveLength(1);
		expect(found[0]?.expirationTime).toBe(42);
	});

	it("deletes an endpoint whoever owns it — the 'gone' cleanup path", async () => {
		await store.save("user-A", subscription("https://push.example/dead"));
		await store.delete("https://push.example/dead");

		expect(await store.listByUser("user-A")).toEqual([]);
	});

	it("answers an empty list for a user with nothing", async () => {
		expect(await store.listByUser("nobody")).toEqual([]);
	});

	it("keeps each user's subscriptions to themselves", async () => {
		await store.save("user-A", subscription("https://push.example/a"));
		await store.save("user-B", subscription("https://push.example/b"));

		expect(await store.listByUser("user-A")).toHaveLength(1);
		expect((await store.listByUser("user-A"))[0]?.endpoint).toBe(
			"https://push.example/a",
		);
	});

	it("refuses a table name that is not an identifier", () => {
		// It reaches the SQL as an identifier, where a parameter cannot go.
		expect(
			() => new SqlSubscriptionStore(db, { table: "subs; DROP TABLE users" }),
		).toThrow(NovaError);
		expect(
			() => new SqlSubscriptionStore(db, { table: "my_subscriptions" }),
		).not.toThrow();
	});

	it("numbers its placeholders on Postgres, and uses ? elsewhere", async () => {
		const statements: string[] = [];
		const recorder: SubscriptionDatabase = {
			dialect: "postgres",
			async execute(sql) {
				statements.push(sql);
				return { rowsAffected: 0 };
			},
			async query() {
				return [];
			},
		};

		const pg = new SqlSubscriptionStore(recorder);
		await pg.save("user-A", subscription("https://push.example/pg"));

		// The SQL reaches the driver verbatim, so the placeholder shape has to
		// match the dialect or nothing binds.
		expect(statements[0]).toContain("WHERE endpoint = $1");
		expect(statements[1]).toContain(
			"VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP",
		);
	});
});

/**
 * The shape an Atlas connection presents.
 *
 * Nova does not depend on Atlas, so nothing here imports it — this pins the
 * contract instead: `execute` answering `{ rowsAffected, lastInsertId }`,
 * `query` answering rows, and `dialect` spelled the way Atlas spells it
 * (`"sqlite" | "postgres" | "mysql"`). If Atlas ever renamed one of those, the
 * store would silently pick `?` placeholders on Postgres and bind nothing.
 */
describe("nova > SqlSubscriptionStore with an Atlas-shaped connection", () => {
	interface AtlasShapedConnection {
		readonly dialect: "sqlite" | "postgres" | "mysql";
		execute(
			sql: string,
			params?: unknown[],
		): Promise<{ rowsAffected: number; lastInsertId?: number }>;
		query<T = Record<string, unknown>>(
			sql: string,
			params?: unknown[],
		): Promise<T[]>;
	}

	function atlasShaped(): AtlasShapedConnection & { close(): void } {
		const inner = sqliteConnection();
		return {
			dialect: "sqlite",
			async execute(sql, params) {
				const { rowsAffected } = await inner.execute(sql, params);
				return { rowsAffected, lastInsertId: 0 };
			},
			query: inner.query.bind(inner),
			close: inner.close,
		};
	}

	it("accepts one directly", async () => {
		const connection = atlasShaped();
		const store = new SqlSubscriptionStore(connection);

		await store.save("user-A", subscription("https://push.example/atlas"));
		expect(await store.listByUser("user-A")).toHaveLength(1);
	});

	it("accepts a resolver, for a config loaded before the app boots", async () => {
		const connection = atlasShaped();
		let resolvedTimes = 0;
		const store = new SqlSubscriptionStore(async () => {
			resolvedTimes += 1;
			return connection;
		});

		await store.save("user-A", subscription("https://push.example/lazy"));
		await store.listByUser("user-A");

		// Resolved on first use, then kept: a config file cannot await a
		// connection that does not exist yet.
		expect(resolvedTimes).toBe(1);
	});
});
