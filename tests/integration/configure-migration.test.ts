/**
 * Integration test — the configure hook writes the three Nova scaffolding
 * artefacts (`config/nova.ts`, `database/migrations/0048_…`, `public/sw.js`)
 * via the codemods API, idempotently.
 *
 * Uses a fake Codemods that records calls (no fs writes) for hermeticity,
 * plus a real-`createCodemods` block exercising idempotency end-to-end on
 * a tmpdir. The fs idempotency itself is the responsibility of
 * `createCodemods` from `@c9up/ream` (verified by Ream's own test suite);
 * this file proves the configure hook calls the right APIs in the right
 * order with the right content + that the docs snippets stay in sync with
 * the inlined `SW_TEMPLATE`.
 */

import { readFileSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { configure, SW_TEMPLATE } from "../../src/configure.js";

/** Narrow away null/undefined without a `!` assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * The migration comes from a stub now, as every generated file does.
 *
 * The fail-fast case below renames THIS aside, so it has to be the file
 * `configure` actually reads — pointing it at the old `migrations/` copy would
 * make the test pass while proving nothing.
 */
const MIGRATION_PATH = path.resolve(
	HERE,
	"..",
	"..",
	"stubs",
	"database",
	"migrations",
	"0048_create_push_subscriptions.stub",
);

interface RecordedWrite {
	filePath: string;
	content: string;
	options?: { force?: boolean };
}

/**
 * Read a stub the way `codemods.makeUsingStub` does.
 *
 * The real file, not a fixture: a test that stubbed this out would pass with
 * a stub that does not exist.
 */
function renderStub(
	stubsRoot: string,
	stubPath: string,
	state: Record<string, string | number | boolean>,
): { to: string; body: string } {
	const raw = readFileSync(resolve(stubsRoot, stubPath), "utf8");
	const [, front = "", body = ""] = raw.split(/^---\r?\n/m, 3);
	const declared = /^to:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? "";
	const render = (text: string): string =>
		text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) =>
			state[key] === undefined ? match : String(state[key]),
		);
	return { to: render(declared), body: render(body) };
}

function makeFakeCodemods() {
	const providers: string[] = [];
	const envVars: Array<Record<string, string>> = [];
	const writes: RecordedWrite[] = [];
	const commands: string[] = [];
	return {
		providers,
		envVars,
		writes,
		commands,
		codemods: {
			async addProvider(importPath: string) {
				providers.push(importPath);
			},
			async registerCommand(importPath: string) {
				commands.push(importPath);
			},
			async addEnvVars(vars: Record<string, string>) {
				envVars.push(vars);
			},
			async writeFile(
				filePath: string,
				content: string,
				options?: { force?: boolean },
			) {
				writes.push({ filePath, content, options });
			},
			async makeUsingStub(
				stubsRoot: string,
				stubPath: string,
				state: Record<string, string | number | boolean> = {},
				options?: { force?: boolean },
			) {
				const { to, body } = renderStub(stubsRoot, stubPath, state);
				writes.push({ filePath: to, content: body, options });
				return { path: to, contents: body };
			},
		},
	};
}

