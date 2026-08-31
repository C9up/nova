/**
 * Subscribe controller — `POST {routePrefix}/subscribe`.
 *
 * Validates the incoming `PushSubscription` JSON shape, looks up the
 * authenticated user from `ctx.auth.user.id`, and persists the subscription
 * via the injected `SubscriptionStore`. The auth check itself is performed
 * upstream by the route's `.guard()` (Warden middleware) — by the time this
 * handler runs, `ctx.auth` is either authenticated (guard succeeded) OR the
 * route was registered without a guard (test-only — config sets guard=null).
 */

import { isSubscriptionFields } from "./_internal/subscription.js";
import { NovaError } from "./errors.js";
import type {
	PushSubscription,
	SubscriptionStore,
} from "./SubscriptionStore.js";

/**
 * Structural slice of the framework `HttpContext` this handler touches —
 * declared locally rather than importing the type from `@c9up/ream`, so nova
 * compiles in isolation while keeping the runtime peer intact. Same pattern
 * as NovaProvider's `ContainerLike` / `RouterLike`.
 */
interface HttpContextLike {
	request: { body(): unknown };
	response: { status(code: number): { json(data: unknown): void } };
	auth?: { user?: { id?: string } };
}

export class SubscribeController {
	#store: SubscriptionStore;

	constructor(store: SubscriptionStore) {
		this.#store = store;
	}

	async handle(ctx: HttpContextLike): Promise<void> {
		const subscription = parseSubscription(ctx.request.body());
		if (!subscription) {
			ctx.response.status(400).json({
				error: {
					code: "NOVA_INVALID_SUBSCRIPTION",
					message: "Invalid PushSubscription payload",
					hint: "See https://developer.mozilla.org/docs/Web/API/PushSubscription for the expected shape.",
				},
			});
			return;
		}

		const userId = ctx.auth?.user?.id;
		if (typeof userId !== "string" || userId.length === 0) {
			throw new NovaError(
				"NOVA_MISSING_USER",
				"Subscription handler reached without an authenticated user. Did you disable the guard?",
			);
		}

		await this.#store.save(userId, subscription);
		ctx.response
			.status(201)
			.json({ ok: true, endpoint: subscription.endpoint });
	}
}

/**
 * The posted body as a subscription, or null when it is not one.
 *
 * The shape is unpacked here; what makes the values usable lives in
 * `subscriptionProblem`, which the file store applies to the records it reads
 * back. One set of rules, checked on the way in and on the way out.
 */
function parseSubscription(body: unknown): PushSubscription | null {
	if (typeof body !== "object" || body === null) return null;
	if (!("endpoint" in body) || !("expirationTime" in body)) return null;
	if (!("keys" in body)) return null;
	const { keys } = body;
	if (typeof keys !== "object" || keys === null) return null;

	const fields = {
		endpoint: body.endpoint,
		expirationTime: body.expirationTime,
		p256dh: "p256dh" in keys ? keys.p256dh : undefined,
		auth: "auth" in keys ? keys.auth : undefined,
	};
	if (!isSubscriptionFields(fields)) return null;

	return {
		endpoint: fields.endpoint,
		expirationTime: fields.expirationTime,
		keys: { p256dh: fields.p256dh, auth: fields.auth },
	};
}
