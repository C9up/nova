/**
 * NovaProvider — registers SubscriptionStore + the built-in subscribe route.
 *
 * Lifecycle:
 *   register() — wires the SubscriptionStore singleton (uses
 *                MemorySubscriptionDriver unless `config.nova.store` overrides).
 *   boot()     — publishes the module-level singleton.
 *   start()    — resolves the framework Router and registers
 *                `POST {routePrefix}/subscribe` and its `DELETE` (logout),
 *                optionally guarded by the configured strategy. In `start`,
 *                which is the phase upstream documents for routes.
 *   shutdown() — no-op; the in-memory driver is GC'd with the container.
 *
 * The provider is structurally typed against an `AppContext`-compatible
 * shape rather than importing `AppContext` from `@c9up/ream` at the type
 * level. Same pattern as Atlas (cerebrum 2026-04-30) — keeps the runtime
 * peer dependency intact while letting the package compile in isolation.
 */

import "./augmentations.js";
import type { NovaConfig, NovaRouteMiddleware } from "./config.js";
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
import { clearPush, getPush, setPush } from "./services/main.js";

/** The tokens nova binds, `<pkg>.<name>` like the rest of the cohort. */
const SUBSCRIPTION_STORE_TOKEN = "nova.subscriptions";
const NOVA_TOKEN = "nova.push";
/**
 * The names the same bindings had before, kept resolving to the same
 * instances so an application written against them keeps working.
 */
const LEGACY_SUBSCRIPTION_STORE_TOKEN = "SubscriptionStore";
const LEGACY_NOVA_TOKEN = "nova";

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
	use(...middleware: NovaRouteMiddleware[]): RouteBuilderLike;
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
	delete(
		path: string,
		handler: (ctx: SubscribeContext) => unknown,
	): RouteBuilderLike;
}

export interface NovaAppContext {
	container: ContainerLike;
	config: ConfigStoreLike;
}

export default class NovaProvider {
	/** What this provider bound, so shutdown only clears its own. */
	#owned: Nova | undefined;

	#app: NovaAppContext;
	#config: NovaConfig;

	constructor(app: NovaAppContext) {
		this.#app = app;
		this.#config = {};
	}

	register(): void {
		this.#config = this.#app.config.get<NovaConfig>("nova") ?? {};
		const explicit = this.#resolveConfiguredStore();
		const container = this.#app.container;

		// Container precedence: a pre-existing binding wins (apps can register
		// their own driver before booting providers — same pattern as Rover's
		// optional QueueManager). Then the config-provided store. Otherwise
		// fall back to the in-memory driver shipped for dev/tests.
		const storeBound = this.#bindPair(
			SUBSCRIPTION_STORE_TOKEN,
			LEGACY_SUBSCRIPTION_STORE_TOKEN,
			() => explicit ?? new MemorySubscriptionDriver(),
		);
		if (storeBound && explicit) {
			console.warn(
				"[nova] a store is configured but the container already has a SubscriptionStore binding — the config is ignored. Remove one source to silence this warning.",
			);
		}

		const vapidConfig = this.#config.vapid;
		const delivery = this.#config.delivery;
		const novaBound = this.#bindPair(
			NOVA_TOKEN,
			LEGACY_NOVA_TOKEN,
			async () => {
				const store = await container.resolve<SubscriptionStore>(
					SUBSCRIPTION_STORE_TOKEN,
				);
				return new Nova(store, vapidConfig, delivery);
			},
		);
		if (novaBound && vapidConfig) {
			console.warn(
				"[nova] config.nova.vapid is set but the container already has a 'nova' binding — VAPID config ignored. Remove one source to silence this warning.",
			);
		}
	}

	/**
	 * Bind `factory` under `token`, and `legacy` to whatever `token` resolves
	 * to — one instance under both names. When the application bound either
	 * name first, that binding is kept and the other name points at it.
	 * Answers whether a binding was already there.
	 */
	#bindPair(token: string, legacy: string, factory: () => unknown): boolean {
		const container = this.#app.container;
		const hasToken = container.has?.(token) ?? false;
		const hasLegacy = container.has?.(legacy) ?? false;
		if (hasToken && hasLegacy) return true;
		if (hasToken) {
			container.singleton(legacy, () => container.resolve(token));
			return true;
		}
		if (hasLegacy) {
			container.singleton(token, () => container.resolve(legacy));
			return true;
		}
		container.singleton(token, factory);
		container.singleton(legacy, () => container.resolve(token));
		return false;
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
		// Publishing the singleton is bookkeeping and belongs here; the route is
		// not, and moves to `start()`.
		const nova = await this.#app.container.resolve<Nova>(NOVA_TOKEN);
		this.#owned = nova;
		setPush(nova);
	}

	/**
	 * Mount the subscription endpoint.
	 *
	 * In `start`, which is the phase upstream documents for routes, and the
	 * order is what makes it matter: providers boot, then providers START, then
	 * the preloads run — and the preloads are where an application writes its
	 * own routes. Mounted in `boot`, this landed ahead of every application
	 * route, so an overlapping path was answered here rather than by the app
	 * that meant to override it.
	 */
	async start(): Promise<void> {
		const router = await this.#app.container.resolve<RouterLike>("router");
		const rawPrefix = this.#config.routePrefix;
		const trimmedPrefix =
			typeof rawPrefix === "string" ? rawPrefix.replace(/\/+$/, "") : "";
		const prefix = trimmedPrefix.length > 0 ? trimmedPrefix : "/api/nova";
		const path = `${prefix}/subscribe`;
		const store = await this.#app.container.resolve<SubscriptionStore>(
			SUBSCRIPTION_STORE_TOKEN,
		);
		const controller = new SubscribeController(store, {
			...this.#config.delivery,
			maxSubscriptionsPerUser: this.#config.maxSubscriptionsPerUser,
		});

		const routes = [
			router.post(path, async (ctx: SubscribeContext) => {
				await controller.handle(ctx);
			}),
			// Logout detaches the browser: without it a shared or lost device keeps
			// showing the account's notifications.
			router.delete(path, async (ctx: SubscribeContext) => {
				await controller.unsubscribe(ctx);
			}),
		];

		const guard = this.#config.guard === undefined ? "jwt" : this.#config.guard;
		const middleware = this.#config.middleware ?? [];
		for (const route of routes) {
			if (typeof guard === "string" && guard.length > 0) route.guard(guard);
			if (middleware.length > 0) route.use(...middleware);
		}
	}

	async shutdown(): Promise<void> {
		// Release the module-level singleton, while it is still ours. A stopped
		// application left a dead push service reachable through `services/main`, and
		// with two applications in one process the survivor's binding must not
		// be the one cleared.
		if (this.#owned !== undefined && getPush() === this.#owned) clearPush();
		this.#owned = undefined;
	}
}
