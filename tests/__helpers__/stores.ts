/**
 * The SQL engine the store tests run against, real and in process. The
 * Redis store's run against a real server: see `redis.ts`.
 */

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SubscriptionDatabase } from "../../src/index.js";
import { asRequested } from "./container.js";

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
			const result = db.prepare(sql).run(...sqlValues(params));
			return { rowsAffected: Number(result.changes) };
		},
		// Generic over the row shape the store expects, as a driver's is.
		async query<T>(sql: string, params: unknown[] = []) {
			return asRequested<T[]>(db.prepare(sql).all(...sqlValues(params)));
		},
		close: () => db.close(),
	};
}

/** The parameters as `node:sqlite` binds them; anything else is a test bug. */
function sqlValues(params: readonly unknown[]): SQLInputValue[] {
	return params.map((value) => {
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "bigint" ||
			value instanceof Uint8Array
		) {
			return value;
		}
		throw new TypeError(`cannot bind ${typeof value} to SQLite`);
	});
}
