/**
 * Default `Nova` singleton — Adonis-style ergonomic access.
 *
 *   import push from '@c9up/nova/services/main'
 *
 *   await push.pushToUser(userId, { title: 'New task', body: task.title })
 *
 * Populated by `NovaProvider.boot()`.
 */

import type { Nova } from "../Nova.js";

let instance: Nova | undefined;

/** @internal Bind the singleton (called by NovaProvider). */
export function setPush(value: Nova): void {
	instance = value;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function getPush(): Nova | undefined {
	return instance;
}

const push: Nova = new Proxy({} as Nova, {
	get(_target, prop) {
		// A module loader inspects what it imports before anyone uses it: it reads
		// `then` to decide whether the namespace is thenable, and various symbols
		// for interop and formatting. Throwing on those turns a plain
		// `import { setX } from ".../services/main"` into a crash at import time,
		// far from any real use. They are not members of what this stands in for,
		// so answer undefined and let a genuine access be the one that reports.
		if (typeof prop === "symbol" || prop === "then") {
			return undefined;
		}
		if (!instance) {
			throw new Error(
				"[nova] Nova singleton accessed before NovaProvider.boot() ran. " +
					"Check that `@c9up/nova/provider` is listed in your reamrc.ts providers.",
			);
		}
		const value = Reflect.get(instance, prop, instance);
		return typeof value === "function" ? value.bind(instance) : value;
	},
});

export default push;
