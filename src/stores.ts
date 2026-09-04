/**
 * The store factories a config file names — `{ default, stores }`.
 *
 * The shape a package takes when several backends are declared and one is
 * selected: a `stores` namespace of factories imported beside `defineConfig`,
 * each entry the factory's result, and the selection read from the environment.
 *
 *   import { defineConfig, stores } from '@c9up/nova'
 *
 *   export default defineConfig({
 *     default: env.get('NOVA_STORE'),
 *     stores: {
 *       memory: stores.memory(),
 *       file:   stores.file({ path: 'storage/push_subscriptions.json' }),
 *       sql:    stores.sql({ connection: () => app.container.resolve('db') }),
 *       redis:  stores.redis({ connection: 'main' }),
 *     },
 *   })
 *
 * Factories are lazy: only the store an application actually uses is built, so
 * naming a Redis store in a config that runs on the file store costs nothing.
 */

import { FileSubscriptionStore } from "./FileSubscriptionStore.js";
import { quasarConnection } from "./quasar.js";
import {
	RedisSubscriptionStore,
	type SubscriptionRedisResolver,
} from "./RedisSubscriptionStore.js";
import {
	SqlSubscriptionStore,
	type SubscriptionDatabaseResolver,
} from "./SqlSubscriptionStore.js";
import {
	MemorySubscriptionDriver,
	type SubscriptionStore,
} from "./SubscriptionStore.js";

/** A store, built on first use. */
export type SubscriptionStoreFactory = () => SubscriptionStore;

export const stores = {
	/** In memory. Forgets everything on restart — for tests and dev. */
	memory(): SubscriptionStoreFactory {
		return () => new MemorySubscriptionDriver();
	},

	/** One JSON file. Single process; see the README for why. */
	file(options: { path: string }): SubscriptionStoreFactory {
		return () => new FileSubscriptionStore(options.path);
	},

	/** The `push_subscriptions` table the configure migration creates. */
	sql(options: {
		connection: SubscriptionDatabaseResolver;
		table?: string;
	}): SubscriptionStoreFactory {
		return () =>
			new SqlSubscriptionStore(options.connection, { table: options.table });
	},

	/**
	 * Redis. `connection` takes a client, a function answering one, or the NAME
	 * of a `@c9up/quasar` connection — the last of which is resolved at runtime
	 * without nova importing quasar, which stays an optional peer.
	 */
	redis(options: {
		connection: SubscriptionRedisResolver | string;
		prefix?: string;
	}): SubscriptionStoreFactory {
		// Bound to a `const` before the closure: a property read does not stay
		// narrowed inside one, which is what an assertion was papering over.
		const { connection, prefix } = options;
		const client: SubscriptionRedisResolver =
			typeof connection === "string"
				? () => quasarConnection(connection)
				: connection;
		return () => new RedisSubscriptionStore(client, { prefix });
	},
};
