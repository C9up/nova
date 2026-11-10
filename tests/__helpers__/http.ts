/**
 * An outbound client that never touches the network, built on Nova's own
 * `PushHttpClient` contract so the suite does not depend on which release of
 * the optional `@c9up/ream` peer is installed.
 */

import type {
	PushHttpClient,
	PushHttpRequest,
	PushHttpResponse,
	TransportFailure,
} from "../../src/_internal/http.js";

/** A request the fake received, with the options Nova sent it with. */
export interface RecordedPushRequest {
	method: string;
	url: string;
	headers: Readonly<Record<string, string>>;
	body: Buffer | undefined;
	timeout: number | undefined;
	maxResponseBytes: number | undefined;
}

/** What a faked endpoint answers. */
export interface FakePushResponse {
	/** Default 200. */
	status?: number;
	headers?: Record<string, string>;
}

type Matcher = string | ((request: RecordedPushRequest) => boolean);
type Responder =
	| FakePushResponse
	| ((
			request: RecordedPushRequest,
	  ) => FakePushResponse | Promise<FakePushResponse>);

interface Route {
	method: string;
	match: Matcher;
	respond: Responder;
}

export interface FakePushHttp extends PushHttpClient {
	/** Every request sent, in order. */
	readonly requests: RecordedPushRequest[];
	/** Answer `method` + `match`; the latest matching registration wins. */
	on(method: string, match: Matcher, respond: Responder): FakePushHttp;
	/** Forget the routes and the recorded requests. */
	reset(): void;
}

export function fakePushHttp(): FakePushHttp {
	const requests: RecordedPushRequest[] = [];
	const routes: Route[] = [];

	const routeFor = (request: RecordedPushRequest): Route | undefined => {
		for (let i = routes.length - 1; i >= 0; i--) {
			const route = routes[i];
			if (route === undefined || route.method !== request.method) continue;
			const hit =
				typeof route.match === "function"
					? route.match(request)
					: route.match === request.url;
			if (hit) return route;
		}
		return undefined;
	};

	const fake: FakePushHttp = {
		requests,
		on(method, match, respond) {
			routes.push({ method: method.toUpperCase(), match, respond });
			return fake;
		},
		reset() {
			routes.length = 0;
			requests.length = 0;
		},
		async request(
			url: string,
			options: PushHttpRequest,
		): Promise<PushHttpResponse> {
			const recorded: RecordedPushRequest = {
				method: options.method.toUpperCase(),
				url,
				headers: { ...options.headers },
				body:
					options.body === undefined ? undefined : Buffer.from(options.body),
				timeout: options.timeout,
				maxResponseBytes: options.maxResponseBytes,
			};
			requests.push(recorded);
			const route = routeFor(recorded);
			if (route === undefined) {
				throw transportError("unreachable", url);
			}
			const answer =
				typeof route.respond === "function"
					? await route.respond(recorded)
					: route.respond;
			const headers = new Map<string, string>();
			for (const [name, value] of Object.entries(answer.headers ?? {})) {
				headers.set(name.toLowerCase(), value);
			}
			return {
				status: answer.status ?? 200,
				header: (name) => headers.get(name.toLowerCase()),
			};
		},
	};
	return fake;
}

/**
 * A transport failure shaped like the one the framework's client throws:
 * Nova reads it structurally, by name and `reason`.
 */
export function transportError(reason: TransportFailure, url: string): Error {
	const error = new Error(`transport failure (${reason}) for ${url}`);
	error.name = "HttpClientError";
	Object.defineProperty(error, "reason", { value: reason, enumerable: true });
	return error;
}
