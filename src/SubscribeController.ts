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

import { DEFAULT_MAX_SUBSCRIPTIONS_PER_USER } from "./_internal/per-user-cap.js";
import {
	type PushTargetPolicy,
	pushTargetProblem,
	type ResolvedPushTargetPolicy,
	resolvePushTargetPolicy,
} from "./_internal/push-services.js";
import {
	isSubscriptionFields,
	MAX_ENDPOINT_LENGTH,
} from "./_internal/subscription.js";
import { normaliseUserId } from "./_internal/user-id.js";
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
export interface SubscribeContext {
	request: { body(): unknown };
	response: { status(code: number): { json(data: unknown): void } };
	/**
	 * `id` as the auth layer hands it: a string, or a number or bigint for an
	 * auto-increment key. Stored as text either way.
	 */
	auth?: { user?: { id?: unknown } };
}

export interface SubscribeOptions extends PushTargetPolicy {
	/**
	 * Subscriptions one user may hold. Default 20. Past it, the store evicts
	 * the oldest as part of the save: a user has a handful of devices, and
	 * every subscription is a request the server sends on each notification.
	 */
	maxSubscriptionsPerUser?: number;
}

export class SubscribeController {
	#store: SubscriptionStore;
	readonly #targets: ResolvedPushTargetPolicy;
	readonly #maxPerUser: number;

	/**
	 * @param options The push services an endpoint may point at — the same
	 * `delivery` options `Nova` sends with, so what is accepted here is what
	 * can be delivered — and how many subscriptions a user may hold.
	 */
	constructor(store: SubscriptionStore, options: SubscribeOptions = {}) {
		this.#store = store;
		this.#targets = resolvePushTargetPolicy(options);
		const max =
			options.maxSubscriptionsPerUser ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_USER;
		if (!Number.isSafeInteger(max) || max < 1) {
			throw new TypeError(
				`[nova] invalid option \`maxSubscriptionsPerUser\`: expected a positive integer, got ${String(max)}`,
			);
		}
		this.#maxPerUser = max;
	}

	async handle(ctx: SubscribeContext): Promise<void> {
		const subscription = parseSubscription(ctx.request.body());
		if (!subscription) {
			ctx.response.status(400).json({
				error: {
					code: "E_NOVA_INVALID_SUBSCRIPTION",
					message: "Invalid PushSubscription payload",
					hint: "See https://developer.mozilla.org/docs/Web/API/PushSubscription for the expected shape.",
				},
			});
			return;
		}
		// The endpoint decides where the server sends a request on every push;
		// anything but a push service is refused before it is stored.
		if (pushTargetProblem(subscription.endpoint, this.#targets) !== null) {
			ctx.response.status(400).json({
				error: {
					code: "E_NOVA_INVALID_SUBSCRIPTION",
					message:
						"The endpoint is not a push service this application sends to",
				},
			});
			return;
		}

		const userId = authenticatedUserId(ctx);

		try {
			await this.#store.save(userId, subscription, {
				maxPerUser: this.#maxPerUser,
			});
		} catch (error) {
			if (
				error instanceof NovaError &&
				error.code === "E_NOVA_SUBSCRIPTION_CONFLICT"
			) {
				ctx.response.status(409).json({
					error: { code: error.code, message: error.message },
				});
				return;
			}
			throw error;
		}
		ctx.response
			.status(201)
			.json({ ok: true, endpoint: subscription.endpoint });
	}

	/**
	 * `DELETE {routePrefix}/subscribe` with `{ endpoint }`: detach this
	 * browser from the signed-in account, on logout. Only the caller's own
	 * subscription is removed — the store's `delete` removes an endpoint
	 * whoever holds it, so ownership is checked first, and another user's
	 * endpoint answers 404 exactly like one that does not exist.
	 */
	async unsubscribe(ctx: SubscribeContext): Promise<void> {
		const endpoint = endpointOf(ctx.request.body());
		if (endpoint === undefined) {
			ctx.response.status(400).json({
				error: {
					code: "E_NOVA_INVALID_SUBSCRIPTION",
					message: "Expected { endpoint } naming the subscription to remove",
				},
			});
			return;
		}
		const userId = authenticatedUserId(ctx);
		const held = await this.#store.listByUser(userId);
		if (!held.some((subscription) => subscription.endpoint === endpoint)) {
			ctx.response.status(404).json({
				error: {
					code: "E_NOVA_SUBSCRIPTION_NOT_FOUND",
					message: "No such subscription for this user",
				},
			});
			return;
		}
		await this.#store.delete(endpoint);
		ctx.response.status(200).json({ ok: true, endpoint });
	}
}

/** The signed-in user's id, as the stores key it. */
function authenticatedUserId(ctx: SubscribeContext): string {
	const user = ctx.auth?.user;
	if (user === undefined || user === null) {
		throw new NovaError(
			"E_NOVA_MISSING_USER",
			"Subscription handler reached without an authenticated user. Did you disable the guard?",
		);
	}
	const userId = normaliseUserId(user.id);
	if (userId === undefined) {
		throw new NovaError(
			"E_NOVA_INVALID_USER_ID",
			"The authenticated user has no usable id: expected a non-empty string or an integer.",
		);
	}
	return userId;
}

/** The `endpoint` of an unsubscribe body, or undefined when there is none. */
function endpointOf(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null || !("endpoint" in body)) {
		return undefined;
	}
	const { endpoint } = body;
	if (typeof endpoint !== "string" || endpoint.length === 0) return undefined;
	if (endpoint.length > MAX_ENDPOINT_LENGTH) return undefined;
	return endpoint;
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
