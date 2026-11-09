/**
 * Nova — Web Push delivery API.
 *
 * web-push builds the request — VAPID JWT, aes128gcm encryption, the protocol
 * headers — with per-call `vapidDetails` (no global setVapidDetails, so Nova
 * instances stay independent). It does not send it: web-push's transport
 * follows the endpoint anywhere, reads the whole response into a string and
 * waits without a deadline, and the endpoint is a URL any account chooses.
 * The request goes out through a guarded client instead (see
 * `_internal/http.ts`): non-public addresses refused at connect time, the
 * response read up to {@link MAX_RESPONSE_BYTES}, a deadline on the exchange.
 *
 * Every answer from the endpoint — a status, or no answer in time — is a
 * `PushResult`; 404/410 also delete the subscription (RFC 8030 §7.3).
 * `push()` throws only on misuse: missing/invalid VAPID, invalid `ttl` or
 * `topic`, a non-serialisable payload. `pushToUser()` converts a
 * per-subscription throw into a `PushResult`, so one bad device (or payload)
 * can't abort delivery to the rest.
 */

import webpush from "web-push";
import {
	defaultHttpClient,
	type PushHttpClient,
	transportFailure,
} from "./_internal/http.js";
import {
	type PushTargetPolicy,
	pushTargetProblem,
	type ResolvedPushTargetPolicy,
	resolvePushTargetPolicy,
} from "./_internal/push-services.js";
import { keysProblem } from "./_internal/subscription.js";
import { normaliseUserId } from "./_internal/user-id.js";
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
	/** Not sent: the endpoint is not a push service this app sends to. */
	| "refused"
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
			/**
			 * Seconds the push service asked to wait before the next request to
			 * this endpoint, from its `Retry-After` on a 429 or 503 (capped at a
			 * day). Absent when it sent none, or one that does not parse.
			 */
			retryAfter?: number;
	  };

/** How push requests leave the server. */
export interface NovaDeliveryOptions extends PushTargetPolicy {
	/**
	 * Deadline for one push request — connection, upload and answer — in ms.
	 * Default 10 000. An endpoint that does not answer in time gets a
	 * `server-error` result with status 0.
	 */
	timeout?: number;
	/**
	 * The client requests go through. Default: `HttpClient` from
	 * `@c9up/ream/http-client`, which refuses non-public addresses. Pass one
	 * to route pushes through a proxy, or `fakeHttp()` in tests.
	 */
	http?: PushHttpClient;
}

export type { PushHttpClient } from "./_internal/http.js";
export type { PushTargetPolicy } from "./_internal/push-services.js";

const DEFAULT_TIMEOUT = 10_000;
/**
 * A push service answers with an empty body or a small problem document
 * (RFC 8030 §5, §7); nothing here reads it. The cap only stops an endpoint
 * from streaming into the server's memory.
 */
const MAX_RESPONSE_BYTES = 16 * 1024;
/**
 * RFC 8291 §4: one record of at most 4096 octets, which leaves 3993 for the
 * plaintext (86-octet header, 1 padding delimiter, 16-octet tag).
 */
const MAX_PLAINTEXT_BYTES = 3993;
const DEFAULT_TTL = 60;
const MAX_TOPIC_LENGTH = 32;
const TOPIC_CHARS = /^[A-Za-z0-9_-]+$/;

export class Nova {
	#store: SubscriptionStore;
	#rawVapid: NovaVapidConfig | undefined;
	#validatedVapid: NovaVapidConfig | undefined;
	readonly #timeout: number;
	readonly #targets: ResolvedPushTargetPolicy;
	#http: Promise<PushHttpClient> | undefined;

