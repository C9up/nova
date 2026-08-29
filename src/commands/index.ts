/**
 * Nova's console commands, as the loader `reamrc.commands` takes.
 *
 * `getMetaData()` answers the list without importing a class, so `ream list`
 * costs nothing; `getCommand()` imports one only when it is about to run. Same
 * shape AdonisJS packages ship.
 *
 * Registered by `configure()` — a user installs the package and the command is
 * there. Nothing is added to the `ream` binary: the CLI dispatches any name it
 * does not own to the application's console kernel.
 */

interface CommandMetaData {
	commandName: string;
	description: string;
}

const COMMANDS: CommandMetaData[] = [
	{
		commandName: "nova:vapid:generate",
		description:
			"Generate a VAPID key pair for Web Push (writes NOVA_VAPID_* into .env)",
	},
];

export async function getMetaData(): Promise<CommandMetaData[]> {
	return COMMANDS;
}

export async function getCommand(metadata: CommandMetaData): Promise<unknown> {
	if (metadata.commandName === "nova:vapid:generate") {
		return (await import("./VapidGenerate.js")).default;
	}
	return null;
}
