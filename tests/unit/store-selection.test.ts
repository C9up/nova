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
			singleton(token: string, factory: () => unknown) {
				bindings.set(token, factory);
			},
			has: (token: string) => bindings.has(token),
			async resolve(token: string) {
				return bindings.get(token)?.();
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
		app: { container, config: { get: () => config } },
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
