/**
 * The outbound side of a push: what Nova needs from an HTTP client, and the
 * default one.
 *
 * A push endpoint is a URL the browser hands to the server, which means anyone
 * holding an account chooses where the server sends a request. web-push's own
 * transport follows that URL anywhere, buffers whatever comes back into one
 * string and waits forever. The framework's outbound client refuses
 * non-public addresses at connect time (so a DNS answer cannot change between
 * check and connection), bounds the response and puts a deadline on the whole
 * exchange — so the request is built by web-push and sent through that client.
 */

import { NovaError } from "../errors.js";

/** One push request, as web-push builds it. */
export interface PushHttpRequest {
	method: string;
	headers: Record<string, string>;
	body?: Uint8Array;
	/** Deadline for the whole exchange, in ms. */
	timeout?: number;
	/** Largest response body read before the connection is dropped. */
	maxResponseBytes?: number;
}

/** What Nova reads from the answer: the status and a header or two. */
export interface PushHttpResponse {
	readonly status: number;
	header(name: string): string | undefined;
}

/**
 * The client a push goes through. `HttpClient` from `@c9up/ream/http-client`
 * satisfies it, and so does its test fake (`fakeHttp()`).
 */
export interface PushHttpClient {
	request(url: string, options: PushHttpRequest): Promise<PushHttpResponse>;
}

/** Why the client gave up, as `HttpClientError.reason` names it. */
export type TransportFailure =
	| "invalidUrl"
	| "privateAddress"
	| "unreachable"
	| "timedOut"
	| "tooLarge"
	| "redirect";

/**
 * The reason carried by an `HttpClientError`, or undefined for anything else.
 * Read structurally: the class lives in an optional peer, and an injected
 * client may come from a different copy of it.
 */
export function transportFailure(error: unknown): TransportFailure | undefined {
	if (!(error instanceof Error) || error.name !== "HttpClientError") {
		return undefined;
	}
	const reason: unknown = Reflect.get(error, "reason");
	switch (reason) {
		case "invalidUrl":
		case "privateAddress":
		case "unreachable":
		case "timedOut":
		case "tooLarge":
		case "redirect":
			return reason;
		default:
			return undefined;
	}
}

export interface DefaultClientOptions {
	/** Exempt from the public-address rule — `host` or `host:port`, dev only. */
	allowHosts?: string[];
}

/**
 * The framework's guarded client, loaded on first push.
 *
 * Imported lazily because `@c9up/ream` is an optional peer: the stores, the
 * browser helpers and key generation work without it, and only sending needs
 * an outbound client.
 */
export async function defaultHttpClient(
	options: DefaultClientOptions,
): Promise<PushHttpClient> {
	let loaded: typeof import("@c9up/ream/http-client");
	try {
		loaded = await import("@c9up/ream/http-client");
	} catch (cause) {
		throw new NovaError(
			"E_NOVA_HTTP_CLIENT_MISSING",
			"Sending a push needs the outbound HTTP client from @c9up/ream, which is not installed.",
			{
				hint: "Install @c9up/ream, or pass your own client as `http` in the Nova options.",
				cause,
			},
		);
	}
	return new loaded.HttpClient({
		// A push service never redirects; following one would let an endpoint
		// bounce the request to a host that was never checked as a push service.
		maxRedirects: 0,
		userAgent: "@c9up/nova",
		allowHosts: options.allowHosts,
	});
}
