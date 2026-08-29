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

	function makeCommand(force = false) {
		const logged: string[] = [];
		const command = new VapidGenerate();
		Object.assign(command, {
			force,
			logger: {
				success: (m: string) => logged.push(`success:${m}`),
				info: (m: string) => logged.push(`info:${m}`),
				error: (m: string) => logged.push(`error:${m}`),
			},
		});
		return { command, logged };
	}

	it("writes both keys into a .env that does not exist yet", async () => {
		const { command, logged } = makeCommand();
		await command.run();

		const env = await readFile(join(cwd, ".env"), "utf8");
		expect(env).toMatch(/^NOVA_VAPID_PUBLIC_KEY=.+$/m);
		expect(env).toMatch(/^NOVA_VAPID_PRIVATE_KEY=.+$/m);
		expect(logged.some((l) => l.startsWith("success:"))).toBe(true);
	});

	it("refuses to overwrite an existing private key, and says why", async () => {
		await writeFile(join(cwd, ".env"), "NOVA_VAPID_PRIVATE_KEY=already\n");
		const { command, logged } = makeCommand();
		await command.run();

		// Losing the private key invalidates every live subscription, so the
		// refusal has to say that rather than just "already set".
		expect(command.exitCode).toBe(1);
		expect(logged.join("\n")).toMatch(/stops working/);
		expect(await readFile(join(cwd, ".env"), "utf8")).toContain("already");
	});

	it("overwrites with --force, replacing the line rather than adding a second", async () => {
		await writeFile(join(cwd, ".env"), "OTHER=x\nNOVA_VAPID_PRIVATE_KEY=old\n");
		const { command } = makeCommand(true);
		await command.run();

		const env = await readFile(join(cwd, ".env"), "utf8");
		expect(env).toContain("OTHER=x");
		expect(env).not.toContain("old");
		// Two lines for one variable would leave the file with two answers.
		expect(env.match(/NOVA_VAPID_PRIVATE_KEY=/g)).toHaveLength(1);
	});
});