	constructor(
		store: SubscriptionStore,
		vapidConfig: NovaVapidConfig | undefined,
		delivery: NovaDeliveryOptions = {},
	) {
		this.#store = store;
		this.#rawVapid = vapidConfig;
		this.#timeout = resolveTimeout(delivery.timeout);
		this.#targets = resolvePushTargetPolicy(delivery);
		if (delivery.http !== undefined) {
			this.#http = Promise.resolve(delivery.http);
		}
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

		// Checked again at send time: a row may predate the rule, or the list.
		const refusal = pushTargetProblem(endpoint, this.#targets);
		if (refusal !== null) return refused(endpoint, refusal);
		// Keys nothing can be encrypted for never become deliverable, and no
		// push service will ever answer 410 for them: forget them now.
		const unusable = keysProblem(
			subscription.keys?.p256dh,
			subscription.keys?.auth,
		);
		if (unusable !== null) return await this.#forget(endpoint, 0, unusable);

		const plaintext = JSON.stringify(payload);
		const size = Buffer.byteLength(plaintext);
		if (size > MAX_PLAINTEXT_BYTES) {
			// web-push would split it into several records, which RFC 8291 §4
			// forbids: the push service answers 413, or the browser cannot decrypt.
			console.warn(
				`[nova] push to ${hostOf(endpoint)} not sent: the payload is ${size} bytes, over the ${MAX_PLAINTEXT_BYTES} one record holds`,
			);
			return {
				ok: false,
				status: 0,
				endpoint,
				reason: "too-large",
				cleaned: false,
			};
		}

		const request = webpush.generateRequestDetails(
			subscription,
			plaintext,
			webpushOptions,
		);
		const headers: Record<string, string> = {};
		// web-push types its header values as strings and sets numbers (TTL,
		// Content-Length); the client sets its own content-length.
		for (const [name, value] of Object.entries(request.headers)) {
			if (name.toLowerCase() === "content-length") continue;
			headers[name.toLowerCase()] = String(value);
		}

		const http = await this.#client();
		let status: number;
		let retryAfter: string | undefined;
		try {
			const response = await http.request(endpoint, {
				method: request.method,
				headers,
				body: request.body ?? undefined,
				timeout: this.#timeout,
				maxResponseBytes: MAX_RESPONSE_BYTES,
			});
			status = response.status;
			retryAfter = response.header("retry-after");
		} catch (cause) {
			const failure = transportFailure(cause);
			if (failure === undefined) throw cause;
			if (failure === "privateAddress" || failure === "invalidUrl") {
				return refused(endpoint, `the client refused it (${failure})`);
			}
			console.error(
				`[nova] push to ${hostOf(endpoint)} failed before an answer (${failure})`,
			);
			return {
				ok: false,
				status: 0,
				endpoint,
				reason: "server-error",
				cleaned: false,
			};
		}
		// What web-push treats as delivered: any 2xx (RFC 8030 §5 answers 201).
		if (status >= 200 && status <= 299) return { ok: true, status, endpoint };
		const result = await this.#mapError(status, endpoint);
		// RFC 8030 §8.4 pairs Retry-After with 429; RFC 9110 §10.2.3 with 503.
		if (!result.ok && (status === 429 || status === 503)) {
			const seconds = parseRetryAfter(retryAfter);
			if (seconds !== undefined) result.retryAfter = seconds;
		}
		return result;
	}

	/**
	 * Push to every subscription `userId` has. A number or bigint id is looked
	 * up as its decimal text, which is how the subscribe route stores it.
	 */
	async pushToUser(
		userId: string | number | bigint,
		payload: PushPayload,
		options: PushOptions = {},
	): Promise<PushResult[]> {
		const key = normaliseUserId(userId);
		if (key === undefined) {
			throw new TypeError(
				`[nova] pushToUser: ${String(userId)} is not a user id (a non-empty string or an integer)`,
			);
		}
		const subs = await this.#store.listByUser(key);
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

	#client(): Promise<PushHttpClient> {
		if (this.#http !== undefined) return this.#http;
		const loading = defaultHttpClient({
			allowHosts: [...this.#targets.allowHosts],
		});
		this.#http = loading;
		// A failed load is not kept: installing the peer and retrying works.
		loading.catch(() => {
			if (this.#http === loading) this.#http = undefined;
		});
		return loading;
	}

	#resolveVapid(): NovaVapidConfig {
		if (!this.#validatedVapid) {
			this.#validatedVapid = validateVapidConfig(this.#rawVapid);
		}
		return this.#validatedVapid;
	}

	/** A subscription that will never be delivered: delete it, say whether that worked. */
	async #forget(
		endpoint: string,
		status: number,
		why: string,
	): Promise<PushResult> {
		let cleaned = true;
		try {
			await this.#store.delete(endpoint);
		} catch (cleanupErr) {
			cleaned = false;
			console.error(
				`[nova] subscription ${hostOf(endpoint)} is gone (${why}) but cleanup failed`,
				cleanupErr,
			);
		}
		return { ok: false, status, endpoint, reason: "gone", cleaned };
	}

	async #mapError(status: number, endpoint: string): Promise<PushResult> {
		if (status === 404 || status === 410) {
			return await this.#forget(endpoint, status, `returned ${status}`);
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

/** A day: a push service asking for longer is not one to wait on blindly. */
const MAX_RETRY_AFTER = 86_400;
const HTTP_DATE = /^[A-Za-z]{3,9},? /;

/** `Retry-After` as seconds from now: delta-seconds or an HTTP-date. */
function parseRetryAfter(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) {
		return Math.min(Number(trimmed), MAX_RETRY_AFTER);
	}
	// Date.parse reads almost anything ("12" is a date to it); only a value
	// shaped like an HTTP-date (RFC 9110 §5.6.7) is given to it.
	if (!HTTP_DATE.test(trimmed)) return undefined;
	const at = Date.parse(trimmed);
	if (Number.isNaN(at)) return undefined;
	const seconds = Math.ceil((at - Date.now()) / 1000);
	return Math.min(Math.max(seconds, 0), MAX_RETRY_AFTER);
}

function refused(endpoint: string, why: string): PushResult {
	console.warn(`[nova] push to ${hostOf(endpoint)} not sent: ${why}`);
	return { ok: false, status: 0, endpoint, reason: "refused", cleaned: false };
}

function resolveTimeout(input: number | undefined): number {
	if (input === undefined) return DEFAULT_TIMEOUT;
	if (!Number.isSafeInteger(input) || input <= 0) {
		throw new TypeError(
			`[nova] invalid delivery option \`timeout\`: expected a positive integer (ms), got ${String(input)}`,
		);
	}
	return input;
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
