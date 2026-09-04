import { Migration } from "@c9up/atlas";

export default class CreatePushSubscriptions extends Migration {
	async up() {
		this.schema.createTable("push_subscriptions", (t) => {
			// 768 chars × 4 bytes/char = 3072 bytes — exactly at the MySQL InnoDB
			// utf8mb4 (DYNAMIC row format) index limit. Well above the longest
			// endpoint URL observed in the wild from FCM / Mozilla autopush / Apple
			// push services (all < 200 chars). Do NOT raise this without re-running
			// `assertInnodbPkBudget` in `packages/atlas/tests/unit/migration-portability.ts`.
			// Nova's runtime `MAX_ENDPOINT_LENGTH` (`src/_internal/subscription.ts`)
			// is kept in sync with this 768 cap so an over-long endpoint is rejected
			// with a controlled 400 at the boundary, never a dialect-specific DB
			// length error on insert.
			t.string("endpoint", 768).primary();
			t.string("user_id", 255).notNullable();
			t.index("user_id");
			t.string("p256dh", 100).notNullable();
			t.string("auth", 50).notNullable();
			t.bigInteger("expiration_time").nullable();
			// Explicit timestamp columns without DEFAULT — Atlas's `t.timestamps()`
			// emits `DEFAULT (NOW())` which is not a SQLite function and would
			// fail at `migrations:run` against a fresh sqlite app. The Atlas
			// driver in `@c9up/nova` docs writes `created_at` / `updated_at`
			// explicitly on every INSERT/UPSERT (CURRENT_TIMESTAMP for sqlite/
			// postgres, NOW() for mysql), so the absence of a DDL default is
			// intentional, not an oversight.
			t.timestamp("created_at").notNullable();
			t.timestamp("updated_at").notNullable();
		});
	}

	async down() {
		this.schema.dropTable("push_subscriptions");
	}
}
