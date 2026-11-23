/**
 * The outbound side of a push: what Nova needs from an HTTP client, and the
 * default one.
 *
 * A push endpoint is a URL the browser hands to the server, which means anyone
 * holding an account chooses where the server sends a request. A plain
 * transport follows that URL anywhere, buffers whatever comes back and waits
 * forever. The framework's outbound client refuses non-public addresses at
 * connect time (so a DNS answer cannot change between check and connection),
 * bounds the response and puts a deadline on the whole exchange — so the
 * request Nova builds goes out through that client.
 */

import { E_NOVA_HTTP_CLIENT_MISSING } from "../errors.js";

/** One push request, as Nova builds it (`_internal/webpush.ts`). */
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

/** Why the client gave up. */
export type TransportFailure =
	| "invalidUrl"
	| "privateAddress"
	| "unreachable"
	| "timedOut"
	| "tooLarge"
	| "redirect";

/** The code each failure carries in `@c9up/ream`'s HTTP client. */
const FAILURE_BY_CODE: Readonly<Record<string, TransportFailure>> = {
	E_HTTP_CLIENT_INVALID_URL: "invalidUrl",
	E_HTTP_CLIENT_PRIVATE_ADDRESS: "privateAddress",
	E_HTTP_CLIENT_UNREACHABLE: "unreachable",
	E_HTTP_CLIENT_TIMED_OUT: "timedOut",
	E_HTTP_CLIENT_TOO_LARGE: "tooLarge",
	E_HTTP_CLIENT_REDIRECT_REFUSED: "redirect",
};

/**
 * Why `@c9up/ream`'s HTTP client gave up, read from its `E_HTTP_CLIENT_*`
 * code, or undefined for any other error. Read structurally: the client lives
 * in an optional peer, and an injected client may come from a different copy
 * of it.
 */
export function transportFailure(error: unknown): TransportFailure | undefined {
	if (!(error instanceof Error)) return undefined;
	const code: unknown = Reflect.get(error, "code");
	if (typeof code !== "string" || !Object.hasOwn(FAILURE_BY_CODE, code))
		return undefined;
	return FAILURE_BY_CODE[code];
}

export interface DefaultClientOptions {
	/** Exempt from the public-address rule — `host` or `host:port`, dev only. */
	allowHosts?: string[];
}

/** The options Nova builds the framework's client with. */
export interface GuardedClientOptions {
	maxRedirects: number;
	userAgent: string;
	allowHosts?: string[] | undefined;
}

/** What Nova needs from `@c9up/ream/http-client`: its client class. */
export interface GuardedClientModule {
	HttpClient: new (options: GuardedClientOptions) => unknown;
}

/** Imports a module by specifier; `import()` itself outside of tests. */
export type ModuleLoader = (specifier: string) => Promise<unknown>;

/**
 * Held in a variable so neither the compiler nor a bundler resolves it ahead
 * of time: the peer may be missing, or older than the release that added this
 * entry point, and only the first push should find that out.
 */
const GUARDED_CLIENT_MODULE: string = "@c9up/ream/http-client";

const importModule: ModuleLoader = (specifier) => import(specifier);

function isGuardedClientModule(value: unknown): value is GuardedClientModule {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "HttpClient") === "function"
	);
}

function isPushHttpClient(value: unknown): value is PushHttpClient {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "request") === "function"
	);
}

function missingClient(
	detail: string,
	cause?: unknown,
): E_NOVA_HTTP_CLIENT_MISSING {
	return new E_NOVA_HTTP_CLIENT_MISSING(
		detail,
		cause === undefined ? undefined : { cause },
	);
}

/**
 * The framework's guarded client, loaded on first push.
 *
 * Imported lazily because `@c9up/ream` is an optional peer: the stores, the
 * browser helpers and key generation work without it, and only sending needs
 * an outbound client. Without it — or with a copy that does not have the
 * client — sending fails with `E_NOVA_HTTP_CLIENT_MISSING`; it never falls
 * back to a transport that would reach private addresses.
 */
export async function defaultHttpClient(
	options: DefaultClientOptions,
	load: ModuleLoader = importModule,
): Promise<PushHttpClient> {
	let loaded: unknown;
	try {
		loaded = await load(GUARDED_CLIENT_MODULE);
	} catch (cause) {
		throw missingClient("which is not installed", cause);
	}
	if (!isGuardedClientModule(loaded)) {
		throw missingClient("but the installed copy does not export `HttpClient`");
	}
	let client: unknown;
	try {
		client = new loaded.HttpClient({
			// A push service never redirects; following one would let an endpoint
			// bounce the request to a host that was never checked as a push service.
			maxRedirects: 0,
			userAgent: "@c9up/nova",
			allowHosts: options.allowHosts,
		});
	} catch (cause) {
		throw missingClient("but the installed copy could not build one", cause);
	}
	if (!isPushHttpClient(client)) {
		throw missingClient("but the installed copy built one without `request()`");
	}
	return client;
}
