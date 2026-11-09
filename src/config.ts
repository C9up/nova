import type { NovaDeliveryOptions } from "./Nova.js";
import type { SubscriptionStore } from "./SubscriptionStore.js";
import type { SubscriptionStoreFactory } from "./stores.js";

export interface NovaVapidConfig {
	/** Base64url-encoded uncompressed P-256 public point (87 chars, no padding). */
	publicKey: string;
	/** Base64url-encoded raw 32-byte ECDH scalar (43 chars, no padding). */
	privateKey: string;
	/** VAPID subject — `mailto:` address or `https://` URL identifying the application. */
	subject: string;
}

export interface NovaConfig {
	/** Route prefix for built-in endpoints. Default: '/api/nova'. */
	routePrefix?: string;
	/** Warden guard strategy. Default: 'jwt'. Set to null to disable auth (test-only). */
	guard?: string | null;
	/**
	 * Which named store to use — the key of a {@link stores} entry. Read from
	 * the environment in the generated config, so a deployment picks its backend
	 * without editing a file.
	 */
	default?: string;
	/**
	 * The stores this application can use, by name. Each is a factory from
	 * `stores.*`, built only when it is the one selected.
	 */
	stores?: Record<string, SubscriptionStoreFactory>;
	/**
	 * A ready-made store instance.
	 *
	 * The single-store form, kept for applications written against it: prefer
	 * `default` + `stores`, which is how the other packages configure a
	 * pluggable backend and what lets the environment choose. Ignored when
	 * `stores` names the selected store.
	 */
	store?: SubscriptionStore;
	/** VAPID identity. Required for `nova.push()`; subscription-side endpoints work without it. */
	vapid?: NovaVapidConfig;
	/** How push requests leave the server: deadline, push services, client. */
	delivery?: NovaDeliveryOptions;
	/**
	 * Subscriptions one user may hold; the oldest go past it. Default 20.
	 */
	maxSubscriptionsPerUser?: number;
	/**
	 * Middleware run before the subscribe route's handler — a rate limit, so
	 * one account cannot write subscriptions as fast as it can post:
	 * `middleware: [throttle]` with a limiter from `@c9up/blackhole/limiter`.
	 */
	middleware?: NovaRouteMiddleware[];
}

/** A route middleware, as the router's `use()` takes it. */
export type NovaRouteMiddleware = (
	ctx: never,
	next: () => Promise<void>,
) => Promise<void> | void;

export function defineConfig(config: NovaConfig): NovaConfig {
	return config;
}
