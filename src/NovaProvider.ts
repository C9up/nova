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
 * The provider is structurally typed against an `AppContext`-compatible
 * shape rather than importing `AppContext` from `@c9up/ream` at the type
 * level. Same pattern as Atlas (cerebrum 2026-04-30) — keeps the runtime
 * peer dependency intact while letting the package compile in isolation.
 */

import type { NovaConfig } from "./config.js";
import { NovaError } from "./errors.js";
import { Nova } from "./Nova.js";
import {
	type SubscribeContext,
	SubscribeController,
} from "./SubscribeController.js";
import {
	MemorySubscriptionDriver,
	type SubscriptionStore,
} from "./SubscriptionStore.js";
import { setPush } from "./services/main.js";

const SUBSCRIPTION_STORE_TOKEN = "SubscriptionStore";
const NOVA_TOKEN = "nova";

interface ContainerLike {
	singleton(token: string | symbol, factory: () => unknown): void;
	/**
	 * ASYNC, as it is in ream and in `@adonisjs/fold` — a factory, a provider
	 * or a `resolving` hook may be async, so resolution cannot be synchronous.
	 * Declared sync here, this interface made `NovaAppContext` incompatible with
	 * ream's `AppContext`, and registering the provider failed to typecheck in
	 * every app.
	 */
	resolve<T = unknown>(token: string | symbol): Promise<T>;
	has?(token: string | symbol): boolean;
}

interface ConfigStoreLike {
	get<T = unknown>(key: string): T | undefined;
}

interface RouteBuilderLike {
	guard(...guards: string[]): RouteBuilderLike;
}

interface RouterLike {
	/**
	 * The handler is declared against the slice of the context it reads, not
	 * against `unknown`. Written the other way the handler had to assert its own
	 * argument back into shape — a claim about the framework's context made
	 * inside the one place that cannot check it.
	 */
	post(
		path: string,
		handler: (ctx: SubscribeContext) => unknown,
	): RouteBuilderLike;
}

export interface NovaAppContext {
	container: ContainerLike;
	config: ConfigStoreLike;
}

export default class NovaProvider {
	#app: NovaAppContext;
	#config: NovaConfig;

	constructor(app: NovaAppContext) {
		this.#app = app;
		this.#config = {};
	}

	register(): void {
		this.#config = this.#app.config.get<NovaConfig>("nova") ?? {};
		const explicit = this.#resolveConfiguredStore();
		const alreadyRegistered =
			this.#app.container.has?.(SUBSCRIPTION_STORE_TOKEN) ?? false;

		// Container precedence: a pre-existing binding wins (apps can register
		// their own driver before booting providers — same pattern as Rover's
		// optional QueueManager). Then the config-provided store. Otherwise
		// fall back to the in-memory driver shipped for dev/tests.
		if (alreadyRegistered) {
			if (explicit) {
				console.warn(
					"[nova] a store is configured but the container already has a SubscriptionStore binding — the config is ignored. Remove one source to silence this warning.",
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
			this.#app.container.singleton(NOVA_TOKEN, async () => {
				const store = await this.#app.container.resolve<SubscriptionStore>(
					SUBSCRIPTION_STORE_TOKEN,
				);
				return new Nova(store, vapidConfig);
			});
		}
	}

	/**
	 * The store the config asks for.
	 *
	 * `default` + `stores` first — the multi-store form the other packages use,
	 * and the one an environment variable can steer. A `store` instance is the
	 * single-store form kept for configs written against it. Naming a store that
	 * does not exist throws rather than falling back: an application that meant
	 * to persist subscriptions and silently got the in-memory driver would only
	 * find out when a restart lost them all.
	 */
	#resolveConfiguredStore(): SubscriptionStore | undefined {
		const { default: name, stores, store } = this.#config;
		// A `default` with no `stores` to pick from is the same mistake as a
		// `default` naming an entry that is not there, and it used to land in
		// the opposite place: `stores` undefined skipped the check below, and a
		// deployment that asked for `sql` booted on the in-memory driver — the
		// exact silent fallback this refuses one branch further down.
		if (!stores && store === undefined && name !== undefined && name !== "") {
			throw new NovaError(
				"E_NOVA_UNKNOWN_STORE",
				`config.nova names the store '${name}', but declares no \`stores\` to pick it from.`,
				{
					hint: "Declare it with stores.memory(), stores.file(), stores.sql() or stores.redis(), or pass a ready-made `store` instead.",
				},
			);
		}
		if (stores && name !== undefined) {
			const selected = stores[name];
			if (!selected) {
				const known = Object.keys(stores);
				throw new NovaError(
					"E_NOVA_UNKNOWN_STORE",
					`config.nova names the store '${name}', which is not in \`stores\`.`,
					{
						hint:
							known.length > 0
								? `Declared: ${known.join(", ")}.`
								: "`stores` is empty — declare one with stores.memory(), stores.file(), stores.sql() or stores.redis().",
					},
				);
			}
			return selected();
		}
		if (stores && name === undefined && store === undefined) {
			throw new NovaError(
				"E_NOVA_UNKNOWN_STORE",
				"config.nova declares `stores` but no `default` naming which one to use.",
				{ hint: `Set default to one of: ${Object.keys(stores).join(", ")}.` },
			);
		}
		return store;
	}

	async boot(): Promise<void> {
		setPush(await this.#app.container.resolve<Nova>(NOVA_TOKEN));
		const router = await this.#app.container.resolve<RouterLike>("router");
		const rawPrefix = this.#config.routePrefix;
		const trimmedPrefix =
			typeof rawPrefix === "string" ? rawPrefix.replace(/\/+$/, "") : "";
		const prefix = trimmedPrefix.length > 0 ? trimmedPrefix : "/api/nova";
		const path = `${prefix}/subscribe`;
		const store = await this.#app.container.resolve<SubscriptionStore>(
			SUBSCRIPTION_STORE_TOKEN,
		);
		const controller = new SubscribeController(store);

		const route = router.post(path, async (ctx: SubscribeContext) => {
			await controller.handle(ctx);
		});

		const guard = this.#config.guard === undefined ? "jwt" : this.#config.guard;
		if (typeof guard === "string" && guard.length > 0) {
			route.guard(guard);
		}
	}

	async shutdown(): Promise<void> {}
}
