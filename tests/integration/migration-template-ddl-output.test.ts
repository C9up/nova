/**
 * Per-dialect DDL output for the Nova migration template (AC2 of Story 48.2).
 *
 * The Nova migration template (`packages/nova/migrations/create_push_subscriptions.ts`)
 * lives OUTSIDE `tsconfig.include = ["src"]` — it ships in the tarball but is
 * not part of the typechecked surface. This test dynamically imports the
 * template (vitest resolves `@c9up/atlas` via the workspace symlink graph),
 * instantiates the Migration subclass under each dialect, captures the
 * emitted DDL, and asserts it byte-for-byte against committed fixtures.
 *
 * Why this matters: the previous "textual integrity" test
 * (`tests/unit/migration-template.test.ts`) only catches regressions in the
 * TS source — it cannot catch a regression in Atlas's DDL compiler that
 * would shift the emitted SQL on, say, MySQL. The DDL fixtures pin the
 * COMPILED OUTPUT, not the AUTHORING SOURCE; together the two tests
 * cover orthogonal invariants.
 *
 * Refresh procedure: any deliberate change to the template OR to the Atlas
 * compiler that shifts emitted SQL fails this test loudly. To refresh:
 * inspect the test output diff, then re-write the fixture (`fs.writeFile`
 * with the captured statements joined by `\n` + trailing newline) and
 * commit alongside the template change.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AtlasDialect } from "@c9up/atlas";
import { describe, expect, it } from "vitest";
import { assertInnodbPkBudget } from "../../../atlas/tests/unit/migration-portability.js";

// Note on cross-package test import: the helper lives in atlas's test surface
// (not in atlas/src/) per the audit decision to keep portability tooling out
// of the runtime tarball. Relative path crosses package boundary because the
// helper is intentionally test-only — promote to src/ if a non-test caller
// ever needs it (none today).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.resolve(
	HERE,
	"..",
	"..",
	"migrations",
	"create_push_subscriptions.ts",
);
const FIXTURE_DIR = path.resolve(HERE, "fixtures", "ddl");

const DIALECTS = [
	"sqlite",
	"postgres",
	"mysql",
] as const satisfies readonly AtlasDialect[];

interface MigrationModule {
	default: new (
		dialect: AtlasDialect,
	) => {
		getUpSQL(): Promise<string[]>;
	};
}

function isMigrationModule(m: unknown): m is MigrationModule {
	if (typeof m !== "object" || m === null) return false;
	const ctor = (m as { default?: unknown }).default;
	return typeof ctor === "function";
}

async function compileTemplateDdl(dialect: AtlasDialect): Promise<string> {
	const mod: unknown = await import(MIGRATION_PATH);
	if (!isMigrationModule(mod)) {
		throw new Error(
			`migration template ${MIGRATION_PATH} did not export a default Migration subclass`,
		);
	}
	const instance = new mod.default(dialect);
	const statements = await instance.getUpSQL();
	return `${statements.join("\n")}\n`;
}

describe("nova migration template — per-dialect DDL output", () => {
	for (const dialect of DIALECTS) {
		it(`emits the expected ${dialect} DDL`, async () => {
			const actual = await compileTemplateDdl(dialect);
			const fixturePath = path.join(
				FIXTURE_DIR,
				dialect,
				"create_push_subscriptions.sql",
			);
			const expected = await readFile(fixturePath, "utf8");
			expect(actual).toBe(expected);
		});
	}

	it("the mysql DDL stays under the InnoDB utf8mb4 3072-byte index budget", async () => {
		const mysqlDdl = await compileTemplateDdl("mysql");
		expect(() => {
			assertInnodbPkBudget(mysqlDdl);
		}).not.toThrow();
	});
});
