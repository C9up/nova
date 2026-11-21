/**
 * How the Redis store runs its scripts: by SHA1 through EVALSHA, loaded with
 * SCRIPT LOAD the first time the server answers NOSCRIPT.
 *
 * The fake below keeps a script cache the way a server does and answers
 * every script with an empty reply: what is under test is which commands
 * reach the server, not what the scripts do (the integration suite runs them
 * on a real one).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	RedisSubscriptionStore,
	type SubscriptionRedisClient,
} from "../../src/RedisSubscriptionStore.js";

type Call =
	| { command: "evalsha"; sha1: string }
	| { command: "script"; sha1: string };

class ScriptCacheClient implements SubscriptionRedisClient {
	readonly calls: Call[] = [];
	readonly #scripts = new Map<string, string>();
	readonly #failure: Error | undefined;

	constructor(failure?: Error) {
		this.#failure = failure;
	}

	async get(): Promise<string | null> {
		return null;
	}

	async evalsha(sha1: string): Promise<unknown> {
		this.calls.push({ command: "evalsha", sha1 });
		if (this.#failure) throw this.#failure;
		if (!this.#scripts.has(sha1)) {
			throw new Error("NOSCRIPT No matching script. Please use EVAL.");
		}
		return [];
	}

	async script(_subcommand: "LOAD", lua: string): Promise<unknown> {
		const sha1 = createHash("sha1").update(lua).digest("hex");
		this.#scripts.set(sha1, lua);
		this.calls.push({ command: "script", sha1 });
		return sha1;
	}

	/** Forget every script, as a restart or SCRIPT FLUSH does. */
	flush(): void {
		this.#scripts.clear();
	}
}

describe("nova > RedisSubscriptionStore scripts", () => {
	it("loads a script the first time it runs, then runs it by SHA1 alone", async () => {
		const client = new ScriptCacheClient();
		const store = new RedisSubscriptionStore(client);

		await store.listByUser("user-A");
		const [first, load, retry] = client.calls;
		expect(client.calls.map((call) => call.command)).toEqual([
			"evalsha",
			"script",
			"evalsha",
		]);
		// The SHA1 sent is the one the server computes over what was loaded.
		expect(load?.sha1).toBe(first?.sha1);
		expect(retry?.sha1).toBe(first?.sha1);

		client.calls.length = 0;
		await store.listByUser("user-B");
		expect(client.calls).toEqual([{ command: "evalsha", sha1: first?.sha1 }]);
	});

	it("loads each script on its own first run, and again once the server forgot it", async () => {
		const client = new ScriptCacheClient();
		const store = new RedisSubscriptionStore(client);
		await store.listByUser("user-A");

		// Another script: loaded on its first run, while the first stays known.
		client.calls.length = 0;
		await store.deleteForUser("user-A", "https://push.example/a");
		expect(client.calls.map((call) => call.command)).toEqual([
			"evalsha",
			"script",
			"evalsha",
		]);
		client.calls.length = 0;
		await store.listByUser("user-A");
		expect(client.calls.map((call) => call.command)).toEqual(["evalsha"]);

		client.flush();
		client.calls.length = 0;
		await store.listByUser("user-A");
		expect(client.calls.map((call) => call.command)).toEqual([
			"evalsha",
			"script",
			"evalsha",
		]);
	});

	it("does not retry an error other than NOSCRIPT, and passes it on untouched", async () => {
		const failure = new Error(
			"BUSY Redis is busy running a script. You can only call SCRIPT KILL or SHUTDOWN NOSAVE.",
		);
		const client = new ScriptCacheClient(failure);
		const store = new RedisSubscriptionStore(client);

		await expect(store.listByUser("user-A")).rejects.toBe(failure);
		expect(client.calls.map((call) => call.command)).toEqual(["evalsha"]);
	});
});
