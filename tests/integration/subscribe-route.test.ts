/**
 * Integration test — wires NovaProvider against in-memory stubs of the
 * framework's container/config/router and exercises the registered subscribe
 * handler end-to-end (validation + persistence + response).
 *
 * Why no full Ignitor here: booting Ream pulls in the HTTP server stack and
 * Warden — both irrelevant for asserting Nova's contract. The provider is
 * structurally typed against a `NovaAppContext` so a minimal stub exercises
 * exactly the surface that a real `AppContext` would.
 */

import { fakeHttp } from "@c9up/ream/http-client";
import { describe, expect, it } from "vitest";
import { Nova } from "../../src/Nova.js";
import NovaProvider, { type NovaAppContext } from "../../src/NovaProvider.js";
import { SubscribeController } from "../../src/SubscribeController.js";
import {
	MemorySubscriptionDriver,
	type PushSubscription,
	type SubscriptionStore,
} from "../../src/SubscriptionStore.js";
import { generateVapidKeys } from "../../src/vapid.js";
import { realAuth, realP256dh } from "../__helpers__/subscription.js";

interface RecordedRoute {
	path: string;
	guards: string[];
	handler: (ctx: unknown) => unknown;
}

function makeRouter() {
	const routes: RecordedRoute[] = [];
	const router = {
		post(path: string, handler: (ctx: unknown) => unknown) {
			const recorded: RecordedRoute = { path, guards: [], handler };
			routes.push(recorded);
			return {
				guard(...guards: string[]) {
					recorded.guards.push(...guards);
					return this;
				},
			};
		},
	};
	return { router, routes };
}

function makeApp({
	router,
	store,
	novaConfig,
}: {
	router: unknown;
	store?: SubscriptionStore;
	novaConfig?: Record<string, unknown>;
}): NovaAppContext {
	const factories = new Map<string | symbol, () => unknown>();
	const instances = new Map<string | symbol, unknown>();
	factories.set("router", () => router);
	if (store) {
		factories.set("SubscriptionStore", () => store);
	}
	return {
		container: {
			singleton(token, factory) {
				factories.set(token, factory);
			},
			async resolve<T = unknown>(token: string | symbol): Promise<T> {
				if (instances.has(token)) return instances.get(token) as T;
				const factory = factories.get(token);
				if (!factory) throw new Error(`token not registered: ${String(token)}`);
				const value = factory();
				instances.set(token, value);
				return value as T;
			},
			has(token: string | symbol): boolean {
				return factories.has(token) || instances.has(token);
			},
		},
		config: {
			get<T = unknown>(key: string): T | undefined {
				if (key === "nova" && novaConfig) return novaConfig as T;
				return undefined;
			},
		},
	};
}

interface StubResponse {
	status: number;
	body: unknown;
}

function makeCtx(userId: string | undefined, body: unknown) {
	const captured: StubResponse = { status: 200, body: undefined };
	const ctx = {
		request: { body: () => body },
		response: {
			status(code: number) {
				captured.status = code;
				return this;
			},
			json(payload: unknown) {
				captured.body = payload;
				return this;
			},
		},
		auth: {
			authenticated: typeof userId === "string",
			user: userId ? { id: userId } : undefined,
		},
	};
	return { ctx, captured };
}

// A real browser-shaped subscription: p256dh is a point on P-256 (65 bytes),
// auth a 16-byte secret.
const VALID_BODY: PushSubscription = {
	endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
	expirationTime: null,
	keys: { p256dh: realP256dh(), auth: realAuth() },
};

