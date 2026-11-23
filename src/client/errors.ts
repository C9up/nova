/**
 * The errors of nova's browser client, one class per code. Node-free, like
 * the rest of `@c9up/nova/client`.
 */

import { createError, Exception } from "@c9up/flare";

/** The environment has no `navigator.serviceWorker`. */
export const E_NOVA_SERVICE_WORKER_UNSUPPORTED = createError(
	"Service Workers are not supported in this environment. Did you call this from a non-browser context?",
	"E_NOVA_SERVICE_WORKER_UNSUPPORTED",
);

/** The browser refused `pushManager.subscribe()`. */
export const E_NOVA_PUSH_SUBSCRIBE_FAILED = createError<[string, string]>(
	"pushManager.subscribe failed: %s — %s",
	"E_NOVA_PUSH_SUBSCRIBE_FAILED",
);

/**
 * The Nova route refused a subscribe or an unsubscribe. `status` is the
 * status the route answered, `responseBody` its body.
 */
export class E_NOVA_ENDPOINT_REJECTED extends Exception {
	static override code = "E_NOVA_ENDPOINT_REJECTED";

	constructor(
		action: "subscribe" | "unsubscribe",
		response: { status: number; statusText: string },
		public readonly responseBody: string,
	) {
		super(
			`Nova ${action} endpoint responded ${response.status} ${response.statusText}${action === "subscribe" ? " (expected 201)" : ""}`,
			{ status: response.status },
		);
	}
}
