/**
 * Nova — Web Push delivery API.
 *
 * Wraps `web-push@^3.6` with: lazy VAPID validation (first-`push`, not at
 * construction), per-call `vapidDetails` (no global setVapidDetails — keeps
 * Nova instances independent), automatic subscription cleanup on RFC 8030
 * §7.3 gone responses (404/410), and a `PushResult` discriminated union
 * (no per-push throws).
 */

import webpush from "web-push";
import { validateVapidConfig } from "./_internal/vapid-config.js";
import type { NovaVapidConfig } from "./config.js";
import type {
	PushSubscription,
	SubscriptionStore,
} from "./SubscriptionStore.js";

export interface PushPayload {
	title: string;
	body?: string;
	icon?: string;
	url?: string;
	data?: Record<string, unknown>;
	tag?: string;
}

export type PushUrgency = "very-low" | "low" | "normal" | "high";

export interface PushOptions {
	/** Time-to-live in seconds. Default: 60. */
	ttl?: number;
	/** Push service urgency hint. Default: 'normal'. */
	urgency?: PushUrgency;
	/** Topic — replaces prior un-delivered notifications with same topic (RFC 8030 §5.4). Max 32 chars, base64url. */
	topic?: string;
}

export type PushFailureReason =
	| "gone"
	| "rate-limited"
	| "too-large"
	| "rejected"
	| "server-error";

export type PushResult =
	| { ok: true; status: number; endpoint: string }
	| {
			ok: false;
			status: number;
			endpoint: string;
			reason: PushFailureReason;
			cleaned: boolean;
	  };

interface WebPushErrorLike {
	name?: string;
	statusCode?: number;
	endpoint?: string;
	body?: string;
	headers?: Record<string, string>;
}

const DEFAULT_TTL = 60;
const MAX_TOPIC_LENGTH = 32;
const TOPIC_CHARS = /^[A-Za-z0-9_-]+$/;

export class Nova {
	#store: SubscriptionStore;
	#rawVapid: NovaVapidConfig | undefined;
	#validatedVapid: NovaVapidConfig | undefined;

	constructor(
		store: SubscriptionStore,
		vapidConfig: NovaVapidConfig | undefined,
	) {
		this.#store = store;
		this.#rawVapid = vapidConfig;
	}

	async push(
		subscription: PushSubscription,
		payload: PushPayload,
		options: PushOptions = {},
	): Promise<PushResult> {
		const vapid = this.#resolveVapid();
		const endpoint = subscription.endpoint;

		const ttl = resolveTtl(options.ttl);
		const topic = resolveTopic(options.topic);

		const webpushOptions: webpush.RequestOptions = {
			vapidDetails: {
				subject: vapid.subject,
				publicKey: vapid.publicKey,
				privateKey: vapid.privateKey,
			},
			TTL: ttl,
			contentEncoding: "aes128gcm",
		};
		if (options.urgency) webpushOptions.urgency = options.urgency;
		if (topic !== undefined) webpushOptions.topic = topic;

		try {
			const response = await webpush.sendNotification(
				subscription,
				JSON.stringify(payload),
				webpushOptions,
			);
			return { ok: true, status: response.statusCode, endpoint };
		} catch (cause) {
			if (!isWebPushError(cause)) throw cause;
			return await this.#mapError(cause, endpoint);
		}
	}

	async pushToUser(
		userId: string,
		payload: PushPayload,
		options: PushOptions = {},
	): Promise<PushResult[]> {
		const subs = await this.#store.listByUser(userId);
		// Per-subscription error isolation: a thrown error on one device (network
		// failure, JSON.stringify on a non-serializable payload, etc.) MUST NOT
		// abort the fan-out for the others. Promise.allSettled + map-rejections-to
		// -PushResult preserves the documented "every subscription gets a result".
		const settled = await Promise.allSettled(
			subs.map((sub) => this.push(sub, payload, options)),
		);
		return settled.map((outcome, idx) => {
			if (outcome.status === "fulfilled") return outcome.value;
			const endpoint = subs[idx]?.endpoint ?? "";
			console.error(
				`[nova] push to ${hostOf(endpoint)} threw an unexpected error during fan-out`,
				outcome.reason,
			);
			return {
				ok: false,
				status: 0,
				endpoint,
				reason: "server-error",
				cleaned: false,
			};
		});
	}

	#resolveVapid(): NovaVapidConfig {
		if (!this.#validatedVapid) {
			this.#validatedVapid = validateVapidConfig(this.#rawVapid);
		}
		return this.#validatedVapid;
	}

	async #mapError(
		err: WebPushErrorLike,
		endpoint: string,
	): Promise<PushResult> {
		const status = err.statusCode ?? 0;

		if (status === 404 || status === 410) {
			let cleaned = true;
			try {
				await this.#store.delete(endpoint);
			} catch (cleanupErr) {
				cleaned = false;
				console.error(
					`[nova] subscription ${hostOf(endpoint)} returned ${status} (gone) but cleanup failed`,
					cleanupErr,
				);
			}
			return { ok: false, status, endpoint, reason: "gone", cleaned };
		}

		if (status === 413) {
			return {
				ok: false,
				status,
				endpoint,
				reason: "too-large",
				cleaned: false,
			};
		}
		if (status === 429) {
			return {
				ok: false,
				status,
				endpoint,
				reason: "rate-limited",
				cleaned: false,
			};
		}
		if (status === 400 || status === 401 || status === 403) {
			console.warn(
				`[nova] push to ${hostOf(endpoint)} rejected with status ${status}`,
			);
			return {
				ok: false,
				status,
				endpoint,
				reason: "rejected",
				cleaned: false,
			};
		}
		if (status >= 500 && status <= 599) {
			console.error(
				`[nova] push to ${hostOf(endpoint)} failed with server error ${status}`,
			);
			return {
				ok: false,
				status,
				endpoint,
				reason: "server-error",
				cleaned: false,
			};
		}

		return {
			ok: false,
			status,
			endpoint,
			reason: "server-error",
			cleaned: false,
		};
	}
}

function isWebPushError(value: unknown): value is WebPushErrorLike {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { name?: unknown; statusCode?: unknown };
	const looksLikeWebPushByName = candidate.name === "WebPushError";
	const hasNumericStatus = typeof candidate.statusCode === "number";
	// Both signals MUST agree — a foreign object that happens to carry a numeric
	// `statusCode` (some HTTP clients) is NOT a WebPushError; conversely, a real
	// WebPushError without a parsed statusCode (transport-layer failure) gets
	// re-thrown to the caller as a network error per the documented contract.
	return looksLikeWebPushByName && hasNumericStatus;
}

function resolveTtl(input: number | undefined): number {
	if (input === undefined) return DEFAULT_TTL;
	if (
		typeof input !== "number" ||
		!Number.isFinite(input) ||
		!Number.isInteger(input) ||
		input < 0
	) {
		throw new TypeError(
			`[nova] invalid push option \`ttl\`: expected a non-negative integer (seconds), got ${String(input)}`,
		);
	}
	return input;
}

function resolveTopic(input: string | undefined): string | undefined {
	if (input === undefined) return undefined;
	if (typeof input !== "string" || input.length === 0) return undefined;
	if (input.length > MAX_TOPIC_LENGTH || !TOPIC_CHARS.test(input)) {
		throw new TypeError(
			`[nova] invalid push option \`topic\`: expected ≤ ${MAX_TOPIC_LENGTH} chars from the base64url alphabet (RFC 8030 §5.4), got "${input}"`,
		);
	}
	return input;
}

function hostOf(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return "<invalid-endpoint>";
	}
}
