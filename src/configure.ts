import { access, constants } from "node:fs/promises";
import { resolve } from "node:path";
import { stubsRoot } from "./stubs.js";

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	registerCommand(importPath: string): Promise<void>;
	addEnvVars(vars: Record<string, string>): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
	makeUsingStub(
		stubsRoot: string,
		stubPath: string,
		state?: Record<string, string | number | boolean>,
		options?: { force?: boolean },
	): Promise<{ path: string; contents: string }>;
}

/**
 * The stub the migration comes from.
 *
 * Named here rather than inline so the check below and the call further down
 * cannot drift apart.
 */
const MIGRATION_STUB =
	"database/migrations/0048_create_push_subscriptions.stub";

export async function configure(codemods: Codemods): Promise<void> {
	// Fail-fast BEFORE any side effect on the user's project. If the package's
	// stub is missing or unreadable (corrupt install, pruned tarball,
	// EISDIR/EACCES on a weird volume), abort here rather than leave a
	// half-configured project: provider registered, .env stubbed,
	// config/nova.ts written — and no migration.
	await access(resolve(stubsRoot, MIGRATION_STUB), constants.R_OK);

	await codemods.addProvider("@c9up/nova/provider");
	// The command belongs to the package, so installing the package is all a
	// user does — nothing is added to the `ream` binary for it.
	await codemods.registerCommand("@c9up/nova/commands");
	await codemods.addEnvVars({
		NOVA_STORE: "memory",
		NOVA_VAPID_PUBLIC_KEY: "",
		NOVA_VAPID_PRIVATE_KEY: "",
		NOVA_VAPID_SUBJECT: "mailto:noreply@localhost",
	});
	await codemods.makeUsingStub(stubsRoot, "config/nova.stub");

	// 48.3 — Atlas durable driver migration template.
	//
	// `writeFile` is idempotent on the exact path (createCodemods returns
	// early when the target already exists and `force` is unset), so re-runs
	// are safe. The Codemods API does NOT expose a glob/list so the filename
	// is stable rather than timestamp-prefixed-by-app-convention; users who
	// prefer their own prefix style can rename the file post-write.
	await codemods.makeUsingStub(stubsRoot, MIGRATION_STUB);

	// 48.4 — Service Worker scaffold, from `stubs/public/sw.stub` — the one
	// copy. Idempotent on path: re-running configure preserves user edits to
	// `public/sw.js` (same contract as `config/nova.ts` and the migration).
	await codemods.makeUsingStub(stubsRoot, "public/sw.stub");
}
