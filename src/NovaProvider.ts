/**
 * NovaProvider — registers SubscriptionStore + the built-in subscribe route.
 *
 * Lifecycle:
 *   register() — wires the SubscriptionStore singleton (uses
 *                MemorySubscriptionDriver unless `config.nova.store` overrides).
 *   boot()     — resolves the framework Router and registers
 *                `POST {routePrefix}/subscribe`, optionally guarded by the
 *                configured strategy.
 *   shutdown() — no-op; the in-memory driver is GC'd with the container.
 *
 * Typed against the framework's real `AppContext` / `Router` / `HttpContext`
 * via `import type` (erased at runtime) — same SDK and syntax as the host.
 * `@c9up/ream` stays an optional runtime peer (host-provided) and a build-only
 * devDependency for the types, mirroring an AdonisJS extension package.
 */

import type { AppContext, HttpContext, Router } from "@c9up/ream";
import type { NovaConfig } from "./config.js";
import { Nova } from "./Nova.js";
import { SubscribeController } from "./SubscribeController.js";
import {
	MemorySubscriptionDriver,
	type SubscriptionStore,
} from "./SubscriptionStore.js";
import { _setPush } from "./services/main.js";

const SUBSCRIPTION_STORE_TOKEN = "SubscriptionStore";
const NOVA_TOKEN = "nova";

export default class NovaProvider {
	#app: AppContext;
	#config: NovaConfig;

	constructor(app: AppContext) {
		this.#app = app;
		this.#config = {};
	}

	register(): void {
		this.#config = this.#app.config.get<NovaConfig>("nova") ?? {};
		const explicit = this.#config.store;
		const alreadyRegistered =
			this.#app.container.has?.(SUBSCRIPTION_STORE_TOKEN) ?? false;

		// Container precedence: a pre-existing binding wins (apps can register
		// their own driver before booting providers — same pattern as Rover's
		// optional QueueManager). Then the config-provided store. Otherwise
		// fall back to the in-memory driver shipped for dev/tests.
		if (alreadyRegistered) {
			if (explicit) {
				console.warn(
					"[nova] config.nova.store is set but the container already has a SubscriptionStore binding — config value ignored. Remove one source to silence this warning.",
				);
			}
		} else {
			this.#app.container.singleton(SUBSCRIPTION_STORE_TOKEN, () => {
				return explicit ?? new MemorySubscriptionDriver();
			});
		}
		const novaAlreadyRegistered =
			this.#app.container.has?.(NOVA_TOKEN) ?? false;
		if (novaAlreadyRegistered) {
			if (this.#config.vapid) {
				console.warn(
					"[nova] config.nova.vapid is set but the container already has a 'nova' binding — VAPID config ignored. Remove one source to silence this warning.",
				);
			}
		} else {
			const vapidConfig = this.#config.vapid;
			this.#app.container.singleton(NOVA_TOKEN, () => {
				const store = this.#app.container.resolve<SubscriptionStore>(
					SUBSCRIPTION_STORE_TOKEN,
				);
				return new Nova(store, vapidConfig);
			});
		}
	}

	async boot(): Promise<void> {
		_setPush(this.#app.container.resolve<Nova>(NOVA_TOKEN));
		const router = this.#app.container.resolve<Router>("router");
		const rawPrefix = this.#config.routePrefix;
		const trimmedPrefix =
			typeof rawPrefix === "string" ? rawPrefix.replace(/\/+$/, "") : "";
		const prefix = trimmedPrefix.length > 0 ? trimmedPrefix : "/api/nova";
		const path = `${prefix}/subscribe`;
		const store = this.#app.container.resolve<SubscriptionStore>(
			SUBSCRIPTION_STORE_TOKEN,
		);
		const controller = new SubscribeController(store);

		const route = router.post(path, async (ctx: HttpContext) => {
			await controller.handle(ctx);
		});

		const guard = this.#config.guard === undefined ? "jwt" : this.#config.guard;
		if (typeof guard === "string" && guard.length > 0) {
			route.guard(guard);
		}
	}

	async shutdown(): Promise<void> {}
}