describe("nova > subscribe route (integration)", () => {
	it("registers POST /api/nova/subscribe with the configured guard", async () => {
		const { router, routes } = makeRouter();
		const app = makeApp({ router });
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();
		await provider.start();

		expect(routes).toHaveLength(1);
		expect(routes[0]?.path).toBe("/api/nova/subscribe");
		expect(routes[0]?.guards).toEqual(["jwt"]);
	});

	it("honours the routePrefix override and the configured guard", async () => {
		const { router, routes } = makeRouter();
		const app = makeApp({
			router,
			novaConfig: { routePrefix: "/v2/notifications", guard: "session" },
		});
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();
		await provider.start();

		expect(routes[0]?.path).toBe("/v2/notifications/subscribe");
		expect(routes[0]?.guards).toEqual(["session"]);
	});

	it("registers no guard when guard=null (test-only)", async () => {
		const { router, routes } = makeRouter();
		const app = makeApp({ router, novaConfig: { guard: null } });
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();
		await provider.start();

		expect(routes[0]?.guards).toEqual([]);
	});

	it("persists the subscription on a valid POST and returns 201", async () => {
		const { router, routes } = makeRouter();
		const store = new MemorySubscriptionDriver();
		const app = makeApp({ router, store });
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();
		await provider.start();

		const handler = routes[0]?.handler;
		if (!handler) throw new Error("handler not captured");
		const { ctx, captured } = makeCtx("user-1", VALID_BODY);
		await handler(ctx);

		expect(captured.status).toBe(201);
		expect(captured.body).toEqual({ ok: true, endpoint: VALID_BODY.endpoint });
		const stored = await store.listByUser("user-1");
		expect(stored).toHaveLength(1);
		expect(stored[0]?.endpoint).toBe(VALID_BODY.endpoint);
	});

	it("returns 400 with E_NOVA_INVALID_SUBSCRIPTION on malformed body", async () => {
		const { router, routes } = makeRouter();
		const store = new MemorySubscriptionDriver();
		const app = makeApp({ router, store });
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();
		await provider.start();

		const handler = routes[0]?.handler;
		if (!handler) throw new Error("handler not captured");
		const { ctx, captured } = makeCtx("user-1", { endpoint: "ftp://nope" });
		await handler(ctx);

		expect(captured.status).toBe(400);
		const errorBody = captured.body as { error: { code: string } };
		expect(errorBody.error.code).toBe("E_NOVA_INVALID_SUBSCRIPTION");
		expect(await store.listByUser("user-1")).toEqual([]);
	});

	it("returns 400 for an endpoint over the 768-char storage cap (not a deep DB error)", async () => {
		const { router, routes } = makeRouter();
		const store = new MemorySubscriptionDriver();
		const app = makeApp({ router, store });
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();
		await provider.start();

		const handler = routes[0]?.handler;
		if (!handler) throw new Error("handler not captured");
		// 796-char https endpoint: valid scheme/keys but over the 768 storage
		// column, so it must be rejected at the boundary, never on DB insert.
		const longEndpoint = `https://fcm.googleapis.com/fcm/send/${"a".repeat(760)}`;
		const { ctx, captured } = makeCtx("user-1", {
			...VALID_BODY,
			endpoint: longEndpoint,
		});
		await handler(ctx);

		expect(captured.status).toBe(400);
		expect((captured.body as { error: { code: string } }).error.code).toBe(
			"E_NOVA_INVALID_SUBSCRIPTION",
		);
		expect(await store.listByUser("user-1")).toEqual([]);
	});

	it("upserts on duplicate POST for the same user (no duplicate row)", async () => {
		const { router, routes } = makeRouter();
		const store = new MemorySubscriptionDriver();
		const app = makeApp({ router, store });
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();
		await provider.start();

		const handler = routes[0]?.handler;
		if (!handler) throw new Error("handler not captured");
		const first = makeCtx("user-1", VALID_BODY);
		await handler(first.ctx);
		const second = makeCtx("user-1", VALID_BODY);
		await handler(second.ctx);

		expect(first.captured.status).toBe(201);
		expect(second.captured.status).toBe(201);
		expect(await store.listByUser("user-1")).toHaveLength(1);
	});

	it("throws E_NOVA_MISSING_USER when the guard was disabled and no auth context exists", async () => {
		const { router, routes } = makeRouter();
		const store = new MemorySubscriptionDriver();
		const app = makeApp({ router, store, novaConfig: { guard: null } });
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();
		await provider.start();

		const handler = routes[0]?.handler;
		if (!handler) throw new Error("handler not captured");
		const { ctx } = makeCtx(undefined, VALID_BODY);
		await expect(handler(ctx)).rejects.toMatchObject({
			code: "E_NOVA_MISSING_USER",
		});
	});

	it("uses the explicit store from NovaConfig when provided", async () => {
		const customStore = new MemorySubscriptionDriver();
		const { router, routes } = makeRouter();
		const app = makeApp({ router, novaConfig: { store: customStore } });
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();
		await provider.start();

		const handler = routes[0]?.handler;
		if (!handler) throw new Error("handler not captured");
		const { ctx } = makeCtx("user-1", VALID_BODY);
		await handler(ctx);
		expect(await customStore.listByUser("user-1")).toHaveLength(1);
	});

	it("hands config.delivery to the Nova it binds", async () => {
		const http = fakeHttp({ maxRedirects: 0 });
		http.on("POST", () => true, { status: 201 });
		const { router } = makeRouter();
		const app = makeApp({
			router,
			novaConfig: {
				vapid: { ...generateVapidKeys(), subject: "mailto:ops@example.com" },
				delivery: { http },
			},
		});
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();

		const nova = await app.container.resolve("nova");
		if (!(nova instanceof Nova)) throw new Error("no Nova bound");
		const result = await nova.push(VALID_BODY, { title: "x" });

		expect(result).toEqual({
			ok: true,
			status: 201,
			endpoint: VALID_BODY.endpoint,
		});
		expect(http.requests).toHaveLength(1);
		await provider.shutdown();
	});
});

