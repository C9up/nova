/**
 * Backends the store tests run against: a real SQL engine and a Redis that
 * keeps Redis semantics, both in process.
 */

import { DatabaseSync } from "node:sqlite";
import type {
	SubscriptionDatabase,
	SubscriptionRedisClient,
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
export class FakeRedis implements SubscriptionRedisClient {
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
export function sqliteConnection(): SubscriptionDatabase & { close(): void } {
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
