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

import type { HttpContext } from "@c9up/ream";
import { NovaError } from "./errors.js";
import type {
	PushSubscription,
	SubscriptionStore,
} from "./SubscriptionStore.js";

const MAX_ENDPOINT_LENGTH = 2048;
const BASE64URL_CHARS = /^[A-Za-z0-9_-]+$/;
const P256DH_LENGTH_RANGE: readonly [number, number] = [86, 90];
const AUTH_LENGTH_RANGE: readonly [number, number] = [22, 26];

export class SubscribeController {
	#store: SubscriptionStore;

	constructor(store: SubscriptionStore) {
		this.#store = store;
	}

	async handle(ctx: HttpContext): Promise<void> {
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

function isHttpsUrl(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= MAX_ENDPOINT_LENGTH &&
		/^https:\/\//i.test(value)
	);
}

function isBase64UrlInRange(
	value: unknown,
	[min, max]: readonly [number, number],
): value is string {
	return (
		typeof value === "string" &&
		value.length >= min &&
		value.length <= max &&
		BASE64URL_CHARS.test(value)
	);
}

function parseSubscription(body: unknown): PushSubscription | null {
	if (typeof body !== "object" || body === null) return null;
	const candidate = body as Record<string, unknown>;
	const { endpoint, expirationTime, keys } = candidate;
	if (!isHttpsUrl(endpoint)) return null;
	if (expirationTime !== null) {
		if (
			typeof expirationTime !== "number" ||
			!Number.isFinite(expirationTime) ||
			expirationTime < 0
		) {
			return null;
		}
	}
	if (typeof keys !== "object" || keys === null) return null;
	const keyShape = keys as Record<string, unknown>;
	if (!isBase64UrlInRange(keyShape.p256dh, P256DH_LENGTH_RANGE)) return null;
	if (!isBase64UrlInRange(keyShape.auth, AUTH_LENGTH_RANGE)) return null;
	return {
		endpoint,
		expirationTime,
		keys: { p256dh: keyShape.p256dh, auth: keyShape.auth },
	};
}