describe("nova > subscribe route — the endpoint must be a push service", () => {
	async function subscribeWith(
		endpoint: string,
		novaConfig?: Record<string, unknown>,
	): Promise<{ status: number; stored: number }> {
		const { router, routes } = makeRouter();
		const store = new MemorySubscriptionDriver();
		const provider = new NovaProvider(makeApp({ router, store, novaConfig }));
		provider.register();
		await provider.start();
		const handler = routes[0]?.handler;
		if (!handler) throw new Error("handler not captured");
		const { ctx, captured } = makeCtx("user-1", { ...VALID_BODY, endpoint });
		await handler(ctx);
		return {
			status: captured.status,
			stored: (await store.listByUser("user-1")).length,
		};
	}

	it.each([
		"https://169.254.169.254/latest/meta-data/iam/security-credentials/",
		"https://metadata.google.internal/computeMetadata/v1/",
		"https://10.0.0.5:8443/admin/delete-all",
		"https://localhost:6443/api/v1/namespaces",
		"https://[::1]:9200/_all",
		"https://127.0.0.1:36501/internal/admin/purge?confirm=yes",
		"https://0x7f000001/",
		"https://attacker.example.com/push",
		"https://fcm.googleapis.com.attacker.example/fcm/send/x",
		"https://evilfcm.googleapis.com/fcm/send/x",
		"https://fcm.googleapis.com@attacker.example/fcm/send/x",
		"https://user:pass@fcm.googleapis.com/fcm/send/x",
	])("refuses %s with 400 and stores nothing", async (endpoint) => {
		expect(await subscribeWith(endpoint)).toEqual({ status: 400, stored: 0 });
	});

	it.each([
		"https://fcm.googleapis.com/fcm/send/abc123",
		"https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
		"https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
		"https://web.push.apple.com/QGuQyavXutnMH",
		"https://FCM.googleapis.com/fcm/send/upper",
	])("accepts the push service %s", async (endpoint) => {
		expect(await subscribeWith(endpoint)).toEqual({ status: 201, stored: 1 });
	});

	it("accepts a push service the application adds", async () => {
		const endpoint = "https://push.example.net/sub/1";
		expect(await subscribeWith(endpoint)).toEqual({ status: 400, stored: 0 });
		expect(
			await subscribeWith(endpoint, {
				delivery: { pushServices: ["push.example.net"] },
			}),
		).toEqual({ status: 201, stored: 1 });
	});

	it("accepts a loopback push service only when named in allowHosts", async () => {
		const endpoint = "https://localhost:4399/push/1";
		expect(
			await subscribeWith(endpoint, {
				delivery: { allowHosts: ["localhost:4399"] },
			}),
		).toEqual({ status: 201, stored: 1 });
		expect(
			await subscribeWith(endpoint, {
				delivery: { allowHosts: ["localhost:4400"] },
			}),
		).toEqual({ status: 400, stored: 0 });
	});
});

