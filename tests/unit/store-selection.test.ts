import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FileSubscriptionStore,
	MemorySubscriptionDriver,
	type NovaAppContext,
	type NovaConfig,
	type NovaError,
	NovaProvider,
	RedisSubscriptionStore,
	SqlSubscriptionStore,
	stores,
} from "../../src/index.js";

/**
 * `{ default, stores }` — the shape a package takes when several backends are
 * declared and one is selected, so a deployment names its store in the
 * environment instead of editing a config file.
 */
function containerStub() {
	const bindings = new Map<string, () => unknown>();
	return {
		bindings,
		container: {
			// `string | symbol`, as ContainerLike declares it — narrowing the
			// stub to `string` is what made it incompatible with the interface
			// the provider is actually handed.
			singleton(token: string | symbol, factory: () => unknown) {
				bindings.set(String(token), factory);
			},
			has: (token: string | symbol) => bindings.has(String(token)),
			async resolve<T = unknown>(token: string | symbol): Promise<T> {
				return bindings.get(String(token))?.() as T;
			},
		},
	};
}

function appWith(config: NovaConfig): {
	bindings: Map<string, () => unknown>;
	app: NovaAppContext;
} {
	const { container, bindings } = containerStub();
	return {
		bindings,
		// The provider reads exactly one config key, so the store answers with
		// the config under test whatever it is asked for.
		// One cast, at the stub boundary: `get<T>` is generic over what the
		// caller asks for, and a stub that always answers with one value
		// cannot express that any other way.
		app: { container, config: { get: <T = unknown>() => config as T } },
	};
}

/** Register the provider and hand back whatever store it bound. */
function storeFrom(config: NovaConfig): unknown {
	const { app, bindings } = appWith(config);
	new NovaProvider(app).register();
	return bindings.get("SubscriptionStore")?.();
}

describe("nova > store selection", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "nova-select-"));
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("builds the store `default` names", () => {
		const store = storeFrom({
			default: "file",
			stores: {
				memory: stores.memory(),
				file: stores.file({ path: join(directory, "subs.json") }),
			},
		});

		expect(store).toBeInstanceOf(FileSubscriptionStore);
	});

	it("builds only the store it selected", () => {
		let built = 0;
		storeFrom({
			default: "memory",
			stores: {
				memory: stores.memory(),
				never: () => {
					built += 1;
					return new MemorySubscriptionDriver();
				},
			},
		});

		// A config may name a Redis store it does not use in this environment;
		// building it would open a connection nobody asked for.
		expect(built).toBe(0);
	});

	it("refuses a `default` that names nothing, listing what exists", () => {
		expect(() =>
			storeFrom({
				default: "postgres",
				stores: { memory: stores.memory() },
			}),
		).toThrow(/not in `stores`/);

		// Falling back to memory would look like it worked, until a restart lost
		// every subscription.
		try {
			storeFrom({
				default: "postgres",
				stores: { memory: stores.memory() },
			});
		} catch (error) {
			expect((error as NovaError).hint).toContain("memory");
		}
	});

	it("refuses `stores` with no `default`", () => {
		expect(() => storeFrom({ stores: { memory: stores.memory() } })).toThrow(
			/no `default`/,
		);
	});

	it("still takes a single store instance", () => {
		const store = new MemorySubscriptionDriver();
		expect(storeFrom({ store })).toBe(store);
	});

	it("falls back to memory when nothing is configured", () => {
		expect(storeFrom({})).toBeInstanceOf(MemorySubscriptionDriver);
	});

	it("hands each factory its options", () => {
		expect(stores.memory()()).toBeInstanceOf(MemorySubscriptionDriver);
		expect(stores.file({ path: join(directory, "x.json") })()).toBeInstanceOf(
			FileSubscriptionStore,
		);
		expect(
			stores.sql({
				connection: {
					dialect: "sqlite",
					execute: async () => ({ rowsAffected: 0 }),
					query: async () => [],
				},
			})(),
		).toBeInstanceOf(SqlSubscriptionStore);
		expect(
			stores.redis({
				connection: {
					get: async () => null,
					set: async () => "OK",
					del: async () => 0,
					sadd: async () => 0,
					srem: async () => 0,
					smembers: async () => [],
				},
			})(),
		).toBeInstanceOf(RedisSubscriptionStore);
	});

	it("resolves a quasar connection by name only when it is used", async () => {
		// The name is not resolved at config time — quasar is an optional peer,
		// and an application that never selects this store must not need it
		// installed just to load its config.
		const factory = stores.redis({ connection: "main" });
		const store = factory();
		expect(store).toBeInstanceOf(RedisSubscriptionStore);

		// Resolution is deferred to the first command, and whatever it fails on
		// reaches the caller. Which failure that is depends on the environment,
		// and both are correct: without quasar installed, nova's own
		// E_NOVA_QUASAR_MISSING; with it installed but no application booted —
		// this workspace — quasar's own initialization message, passed through
		// rather than masked as "quasar is missing", which would send the reader
		// to reinstall a package they already have.
		await expect(store.listByUser("user-A")).rejects.toThrow(
			/quasar|accessed before initialization/,
		);
	});
});

describe("nova > store selection > a `default` with nothing to pick from", () => {
	it("refuses a `default` when no `stores` are declared", () => {
		// The other branch already refuses a `default` naming an entry that is
		// not in `stores`, for the reason spelled out there: an application
		// that meant to persist subscriptions and silently got the in-memory
		// driver only finds out when a restart has lost them all. With the
		// `stores` block gone — deleted, or never written — the same mistake
		// used to land in exactly that place.
		expect(() => storeFrom({ default: "sql" })).toThrow(/declares no/);
		try {
			storeFrom({ default: "sql" });
		} catch (error) {
			expect((error as NovaError).code).toBe("E_NOVA_UNKNOWN_STORE");
		}
	});

	it("still falls back to memory when nothing is configured at all", () => {
		expect(storeFrom({})).toBeInstanceOf(MemorySubscriptionDriver);
	});

	it("still takes a single `store` instance, `default` or not", () => {
		const store = new MemorySubscriptionDriver();
		expect(storeFrom({ default: "sql", store })).toBe(store);
	});
});

describe("NovaProvider > shutdown", () => {
	const configured = (): NovaConfig => ({
		default: "memory",
		stores: { memory: stores.memory() },
	});

	/** An app whose container also answers `router`, which boot() mounts on. */
	function bootableApp(): NovaAppContext {
		const { app, bindings } = appWith(configured());
		bindings.set("router", () => ({
			post: () => ({ guard: () => undefined }),
		}));
		return app;
	}

	it("releases the services/main singleton it bound", async () => {
		const { getPush } = await import("../../src/services/main.js");
		const provider = new NovaProvider(bootableApp());
		provider.register();
		await provider.boot();
		expect(getPush()).toBeDefined();

		await provider.shutdown();

		// A stopped application left a dead push service reachable through
		// `import push from '@c9up/nova/services/main'`.
		expect(getPush()).toBeUndefined();
	});

	it("leaves what another application has since bound alone", async () => {
		const { getPush } = await import("../../src/services/main.js");
		const provider = new NovaProvider(bootableApp());
		provider.register();
		await provider.boot();

		const other = new NovaProvider(bootableApp());
		other.register();
		await other.boot();
		const replacement = getPush();
		if (!replacement) throw new Error("expected the second boot to bind one");

		await provider.shutdown();

		expect(getPush()).toBe(replacement);
	});
});
