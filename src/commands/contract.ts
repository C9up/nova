/**
 * The console-command contract, declared locally.
 *
 * `@c9up/ream` is an OPTIONAL peer of nova: the package sends Web Push whether
 * or not a framework is present, and a command file that imported the
 * framework would break that promise — the import runs when the module loads,
 * in an application that never installed it.
 *
 * What the console kernel needs is structural: a class carrying `commandName`,
 * `description` and a `run()`, plus the metadata it reads to parse argv into
 * instance properties. The framework's `@flags` decorators build that metadata;
 * the helper below builds the identical shape without them.
 */

export interface CommandOptions {
	/** Boot the application before `run()`. Off — this command only writes a file. */
	startApp?: boolean;
	staysAlive?: boolean;
	allowUnknownFlags?: boolean;
}

export interface FlagMetaData {
	type: "string" | "boolean" | "number" | "array";
	propertyName: string;
	flagName: string;
	description?: string;
	alias: string[];
	default?: string | string[] | number | boolean;
	required: boolean;
}

/** The static side the kernel reads. */
export interface NovaCommandClass {
	new (): { run(): Promise<void> | void };
	commandName: string;
	description: string;
	options?: CommandOptions;
	flags?: readonly FlagMetaData[];
	help?: string | string[];
}

/** `dryRun` → `dry-run`, matching what the framework's decorators produce. */
function dashCase(value: string): string {
	return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function flag(
	propertyName: string,
	type: FlagMetaData["type"],
	options: {
		flagName?: string;
		description?: string;
		alias?: string[];
		default?: FlagMetaData["default"];
		required?: boolean;
	} = {},
): FlagMetaData {
	return {
		type,
		propertyName,
		flagName: options.flagName ?? dashCase(propertyName),
		description: options.description,
		alias: options.alias ?? [],
		default: options.default,
		required: options.required ?? false,
	};
}
