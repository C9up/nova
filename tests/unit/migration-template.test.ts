/**
 * Migration template integrity — purely textual checks, on the stub
 * `configure` publishes.
 *
 * The stub is the one copy: it is what an application receives, so it is
 * what these read. Its `import { Migration } from '@c9up/atlas'` only
 * resolves once written into an application, where `@c9up/atlas` is
 * installed, so the contents are checked as text.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);
const STUB_PATH = path.join(
	ROOT,
	"stubs",
	"database",
	"migrations",
	"0048_create_push_subscriptions.stub",
);

/** The stub without its `---` front matter: the file an application gets. */
function body(stub: string): string {
	const match = /^---\n[\s\S]*?\n---\n/.exec(stub);
	return match ? stub.slice(match[0].length) : stub;
}

describe("the push_subscriptions migration has one source", () => {
	it("ships no second copy beside the stub", async () => {
		await expect(access(path.join(ROOT, "migrations"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		const manifest: unknown = JSON.parse(
			await readFile(path.join(ROOT, "package.json"), "utf8"),
		);
		const files =
			typeof manifest === "object" && manifest !== null && "files" in manifest
				? manifest.files
				: undefined;
		expect(files).not.toContain("migrations");
	});
});

describe("0048_create_push_subscriptions.stub — template integrity", () => {
	let template: string;

	beforeAll(async () => {
		template = body(await readFile(STUB_PATH, "utf8"));
	});

	it("says what the store writes into the timestamp columns", () => {
		// SqlSubscriptionStore writes CURRENT_TIMESTAMP on every dialect.
		expect(template).not.toMatch(/NOW\(\) for mysql/);
		expect(template).toMatch(/CURRENT_TIMESTAMP on every dialect/);
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
		// 768 chars x 4 bytes/char = 3072 bytes, exactly at the MySQL InnoDB
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
