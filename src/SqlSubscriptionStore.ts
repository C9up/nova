/**
 * SQL-backed subscription storage — the durable half of `SubscriptionStore`.
 *
 * `configure` writes the `push_subscriptions` migration; this is what uses it.
 * Without it an application that followed the onboarding has the table and
 * still loses every subscription on restart, because the provider falls back to
 * the in-memory driver.
 *
 * No import of a database package. The connection is taken structurally —
 * `query`, `execute`, and the dialect it reports — so this works against an
 * Atlas connection without nova depending on Atlas, which is an optional peer.
 *
 *   // config/nova.ts
 *   import db from '@c9up/atlas/services/db'
 *   import { defineConfig, SqlSubscriptionStore } from '@c9up/nova'
 *
 *   export default defineConfig({
 *     store: new SqlSubscriptionStore(db),
 *   })
 */

import { assertMayTakeOver } from "./_internal/ownership.js";
import { perUserCap } from "./_internal/per-user-cap.js";
import { subscriptionProblem } from "./_internal/subscription.js";
import { NovaError } from "./errors.js";
import type {
	PushSubscription,
	SaveSubscriptionOptions,
	SubscriptionStore,
} from "./SubscriptionStore.js";

/**
 * What a connection has to answer. Every SQL client in the Ream universe
 * already does; anything else needs three methods.
 */
export interface SubscriptionDatabase {
	/** `"postgres"` selects `$1` placeholders; anything else uses `?`. */
	readonly dialect?: string;
	execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>;
	query<T = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
	): Promise<T[]>;
}

/**
 * How the store gets its connection: the connection itself, or something that
 * answers with one.
 *
 * The resolver form is what a config file needs. `config/nova.ts` is loaded
 * before the application boots, so the connection does not exist yet and cannot
 * be awaited there — a function defers the lookup to the first push.
 */
export type SubscriptionDatabaseResolver =
	| SubscriptionDatabase
	| (() => SubscriptionDatabase | Promise<SubscriptionDatabase>);

export interface SqlSubscriptionStoreOptions {
	/** Table the migration created. Default `"push_subscriptions"`. */
	table?: string;
}

/** One row, as the migration declares it. */
interface SubscriptionRow {
	endpoint: string;
	p256dh: string;
	auth: string;
	expiration_time: number | string | null;
}

/** Who holds an endpoint, and with which keys. */
interface OwnerRow {
	user_id: string | number;
	p256dh: string;
	auth: string;
}

