/**
 * Resolving a Redis connection by name, and the guards around the key prefix.
 *
 * Both are fail-closed paths, and both name what is wrong: a connection that
 * cannot be resolved says which package is involved, and a prefix that cannot
 * be a Redis key says so at construction rather than producing keys nobody can
 * look up.
 */
import { describe, expect, it } from "vitest";
import { quasarConnection } from "../../src/quasar.js";
import { RedisSubscriptionStore } from "../../src/RedisSubscriptionStore.js";

/** The six commands the subscription store issues. */
const CLIENT = {
	get: async () => null,
	set: async () => "OK",
	del: async () => 0,
	sadd: async () => 0,
	srem: async () => 0,
	smembers: async () => [],
};

describe("nova > resolving a quasar connection", () => {
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
			expect((error as Error).message).toContain('"a b"');
		}
	});
});
