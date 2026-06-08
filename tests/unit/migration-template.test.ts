/**
 * Migration template integrity — purely textual checks.
 *
 * The template lives outside `src/` (the package keeps its main surface
 * Atlas-agnostic — the file's `import { Migration } from '@c9up/atlas'`
 * is only resolved when the user copies the file into their app, where
 * `@c9up/atlas` is installed). Nova's own typecheck excludes
 * `migrations/` (tsconfig.include = ["src"]), so we verify the contents
 * by reading the file as text.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.resolve(
	HERE,
	"..",
	"..",
	"migrations",
	"create_push_subscriptions.ts",
);

describe("migrations/create_push_subscriptions.ts — template integrity", () => {
	let template: string;

	beforeAll(async () => {
		template = await readFile(MIGRATION_PATH, "utf8");
	});

	it("imports Migration from @c9up/atlas", () => {
		expect(template).toMatch(
			/import\s*{\s*Migration\s*}\s*from\s*['"]@c9up\/atlas['"]/,
		);
	});

	it("creates the push_subscriptions table", () => {
		expect(template).toMatch(/createTable\(['"]push_subscriptions['"]/);
	});

	it("declares endpoint as primary key", () => {
		expect(template).toMatch(/\.string\(['"]endpoint['"][\s\S]*?\.primary\(\)/);
	});

	it("declares user_id as not-nullable with a separate index on the user_id column", () => {
		expect(template).toMatch(
			/\.string\(['"]user_id['"][\s\S]*?\.notNullable\(\)/,
		);
		expect(template).toMatch(/\.index\(['"]user_id['"]\)/);
	});

	it("declares endpoint with the 768-char InnoDB-utf8mb4-safe budget", () => {
		// 768 chars × 4 bytes/char = 3072 bytes, exactly at the MySQL InnoDB
		// utf8mb4 (DYNAMIC row format) index limit. See AUDIT-migration-templates.md.
		expect(template).toMatch(/\.string\(['"]endpoint['"]\s*,\s*768\)/);
	});

	it("declares the keys columns (p256dh, auth) as not-nullable", () => {
		expect(template).toMatch(
			/\.string\(['"]p256dh['"][\s\S]*?\.notNullable\(\)/,
		);
		expect(template).toMatch(/\.string\(['"]auth['"][\s\S]*?\.notNullable\(\)/);
	});

	it("declares expiration_time as a nullable bigInteger", () => {
		expect(template).toMatch(
			/\.bigInteger\(['"]expiration_time['"][\s\S]*?\.nullable\(\)/,
		);
	});

	it("declares created_at / updated_at as explicit notNullable timestamps (no DEFAULT)", () => {
		// The `timestamps()` helper would emit `DEFAULT (NOW())` which is
		// invalid in SQLite — keep the explicit declarations so the
		// migration runs on every Atlas dialect. The driver writes both
		// columns explicitly on every INSERT/UPSERT.
		expect(template).toMatch(
			/\.timestamp\(['"]created_at['"]\)[\s\S]*?\.notNullable\(\)/,
		);
		expect(template).toMatch(
			/\.timestamp\(['"]updated_at['"]\)[\s\S]*?\.notNullable\(\)/,
		);
	});

	it("implements down() with dropTable", () => {
		expect(template).toMatch(/dropTable\(['"]push_subscriptions['"]/);
	});
});
