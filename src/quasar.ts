/**
 * Resolving a Redis connection by name, from `@c9up/quasar`.
 *
 * The loading, the shape check and the messages are the same in every package
 * that offers a Redis-backed option, so they are vendored rather than written
 * again: `src/vendor/quasarConnection.ts`, generated from one source. What is
 * specific to this package — the commands it issues, and what it does with
 * them — stays here, because that is the part a reader needs.
 */

import { E_NOVA_QUASAR_MISSING, E_NOVA_REDIS_INCOMPLETE } from "./errors.js";
import type { SubscriptionRedisClient } from "./RedisSubscriptionStore.js";
import {
	hasCommands,
	quasarConnection as loadQuasarConnection,
} from "./vendor/quasarConnection.js";

// The commands the store issues. A client missing one cannot serve it.
const REQUIRED = ["get", "evalsha", "script"] as const;

/**
 * The connection is handed over only once it carries every command above.
 */
function isSubscriptionRedisClient(
	value: unknown,
): value is SubscriptionRedisClient {
	return hasCommands(value, REQUIRED);
}

/** The named connection, once it is known to carry what this package issues. */
export async function quasarConnection(
	name?: string,
): Promise<SubscriptionRedisClient> {
	return loadQuasarConnection({
		pkg: "nova",
		name,
		required: REQUIRED,
		isConnection: isSubscriptionRedisClient,
		what: "the subscription store",
		alternative: "or pass a client instead of a connection name",
		raise: (reason, message, cause) =>
			reason === "quasar-missing"
				? new E_NOVA_QUASAR_MISSING([message], { cause })
				: new E_NOVA_REDIS_INCOMPLETE([message], { cause }),
	});
}
