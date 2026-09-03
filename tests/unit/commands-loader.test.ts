/**
 * The command loader, as `reamrc.commands` consumes it.
 *
 * `getMetaData()` has to answer without importing a command class — that is
 * what keeps `ream list` cheap — and `getCommand()` imports one only when it is
 * about to run. A name the package does not own comes back as null so the CLI
 * can keep looking.
 */
import { describe, expect, it } from "vitest";
import { getCommand, getMetaData } from "../../src/commands/index.js";

/** Narrow away null/undefined without a `!` assertion (which lies to the compiler). */
function defined<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected a defined value");
	return value;
}

describe("nova > the command loader", () => {
	it("lists the commands with their names and descriptions", async () => {
		const metadata = await getMetaData();

		expect(metadata).toEqual([
			{
				commandName: "nova:vapid:generate",
				description: expect.stringContaining("VAPID"),
			},
		]);
	});

	it("resolves a command class only when asked for one", async () => {
		const metadata = defined((await getMetaData())[0]);
		const command = await getCommand(metadata);

		expect(command).not.toBeNull();
		expect(typeof command).toBe("function");
		expect(Reflect.get(command ?? {}, "commandName")).toBe(
			"nova:vapid:generate",
		);
	});

	it("answers null for a name it does not own", async () => {
		// Not an error: the CLI dispatches any name a package does not claim to
		// the next loader, so claiming one by accident would swallow it.
		expect(
			await getCommand({ commandName: "make:controller", description: "" }),
		).toBeNull();
	});
});