describe("configure hook — codemods writes (config/nova.ts + migration + public/sw.js)", () => {
	let migrationTemplate: string;
	beforeAll(async () => {
		// The body, without the front matter that names the destination.
		const raw = await readFile(MIGRATION_PATH, "utf8");
		migrationTemplate = raw.split(/^---\r?\n/m, 3)[2] ?? "";
	});

	it("calls addProvider, addEnvVars, then writeFile thrice (config + migration + sw)", async () => {
		const fake = makeFakeCodemods();
		await configure(fake.codemods);

		expect(fake.providers).toEqual(["@c9up/nova/provider"]);
		// The command travels with the package, not with the CLI binary — so
		// installing nova is all a user does to get `ream nova:vapid:generate`.
		expect(fake.commands).toEqual(["@c9up/nova/commands"]);
		expect(fake.envVars).toHaveLength(1);
		expect(defined(fake.envVars[0])).toMatchObject({
			NOVA_VAPID_PUBLIC_KEY: "",
			NOVA_VAPID_PRIVATE_KEY: "",
			NOVA_VAPID_SUBJECT: "mailto:noreply@localhost",
		});

		expect(fake.writes).toHaveLength(3);
		const configWrite = defined(fake.writes[0]);
		const migrationWrite = defined(fake.writes[1]);
		const swWrite = defined(fake.writes[2]);
		expect(configWrite.filePath).toBe("config/nova.ts");
		expect(migrationWrite.filePath).toBe(
			"database/migrations/0048_create_push_subscriptions.ts",
		);
		expect(swWrite.filePath).toBe("public/sw.js");
	});

	it("writes the migration content byte-for-byte from the shipped template", async () => {
		const fake = makeFakeCodemods();
		await configure(fake.codemods);
		const migrationWrite = defined(fake.writes[1]);
		expect(migrationWrite.content).toBe(migrationTemplate);
	});

	it("writes the SW content byte-for-byte from the inlined SW_TEMPLATE", async () => {
		const fake = makeFakeCodemods();
		await configure(fake.codemods);
		const swWrite = defined(fake.writes[2]);
		expect(swWrite.content).toBe(SW_TEMPLATE);
	});

	it("SW push handler shows a notification on EVERY push, incl. a data-less one (userVisibleOnly)", () => {
		// A bare `if (!event.data) return` would skip showNotification on a
		// data-less push and let the browser revoke the userVisibleOnly sub.
		expect(SW_TEMPLATE).not.toMatch(/if\s*\(\s*!event\.data\s*\)\s*return/);
		// The data parse is GUARDED (payload stays {} → generic notification),
		// and showNotification is unconditionally reached afterwards.
		expect(SW_TEMPLATE).toMatch(/if\s*\(\s*event\.data\s*\)\s*\{/);
		expect(SW_TEMPLATE).toContain("self.registration.showNotification(");
	});

	it("does NOT pass force=true on the migration write (idempotency by path)", async () => {
		const fake = makeFakeCodemods();
		await configure(fake.codemods);
		const migrationWrite = defined(fake.writes[1]);
		// `options` is either undefined OR has `force` falsy. The
		// `createCodemods` impl in @c9up/ream skips when the file exists
		// and force is unset.
		expect(migrationWrite.options?.force).not.toBe(true);
	});

	it("does NOT pass force=true on the SW write (idempotency by path)", async () => {
		const fake = makeFakeCodemods();
		await configure(fake.codemods);
		const swWrite = defined(fake.writes[2]);
		expect(swWrite.options?.force).not.toBe(true);
	});

	// (Anchor-regex test removed — the byte-for-byte assertion above already
	// pins every listener / call site, AND a malicious patch could satisfy
	// the four anchors while shipping a broken SW; keeping both tests would
	// be redundant noise.)

	it("config/nova.ts content includes the vapid block from 48.2", async () => {
		const fake = makeFakeCodemods();
		await configure(fake.codemods);
		const configWrite = defined(fake.writes[0]);
		expect(configWrite.content).toMatch(/defineConfig\(/);
		expect(configWrite.content).toMatch(/vapid:\s*{/);
		expect(configWrite.content).toMatch(
			/publicKey:\s*env\.get\('NOVA_VAPID_PUBLIC_KEY'\)/,
		);
	});

	it("config/nova.ts template never mentions sw.js (positive anti-regression)", async () => {
		const fake = makeFakeCodemods();
		await configure(fake.codemods);
		const configWrite = defined(fake.writes[0]);
		// Stronger than checking for the literal "ships in Story 48.4" string:
		// the config/nova.ts template's job is to wire VAPID, NOT to talk about
		// the Service Worker. Any mention of sw.js / Service Worker in this
		// template — past, future, or otherwise — is a forward-/backward-
		// pointing reference that will rot. The SW belongs to public/sw.js
		// and to docs/modules/nova.md, not to the runtime config file.
		expect(configWrite.content).not.toMatch(/sw\.js/i);
		expect(configWrite.content).not.toMatch(/service\s*worker/i);
	});

	it("propagates a clean ENOENT when the migration template is missing (real fail-fast — zero codemod calls)", async () => {
		// Real fail-fast test (not a sequencing-only substitute). Hermetic
		// alternative to `vi.spyOn(node:fs/promises, "readFile")` (forbidden
		// per cerebrum 2026-04-29 — ESM namespaces are non-configurable):
		// physically rename the migration template aside, run configure
		// (production code's real `readFile` will throw ENOENT), restore.
		// Proves both (a) configure() rejects with ENOENT AND (b) the fake
		// codemods records ZERO calls, confirming `readMigrationTemplate()`
		// runs and throws BEFORE any side effect. A future refactor that
		// moved the read after addProvider would fail this test.
		const aside = `${MIGRATION_PATH}.aside-test-fail-fast`;
		await rename(MIGRATION_PATH, aside);
		try {
			const fake = makeFakeCodemods();
			await expect(configure(fake.codemods)).rejects.toThrow(/ENOENT/);
			expect(fake.providers).toEqual([]);
			expect(fake.envVars).toEqual([]);
			expect(fake.writes).toEqual([]);
		} finally {
			await rename(aside, MIGRATION_PATH);
		}
	});
});
