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
}

export function defineConfig(config: NovaConfig): NovaConfig {
	return config;
}
