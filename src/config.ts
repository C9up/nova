import type { SubscriptionStore } from "./SubscriptionStore.js";

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
	/** Optional override for the SubscriptionStore. Default: in-memory driver. */
	store?: SubscriptionStore;
	/** VAPID identity. Required for `nova.push()`; subscription-side endpoints work without it. */
	vapid?: NovaVapidConfig;
}

export function defineConfig(config: NovaConfig): NovaConfig {
	return config;
}
