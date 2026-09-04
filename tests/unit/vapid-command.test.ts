import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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

	/**
	 * The line this writes is the private key that signs every push the
	 * application will ever send. Whoever can read it can send notifications as
	 * the application to every one of its subscribers.
	 */
	describe("the file it writes the private key into", () => {
		it("creates .env readable by nobody but its owner", async () => {
			const { command, restore } = makeCommand();
			try {
				await command.run();
			} finally {
				restore();
			}

			// Left to the umask this is 0644 on a default Debian or Alpine
			// image, where every other process in the container can read it.
			const mode = (await stat(join(cwd, ".env"))).mode & 0o777;
			expect(mode.toString(8)).toBe("600");
		});

		it("says so instead when an existing .env is readable beyond its owner", async () => {
			await writeFile(join(cwd, ".env"), "APP_KEY=abc\n");
			await chmod(join(cwd, ".env"), 0o644);

			const { command, logged, restore } = makeCommand();
			try {
				await command.run();
			} finally {
				restore();
			}

			// An existing file's permissions are the deployment's decision, so
			// they are reported rather than quietly changed — but they are not
			// passed over in silence either.
			expect((await stat(join(cwd, ".env"))).mode & 0o777).toBe(0o644);
			const said = logged.join("\n");
			expect(said).toContain("err:");
			expect(said).toContain("644");
			expect(said).toContain("readable beyond its owner");
		});

		it("keeps the key it wrote, permissions aside", async () => {
			const { command, restore } = makeCommand();
			try {
				await command.run();
			} finally {
				restore();
			}

			const body = await readFile(join(cwd, ".env"), "utf8");
			expect(body).toMatch(/^NOVA_VAPID_PRIVATE_KEY=[A-Za-z0-9_-]{43}$/m);
		});
	});
});
