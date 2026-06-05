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

let _instance: Nova | undefined;

/** @internal Bind the singleton (called by NovaProvider). */
export function _setPush(instance: Nova): void {
	_instance = instance;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function _getPush(): Nova | undefined {
	return _instance;
}

const push: Nova = new Proxy({} as Nova, {
	get(_target, prop) {
		if (!_instance) {
			throw new Error(
				"[nova] Nova singleton accessed before NovaProvider.boot() ran. " +
					"Check that `@c9up/nova/provider` is listed in your reamrc.ts providers.",
			);
		}
		const value = Reflect.get(_instance, prop, _instance);
		return typeof value === "function" ? value.bind(_instance) : value;
	},
});

export default push;
