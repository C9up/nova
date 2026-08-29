import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import VapidGenerate from "../../src/commands/VapidGenerate.js";

/**
 * The command lives in the package, not in the `ream` binary. Installing nova
 * is all a user does to get it — the CLI dispatches any name it does not own
 * to the application's console kernel.
 */
describe("nova:vapid:generate", () => {
	let cwd: string;
	let previous: string;

	beforeEach(async () => {
		previous = process.cwd();
		cwd = await mkdtemp(join(tmpdir(), "nova-vapid-"));
		process.chdir(cwd);
	});

	afterEach(() => {
		process.chdir(previous);
	});

	/**
	 * The command writes to the process streams rather than to an injected
	 * logger: `@c9up/ream` is an optional peer, so nothing here may assume the
	 * framework is installed. Capture the streams, and restore them after.
	 */
	function makeCommand(force = false) {
		const logged: string[] = [];
		const command = new VapidGenerate();
		command.force = force;

		const stdout = process.stdout.write.bind(process.stdout);
		const stderr = process.stderr.write.bind(process.stderr);
		const capture =
			(prefix: string) =>
			(chunk: string | Uint8Array): boolean => {
				logged.push(`${prefix}:${String(chunk)}`);
				return true;
			};
		process.stdout.write = capture("out");
		process.stderr.write = capture("err");
		const restore = () => {
			process.stdout.write = stdout;
			process.stderr.write = stderr;
		};

		return { command, logged, restore };
	}

	it("writes both keys into a .env that does not exist yet", async () => {
		const { command, logged, restore } = makeCommand();
		await command.run();
		restore();

		const env = await readFile(join(cwd, ".env"), "utf8");
		expect(env).toMatch(/^NOVA_VAPID_PUBLIC_KEY=.+$/m);
		expect(env).toMatch(/^NOVA_VAPID_PRIVATE_KEY=.+$/m);
		expect(logged.join("\n")).toContain("NOVA_VAPID_PUBLIC_KEY");
	});

	it("refuses to overwrite an existing private key, and says why", async () => {
		await writeFile(join(cwd, ".env"), "NOVA_VAPID_PRIVATE_KEY=already\n");
		const { command, logged, restore } = makeCommand();
		const previousExit = process.exitCode;
		await command.run();
		restore();

		// Losing the private key invalidates every live subscription, so the
		// refusal has to say that rather than just "already set".
		expect(process.exitCode).toBe(1);
		process.exitCode = previousExit;
		expect(logged.join("\n")).toMatch(/stops working/);
		expect(await readFile(join(cwd, ".env"), "utf8")).toContain("already");
	});

	it("overwrites with --force, replacing the line rather than adding a second", async () => {
		await writeFile(join(cwd, ".env"), "OTHER=x\nNOVA_VAPID_PRIVATE_KEY=old\n");
		const { command, restore } = makeCommand(true);
		await command.run();
		restore();

		const env = await readFile(join(cwd, ".env"), "utf8");
		expect(env).toContain("OTHER=x");
		expect(env).not.toContain("old");
		// Two lines for one variable would leave the file with two answers.
		expect(env.match(/NOVA_VAPID_PRIVATE_KEY=/g)).toHaveLength(1);
	});
});
