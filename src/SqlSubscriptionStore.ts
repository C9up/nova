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

/** Who holds an endpoint, with which keys and expiry. */
interface OwnerRow {
	user_id: string | number;
	p256dh: string;
	auth: string;
	expiration_time: number | string | null;
}

/**
 * Conditional writes a save tries before giving up. Each failure means another
 * writer changed the row in between, so a handful covers any real contention.
 */
const WRITE_ATTEMPTS = 5;

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
	 * One row per endpoint, whoever held it: a push endpoint is globally unique
	 * per push service, so a browser reused across a logout/login pair would
	 * otherwise stay attached to BOTH accounts — and the next notification for
	 * the old one would land on the new user's screen. Same rule as the
	 * in-memory driver, for the same reason — and, like it, granted only to a
	 * poster presenting the keys already stored.
	 *
	 * Concurrent saves of one endpoint (two tabs of a browser, a logout racing
	 * a login) are settled by the database, without a transaction the
	 * structural connection may not offer: the row read for the ownership check
	 * is the one the write is conditioned on. A plain `INSERT` when there was
	 * none — the primary key refuses a second one — and an `UPDATE ... WHERE`
	 * naming the owner and keys that were checked when there was. A write that
	 * lost the race changes nothing, and the save reads again and re-decides.
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
		for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
			if (await this.#write(db, userId, subscription)) {
				await this.#trim(db, userId, max);
				return;
			}
		}
		throw new NovaError(
			"E_NOVA_SUBSCRIPTION_CONFLICT",
			"The subscription kept changing while it was being stored.",
			{
				hint: "Another request was writing the same endpoint at the same time. Retry the subscribe.",
			},
		);
	}

	/**
	 * One attempt at writing the row, conditioned on what was just read.
	 * False when another writer got there in between.
	 */
	async #write(
		db: SubscriptionDatabase,
		userId: string,
		subscription: PushSubscription,
	): Promise<boolean> {
		const current = await this.#owner(db, subscription.endpoint);
		assertMayTakeOver(
			subscription.endpoint,
			userId,
			current && {
				userId: String(current.user_id),
				keys: { p256dh: current.p256dh, auth: current.auth },
			},
			subscription.keys,
		);
		const row = [
			subscription.endpoint,
			userId,
			subscription.keys.p256dh,
			subscription.keys.auth,
			subscription.expirationTime,
		];

		if (current === undefined) {
			const values = [1, 2, 3, 4, 5]
				.map((i) => this.#placeholder(db, i))
				.join(", ");
			try {
				await db.execute(
					`INSERT INTO ${this.#table} (endpoint, user_id, p256dh, auth, expiration_time, created_at, updated_at) ` +
						`VALUES (${values}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
					row,
				);
				return true;
			} catch (error) {
				// The driver's duplicate-key error differs per dialect; a row that
				// now exists is what says another insert won, and anything else is
				// a real failure.
				if ((await this.#owner(db, subscription.endpoint)) === undefined) {
					throw error;
				}
				return false;
			}
		}

		const p = (i: number) => this.#placeholder(db, i);
		// The re-save moves the row to the newest: `created_at` is the age the
		// per-user cap evicts by, as the other stores re-append the record.
		const { rowsAffected } = await db.execute(
			`UPDATE ${this.#table} SET user_id = ${p(1)}, p256dh = ${p(2)}, auth = ${p(3)}, ` +
				`expiration_time = ${p(4)}, created_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP ` +
				`WHERE endpoint = ${p(5)} AND user_id = ${p(6)} AND p256dh = ${p(7)} AND auth = ${p(8)}`,
			[
				userId,
				subscription.keys.p256dh,
				subscription.keys.auth,
				subscription.expirationTime,
				subscription.endpoint,
				String(current.user_id),
				current.p256dh,
				current.auth,
			],
		);
		if (rowsAffected > 0) return true;
		// MySQL counts changed rows, not matched ones: rewriting identical values
		// within the same second reports 0. The row already being what this save
		// writes is a success, not a lost race.
		const now = await this.#owner(db, subscription.endpoint);
		return (
			now !== undefined &&
			String(now.user_id) === userId &&
			now.p256dh === subscription.keys.p256dh &&
			now.auth === subscription.keys.auth &&
			toEpochMs(now.expiration_time) === subscription.expirationTime
		);
	}

	/** Who holds `endpoint` right now, or undefined. */
	async #owner(
		db: SubscriptionDatabase,
		endpoint: string,
	): Promise<OwnerRow | undefined> {
		const [current] = await db.query<OwnerRow>(
			`SELECT user_id, p256dh, auth, expiration_time FROM ${this.#table} ` +
				`WHERE endpoint = ${this.#placeholder(db, 1)}`,
			[endpoint],
		);
		return current;
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
