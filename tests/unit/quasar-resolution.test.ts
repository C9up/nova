/**
 * Resolving a Redis connection by name, and the guards around the key prefix.
 *
 * Both are fail-closed paths, and both name what is wrong: a connection that
 * cannot be resolved says which package is involved, and a prefix that cannot
 * be a Redis key says so at construction rather than producing keys nobody can
 * look up.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { quasarConnection } from "../../src/quasar.js";
import {
	RedisSubscriptionStore,
	type SubscriptionRedisClient,
} from "../../src/RedisSubscriptionStore.js";

/** The three commands the subscription store issues. */
const CLIENT = {
	get: async () => null,
	evalsha: async () => 0,
	script: async () => "",
};

describe("nova > resolving a quasar connection", () => {
	afterEach(() => {
		vi.doUnmock("@c9up/quasar/services/main");
		vi.resetModules();
	});

	/**
	 * Stand in for quasar's service accessor, which is what the specifier
	 * resolves to. The module is imported by a name built at runtime, so this
	 * is the seam: nothing here may import quasar statically.
	 */
	function withQuasar(connection: unknown): void {
		vi.doMock("@c9up/quasar/services/main", () => ({
			default: { connection: () => connection },
		}));
		vi.resetModules();
	}

	/** The module under test, re-imported so the mock above is the one it sees. */
	async function resolve(name?: string): Promise<unknown> {
		const { quasarConnection: fresh } = await import("../../src/quasar.js");
		return fresh(name);
	}

	it("hands back the named connection when it can serve the store", async () => {
		withQuasar(CLIENT);

		// The path a deployment actually takes — `stores.redis({ connection:
		// 'main' })` — and the one nothing reached: every case below this used
		// to be the only one exercised.
		await expect(resolve("main")).resolves.toBe(CLIENT);
	});

	it("names the commands a connection is missing rather than failing on the first subscribe", async () => {
		const { script: _dropped, ...partial } = CLIENT;
		withQuasar(partial);

		await expect(resolve("main")).rejects.toMatchObject({
			code: "E_NOVA_REDIS_INCOMPLETE",
			message: /script/,
		});
	});

	it("says so when what the specifier answers with is not a connection source", async () => {
		vi.doMock("@c9up/quasar/services/main", () => ({ default: {} }));
		vi.resetModules();

		await expect(resolve()).rejects.toMatchObject({
			code: "E_NOVA_QUASAR_MISSING",
			message: /connection\(name\)/,
		});
	});

	it("refuses when the connection cannot be produced, naming the cause", async () => {
		// Either quasar is absent — and the message says to install it — or it is
		// present but no application has booted it, and its own message comes
		// through. Both are actionable; neither is silent.
		await expect(quasarConnection("main")).rejects.toThrow(
			/quasar|accessed before initialization/,
		);
	});
});

describe("nova > the key prefix", () => {
	it("takes a client and a default prefix", () => {
		expect(() => new RedisSubscriptionStore(CLIENT)).not.toThrow();
	});

	it("takes a lazy resolver, since the client may not exist yet", () => {
		// This is why the store cannot check the client at construction: it may
		// be handed a function that resolves one later.
		expect(() => new RedisSubscriptionStore(() => CLIENT)).not.toThrow();
	});

	it("refuses a prefix a Redis key cannot carry", () => {
		expect(
			() => new RedisSubscriptionStore(CLIENT, { prefix: "nova push" }),
		).toThrow(expect.objectContaining({ code: "E_NOVA_INVALID_PREFIX" }));
	});

	it("says which prefix was refused", () => {
		try {
			new RedisSubscriptionStore(CLIENT, { prefix: "a b" });
			expect.unreachable("a prefix with a space has to be refused");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect(error instanceof Error ? error.message : "").toContain('"a b"');
		}
	});
});

/**
 * Quasar retires a connection whose retry strategy gave up and hands out a
 * fresh one. A store that kept the first one failed every subscribe and push
 * with "Connection is closed." until the process restarted.
 */
describe("nova > a connection that ended for good", () => {
	function fakeClient(status: string) {
		return {
			status,
			get: vi.fn(async (): Promise<string | null> => null),
			evalsha: vi.fn(async (): Promise<unknown> => 0),
			script: vi.fn(async (): Promise<unknown> => ""),
		};
	}

	it("is resolved again on the next call", async () => {
		const first = fakeClient("ready");
		const second = fakeClient("ready");
		const resolver = vi
			.fn<() => SubscriptionRedisClient>()
			.mockReturnValueOnce(first)
			.mockReturnValueOnce(second);
		const store = new RedisSubscriptionStore(resolver);

		await store.delete("https://push.example/a");
		first.status = "end";
		await store.delete("https://push.example/a");

		expect(resolver).toHaveBeenCalledTimes(2);
		expect(second.get).toHaveBeenCalledOnce();
	});

	it("keeps a client that closed but reconnects, and one handed in directly", async () => {
		const resolved = fakeClient("ready");
		const resolver = vi.fn(() => resolved);
		const store = new RedisSubscriptionStore(resolver);
		await store.delete("https://push.example/a");
		resolved.status = "close";
		await store.delete("https://push.example/a");
		expect(resolver).toHaveBeenCalledOnce();

		const direct = fakeClient("end");
		await new RedisSubscriptionStore(direct).delete("https://push.example/a");
		expect(direct.get).toHaveBeenCalledOnce();
	});
});