// The table name reaches the SQL as an identifier, where a parameter cannot go.
// Refusing anything but a plain identifier is what keeps that safe.
const SAFE_TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class SqlSubscriptionStore implements SubscriptionStore {
	readonly #source: SubscriptionDatabaseResolver;
	#resolved: SubscriptionDatabase | undefined;
	readonly #table: string;

	constructor(
		db: SubscriptionDatabaseResolver,
		options: SqlSubscriptionStoreOptions = {},
	) {
		const table = options.table ?? "push_subscriptions";
		if (!SAFE_TABLE.test(table)) {
			throw new NovaError(
				"E_NOVA_INVALID_TABLE",
				`Invalid table name "${table}" — it reaches the SQL as an identifier, where a parameter cannot go.`,
				{
					hint: "Letters, digits and underscores only, not starting with a digit.",
				},
			);
		}
		this.#source = db;
		this.#table = table;
	}

	/** The connection, resolved once and kept. */
	async #db(): Promise<SubscriptionDatabase> {
		if (this.#resolved) return this.#resolved;
		this.#resolved =
			typeof this.#source === "function" ? await this.#source() : this.#source;
		return this.#resolved;
	}

	/**
	 * `$1`-style placeholders on Postgres, `?` elsewhere. The SQL goes to the
	 * driver verbatim, so the shape has to match the dialect.
	 */
	#placeholder(db: SubscriptionDatabase, index: number): string {
		return db.dialect === "postgres" ? `$${index}` : "?";
	}

	/**
	 * Store a subscription for `userId`.
	 *
	 * The delete comes first, and it is not conditioned on the user: a push
	 * endpoint is globally unique per push service, so a browser reused across a
	 * logout/login pair would otherwise stay attached to BOTH accounts — and the
	 * next notification for the old one would land on the new user's screen.
	 * Same rule as the in-memory driver, for the same reason — and, like it,
	 * granted only to a poster presenting the keys already stored.
	 *
	 * `CURRENT_TIMESTAMP` rather than a JavaScript date: it is standard SQL on
	 * all three dialects, and it keeps a text-bound timestamp away from
	 * Postgres, which will not coerce one on assignment.
	 */
	async save(
		userId: string,
		subscription: PushSubscription,
		options: SaveSubscriptionOptions = {},
	): Promise<void> {
		const max = perUserCap(options.maxPerUser);
		// The same rules the subscribe endpoint applies, so a row this store
		// writes is always one `listByUser` can hand the push layer. A column
		// type checks a length, not what a P-256 point looks like.
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

		const db = await this.#db();
		const [current] = await db.query<OwnerRow>(
			`SELECT user_id, p256dh, auth FROM ${this.#table} ` +
				`WHERE endpoint = ${this.#placeholder(db, 1)}`,
			[subscription.endpoint],
		);
		assertMayTakeOver(
			subscription.endpoint,
			userId,
			current && {
				userId: String(current.user_id),
				keys: { p256dh: current.p256dh, auth: current.auth },
			},
			subscription.keys,
		);
		await this.delete(subscription.endpoint);
		const values = [1, 2, 3, 4, 5]
			.map((i) => this.#placeholder(db, i))
			.join(", ");
		await db.execute(
			`INSERT INTO ${this.#table} (endpoint, user_id, p256dh, auth, expiration_time, created_at, updated_at) ` +
				`VALUES (${values}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
			[
				subscription.endpoint,
				userId,
				subscription.keys.p256dh,
				subscription.keys.auth,
				subscription.expirationTime,
			],
		);
		await this.#trim(db, userId, max);
	}

	/**
	 * Evict `userId`'s oldest rows past `max`, in one statement.
	 *
	 * One statement is atomic on every dialect, and the order is total
	 * (`created_at`, then `endpoint` for rows stamped in the same second), so
	 * concurrent subscribes for one user agree on which rows are the oldest:
	 * each evicts the same ones, and the user ends at the cap, never under it.
	 * The inner `LIMIT` sits in a derived table because MySQL refuses both a
	 * `LIMIT` directly inside `IN` and a subquery naming the table a `DELETE`
	 * writes; the derived table is materialised first. `max` is a checked
	 * integer, never input, and some drivers will not bind a `LIMIT`.
	 */
	async #trim(
		db: SubscriptionDatabase,
		userId: string,
		max: number,
	): Promise<void> {
		await db.execute(
			`DELETE FROM ${this.#table} WHERE user_id = ${this.#placeholder(db, 1)} ` +
				"AND endpoint NOT IN (SELECT endpoint FROM (" +
				`SELECT endpoint FROM ${this.#table} WHERE user_id = ${this.#placeholder(db, 2)} ` +
				`ORDER BY created_at DESC, endpoint DESC LIMIT ${max}` +
				") AS kept)",
			[userId, userId],
		);
	}

	/** Every subscription `userId` has registered, oldest first. */
	async listByUser(userId: string): Promise<PushSubscription[]> {
		const db = await this.#db();
		const rows = await db.query<SubscriptionRow>(
			`SELECT endpoint, p256dh, auth, expiration_time FROM ${this.#table} ` +
				`WHERE user_id = ${this.#placeholder(db, 1)} ORDER BY created_at, endpoint`,
			[userId],
		);
		return rows.map((row) => ({
			endpoint: row.endpoint,
			// A big integer can arrive as a string — the drivers hand back the text
			// for anything beyond a safe JavaScript number rather than lose digits.
			expirationTime: toEpochMs(row.expiration_time),
			keys: { p256dh: row.p256dh, auth: row.auth },
		}));
	}

	/** Forget one subscription, whoever owns it. */
	async delete(endpoint: string): Promise<void> {
		const db = await this.#db();
		await db.execute(
			`DELETE FROM ${this.#table} WHERE endpoint = ${this.#placeholder(db, 1)}`,
			[endpoint],
		);
	}

	/** Ownership is part of the `WHERE`, so the check and the removal are one statement. */
	async deleteForUser(userId: string, endpoint: string): Promise<boolean> {
		const db = await this.#db();
		const { rowsAffected } = await db.execute(
			`DELETE FROM ${this.#table} WHERE endpoint = ${this.#placeholder(db, 1)} ` +
				`AND user_id = ${this.#placeholder(db, 2)}`,
			[endpoint, userId],
		);
		return rowsAffected > 0;
	}
}

function toEpochMs(value: number | string | null): number | null {
	if (value === null) return null;
	if (typeof value === "number") return value;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}
