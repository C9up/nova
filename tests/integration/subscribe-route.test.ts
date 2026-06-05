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

import { describe, expect, it } from "vitest";
import NovaProvider from "../../src/NovaProvider.js";
import {
	MemorySubscriptionDriver,
	type PushSubscription,
	type SubscriptionStore,
} from "../../src/SubscriptionStore.js";

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

interface AppLike {
	container: {
		singleton(token: string | symbol, factory: () => unknown): void;
		resolve<T = unknown>(token: string | symbol): T;
	};
	config: {
		get<T = unknown>(key: string): T | undefined;
	};
}

function makeApp({
	router,
	store,
	novaConfig,
}: {
	router: unknown;
	store?: SubscriptionStore;
	novaConfig?: Record<string, unknown>;
}): AppLike {
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
			resolve<T = unknown>(token: string | symbol): T {
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

// Realistic-shape fixtures: p256dh = 65 raw bytes → 87 base64url chars,
// auth = 16 raw bytes → 22 base64url chars. Bytes themselves are fake.
const VALID_BODY: PushSubscription = {
	endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
	expirationTime: null,
	keys: {
		p256dh:
			"BNcRdreALRFXTkOiHpMpfHJoDRvSgGUgmCNNxPaLyzPnlJSNiy3Y0VFm8eq2RRvODPHc4P10qOrjTlnmyUrpbyA",
		auth: "tBHItJI5sVmRaTQX6w4qEA",
	},
};

describe("nova > subscribe route (integration)", () => {
	it("registers POST /api/nova/subscribe with the configured guard", async () => {
		const { router, routes } = makeRouter();
		const app = makeApp({ router });
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();

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

		expect(routes[0]?.path).toBe("/v2/notifications/subscribe");
		expect(routes[0]?.guards).toEqual(["session"]);
	});

	it("registers no guard when guard=null (test-only)", async () => {
		const { router, routes } = makeRouter();
		const app = makeApp({ router, novaConfig: { guard: null } });
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();

		expect(routes[0]?.guards).toEqual([]);
	});

	it("persists the subscription on a valid POST and returns 201", async () => {
		const { router, routes } = makeRouter();
		const store = new MemorySubscriptionDriver();
		const app = makeApp({ router, store });
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();

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

	it("returns 400 with NOVA_INVALID_SUBSCRIPTION on malformed body", async () => {
		const { router, routes } = makeRouter();
		const store = new MemorySubscriptionDriver();
		const app = makeApp({ router, store });
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();

		const handler = routes[0]?.handler;
		if (!handler) throw new Error("handler not captured");
		const { ctx, captured } = makeCtx("user-1", { endpoint: "ftp://nope" });
		await handler(ctx);

		expect(captured.status).toBe(400);
		const errorBody = captured.body as { error: { code: string } };
		expect(errorBody.error.code).toBe("NOVA_INVALID_SUBSCRIPTION");
		expect(await store.listByUser("user-1")).toEqual([]);
	});

	it("upserts on duplicate POST for the same user (no duplicate row)", async () => {
		const { router, routes } = makeRouter();
		const store = new MemorySubscriptionDriver();
		const app = makeApp({ router, store });
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();

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

	it("throws NOVA_MISSING_USER when the guard was disabled and no auth context exists", async () => {
		const { router, routes } = makeRouter();
		const store = new MemorySubscriptionDriver();
		const app = makeApp({ router, store, novaConfig: { guard: null } });
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();

		const handler = routes[0]?.handler;
		if (!handler) throw new Error("handler not captured");
		const { ctx } = makeCtx(undefined, VALID_BODY);
		await expect(handler(ctx)).rejects.toMatchObject({
			code: "NOVA_MISSING_USER",
		});
	});

	it("uses the explicit store from NovaConfig when provided", async () => {
		const customStore = new MemorySubscriptionDriver();
		const { router, routes } = makeRouter();
		const app = makeApp({ router, novaConfig: { store: customStore } });
		const provider = new NovaProvider(app);
		provider.register();
		await provider.boot();

		const handler = routes[0]?.handler;
		if (!handler) throw new Error("handler not captured");
		const { ctx } = makeCtx("user-1", VALID_BODY);
		await handler(ctx);
		expect(await customStore.listByUser("user-1")).toHaveLength(1);
	});
});
