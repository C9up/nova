/**
 * Browser-side Nova helpers — Service Worker registration + push subscription.
 *
 * Strict no `node:` imports; this module compiles for the browser bundle and
 * is exposed via the `@c9up/nova/client` sub-path so the SSR/Node side
 * (which imports `@c9up/nova/provider`) doesn't accidentally pull it in.
 */

import { decodeBase64Url } from "../_internal/base64url.js";

export interface SubscribeOptions {
	/** Endpoint to POST the subscription to. Default: `/api/nova/subscribe`. */
	endpoint?: string;
	/** Fetch credentials. Default: `'include'` (cookie/JWT carried automatically). */
	credentials?: RequestCredentials;
	/**
	 * Extra request headers (merged on top of `content-type: application/json`).
	 * Use this when the subscribe route is guarded by JWT-in-Authorization or
	 * an API-key header, since `credentials: 'include'` only ships cookies.
	 */
	headers?: HeadersInit;
	/**
	 * Shorthand for `Authorization: Bearer <accessToken>`. Ignored if `headers`
	 * already carries an `authorization` entry. Provide this when the route's
	 * default guard is `jwt` (Nova's out-of-the-box default) and the app stores
	 * its access token outside cookies.
	 */
	accessToken?: string;
}

export interface RegisterServiceWorkerOptions {
	/** Service Worker scope. Default: `'/'`. Override for sub-path apps. */
	scope?: string;
}

export class NovaClientError extends Error {
	readonly status?: number;
	readonly responseBody?: string;

	constructor(
		message: string,
		options?: { status?: number; responseBody?: string },
	) {
		super(message);
		this.name = "NovaClientError";
		this.status = options?.status;
		this.responseBody = options?.responseBody;
	}
}

/**
 * Register a Service Worker. Returns the `ServiceWorkerRegistration` so the
 * caller can chain `.update()`, listen for `updatefound`, etc.
 *
 * Throws if the browser does not expose `navigator.serviceWorker` — by
 * design, callers handle the unsupported-browser path explicitly.
 */
export async function registerServiceWorker(
	path = "/sw.js",
	options: RegisterServiceWorkerOptions = {},
): Promise<ServiceWorkerRegistration> {
	if (typeof navigator === "undefined" || !navigator.serviceWorker) {
		throw new NovaClientError(
			"Service Workers are not supported in this environment. Did you call this from a non-browser context?",
		);
	}
	return navigator.serviceWorker.register(path, {
		scope: options.scope ?? "/",
	});
}

/**
 * Run the full Web Push subscription dance:
 *  1. Wait for the active Service Worker registration.
 *  2. Call `pushManager.subscribe({ userVisibleOnly, applicationServerKey })`.
 *  3. POST the resulting `PushSubscription.toJSON()` to the Nova endpoint.
 *
 * Returns the `PushSubscription` on success; throws `NovaClientError` on a
 * non-2xx HTTP response or a missing browser API.
 */
export async function subscribe(
	vapidPublicKey: string,
	options: SubscribeOptions = {},
): Promise<PushSubscription> {
	if (typeof navigator === "undefined" || !navigator.serviceWorker) {
		throw new NovaClientError(
			"Service Workers are not supported in this environment.",
		);
	}
	const registration = await navigator.serviceWorker.ready;
	// Copy into a fresh ArrayBuffer-backed view: the DOM type for
	// `applicationServerKey` (lib.dom 5.7+) requires `ArrayBuffer`, not the
	// wider `ArrayBufferLike` returned by our environment-agnostic decoder.
	const decoded = urlBase64ToUint8Array(vapidPublicKey);
	const applicationServerKey = new Uint8Array(decoded.length);
	applicationServerKey.set(decoded);
	let pushSubscription: PushSubscription;
	try {
		pushSubscription = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey,
		});
	} catch (cause) {
		const name = cause instanceof Error ? cause.name : "UnknownError";
		const message = cause instanceof Error ? cause.message : String(cause);
		throw new NovaClientError(
			`pushManager.subscribe failed: ${name} — ${message}`,
		);
	}

	const target = options.endpoint ?? "/api/nova/subscribe";
	const credentials = options.credentials ?? "include";
	const headers = new Headers(options.headers);
	if (!headers.has("content-type")) {
		headers.set("content-type", "application/json");
	}
	if (options.accessToken && !headers.has("authorization")) {
		headers.set("authorization", `Bearer ${options.accessToken}`);
	}
	const response = await fetch(target, {
		method: "POST",
		credentials,
		headers,
		body: JSON.stringify(pushSubscription.toJSON()),
	});
	if (response.status !== 201) {
		const responseBody = await response.text().catch(() => "");
		throw new NovaClientError(
			`Nova subscribe endpoint responded ${response.status} ${response.statusText} (expected 201)`,
			{ status: response.status, responseBody },
		);
	}
	return pushSubscription;
}

/**
 * Convert a base64url VAPID public key to the `Uint8Array` shape required
 * by `applicationServerKey`. Browser equivalent of `decodeBase64Url`; kept
 * exported so callers writing custom subscribe flows can reuse it.
 */
export function urlBase64ToUint8Array(base64url: string): Uint8Array {
	return decodeBase64Url(base64url.trim());
}
