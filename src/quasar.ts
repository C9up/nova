/**
 * Resolving a Redis connection by name, from `@c9up/quasar`.
 *
 * Nova does not depend on quasar: it is an optional peer, and this module never
 * imports it statically — the specifier is built at runtime so the TypeScript
 * build stays free of it too. Same bridge `@c9up/echo` uses, for the same
 * reason and with the same shape.
 *
 * The connection is duck-typed before use rather than asserted: a client
 * missing a command would otherwise fail on the first subscribe, far from the
 * cause.
 */

import { NovaError } from "./errors.js";
import type { SubscriptionRedisClient } from "./RedisSubscriptionStore.js";

/** The slice of quasar's manager this needs: a connection, by name. */
interface ConnectionSource {
	connection(name?: string): unknown;
}

/** The commands the store issues. A client missing one cannot serve it. */
const REQUIRED = [
	"get",
	"set",
	"del",
	"sadd",
	"srem",
	"smembers",
] as const satisfies readonly (keyof SubscriptionRedisClient)[];

function isConnectionSource(value: unknown): value is ConnectionSource {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "connection") === "function"
	);
}

function missingCommands(value: unknown): string[] {
	if (typeof value !== "object" || value === null) return [...REQUIRED];
	return REQUIRED.filter(
		(command) => typeof Reflect.get(value, command) !== "function",
	);
}

/** Resolve the named quasar connection, or say precisely what is missing. */
export async function quasarConnection(
	name?: string,
): Promise<SubscriptionRedisClient> {
	// Built at runtime: a static import would put quasar in nova's build graph,
	// and it is optional.
	const specifier = "@c9up/quasar/services/main";
	let module: { default?: unknown };
	try {
		module = (await import(/* @vite-ignore */ specifier)) as {
			default?: unknown;
		};
	} catch (cause) {
		throw new NovaError(
			"E_NOVA_QUASAR_MISSING",
			"Naming a Redis connection needs @c9up/quasar, which is not installed.",
			{
				hint: "pnpm add @c9up/quasar, or pass a client instead of a connection name.",
				cause,
			},
		);
	}

	const manager = module.default;
	if (!isConnectionSource(manager)) {
		throw new NovaError(
			"E_NOVA_QUASAR_MISSING",
			"@c9up/quasar/services/main does not expose connection(name).",
		);
	}

	const connection = manager.connection(name);
	const missing = missingCommands(connection);
	if (missing.length > 0) {
		throw new NovaError(
			"E_NOVA_REDIS_INCOMPLETE",
			`The quasar connection${name ? ` '${name}'` : ""} is missing ${missing.join(", ")}, which the subscription store issues.`,
		);
	}
	return connection as SubscriptionRedisClient;
}