describe("nova > subscribe route — user ids", () => {
	function controllerWith(
		store: MemorySubscriptionDriver,
	): SubscribeController {
		return new SubscribeController(store);
	}

	function ctxFor(user: { id?: unknown } | undefined) {
		const captured: StubResponse = { status: 200, body: undefined };
		const ctx = {
			request: { body: () => VALID_BODY },
			response: {
				status(code: number) {
					captured.status = code;
					return {
						json(payload: unknown) {
							captured.body = payload;
						},
					};
				},
			},
			auth: { user },
		};
		return { ctx, captured };
	}

	it("stores a numeric id (an auto-increment key) as its decimal text", async () => {
		const store = new MemorySubscriptionDriver();
		const { ctx, captured } = ctxFor({ id: 42 });
		await controllerWith(store).handle(ctx);
		expect(captured.status).toBe(201);
		expect(await store.listByUser("42")).toHaveLength(1);
	});

	it("stores a bigint id as its decimal text", async () => {
		const store = new MemorySubscriptionDriver();
		const { ctx, captured } = ctxFor({ id: 9007199254740993n });
		await controllerWith(store).handle(ctx);
		expect(captured.status).toBe(201);
		expect(await store.listByUser("9007199254740993")).toHaveLength(1);
	});

	it("lets pushToUser take the same numeric id", async () => {
		const http = fakeHttp({ maxRedirects: 0 });
		http.on("POST", () => true, { status: 201 });
		const store = new MemorySubscriptionDriver();
		await controllerWith(store).handle(ctxFor({ id: 42 }).ctx);
		const nova = new Nova(
			store,
			{ ...generateVapidKeys(), subject: "mailto:ops@example.com" },
			{ http },
		);
		const results = await nova.pushToUser(42, { title: "x" });
		expect(results).toEqual([
			{ ok: true, status: 201, endpoint: VALID_BODY.endpoint },
		]);
	});

	it.each([
		["an empty string", ""],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["a fraction", 1.5],
		["an object", { toString: () => "1" }],
	])("refuses %s as an id, without blaming the guard", async (_label, id) => {
		const store = new MemorySubscriptionDriver();
		await expect(
			controllerWith(store).handle(ctxFor({ id }).ctx),
		).rejects.toMatchObject({
			code: "E_NOVA_INVALID_USER_ID",
		});
		expect(await store.listByUser(String(id))).toEqual([]);
	});

	it("still names the guard when there is no user at all", async () => {
		const store = new MemorySubscriptionDriver();
		await expect(
			controllerWith(store).handle(ctxFor(undefined).ctx),
		).rejects.toMatchObject({ code: "E_NOVA_MISSING_USER" });
	});
});

describe("nova > subscribe route — an endpoint another user holds", () => {
	function post(
		controller: SubscribeController,
		userId: string,
		body: PushSubscription,
	) {
		const { ctx, captured } = makeCtx(userId, body);
		return controller.handle(ctx).then(() => captured);
	}

	it("answers 409 to a poster with other keys and keeps the owner's row", async () => {
		const store = new MemorySubscriptionDriver();
		const controller = new SubscribeController(store);
		expect((await post(controller, "victim", VALID_BODY)).status).toBe(201);

		const answer = await post(controller, "attacker", {
			...VALID_BODY,
			keys: { p256dh: realP256dh(), auth: realAuth() },
		});

		expect(answer.status).toBe(409);
		expect(answer.body).toMatchObject({
			error: { code: "E_NOVA_SUBSCRIPTION_CONFLICT" },
		});
		expect(await store.listByUser("victim")).toEqual([VALID_BODY]);
		expect(await store.listByUser("attacker")).toEqual([]);
	});

	it("moves it to a user posting the same keys (shared device)", async () => {
		const store = new MemorySubscriptionDriver();
		const controller = new SubscribeController(store);
		await post(controller, "first", VALID_BODY);

		expect((await post(controller, "second", VALID_BODY)).status).toBe(201);
		expect(await store.listByUser("first")).toEqual([]);
		expect(await store.listByUser("second")).toEqual([VALID_BODY]);
	});
});
