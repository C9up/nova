import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	FileSubscriptionStore,
	NovaError,
	type PushSubscription,
} from "../../src/index.js";

/**
 * The file store, against a real filesystem.
 *
 * What matters here is not the round trip — it is what happens when things go
 * wrong: two subscribes at once, a crash mid-write, a file someone edited by
 * hand. A store that loses subscriptions quietly is worse than one that has
 * none, because nobody finds out until the notifications stop.
 */
function subscription(
	endpoint: string,
	expirationTime: number | null = null,
): PushSubscription {
	return {
		endpoint,
		expirationTime,
		keys: { p256dh: `p256dh-${endpoint}`, auth: `auth-${endpoint}` },
	};
}

describe("nova > FileSubscriptionStore", () => {
	let directory: string;
	let path: string;
	let store: FileSubscriptionStore;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "nova-file-store-"));
		path = join(directory, "nested", "push_subscriptions.json");
		store = new FileSubscriptionStore(path);
	});

	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("stores a subscription and reads it back whole", async () => {
		await store.save(
			"user-A",
			subscription("https://push.example/one", 1893456000000),
		);

		expect(await store.listByUser("user-A")).toEqual([
			{
				endpoint: "https://push.example/one",
				expirationTime: 1893456000000,
				keys: {
					p256dh: "p256dh-https://push.example/one",
					auth: "auth-https://push.example/one",
				},
			},
		]);
	});

	it("survives a restart — a new store over the same file sees them", async () => {
		await store.save("user-A", subscription("https://push.example/one"));

		const restarted = new FileSubscriptionStore(path);
		expect(await restarted.listByUser("user-A")).toHaveLength(1);
	});

	it("creates the directory it was pointed at", async () => {
		await store.save("user-A", subscription("https://push.example/one"));
		// The path named a directory that did not exist; nothing should have to
		// mkdir it by hand before the first subscribe.
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
			version: 1,
		});
	});

	it("keeps every subscription when several arrive at once", async () => {
		// Read-change-write without serialisation loses all but the last: each
		// call would read the same file and write its own version back.
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				store.save("user-A", subscription(`https://push.example/${i}`)),
			),
		);

		expect(await store.listByUser("user-A")).toHaveLength(20);
	});

	it("keeps writing after one mutation fails", async () => {
		await store.save("user-A", subscription("https://push.example/one"));
		await writeFile(path, "{not json", "utf8");
		await expect(store.save("user-A", subscription("x"))).rejects.toThrow(
			NovaError,
		);

		// The queue must not inherit that rejection — the next write, on a file
		// that is readable again, has to go through.
		await writeFile(path, '{"version":1,"subscriptions":{}}', "utf8");
		await store.save("user-A", subscription("https://push.example/after"));
		expect(await store.listByUser("user-A")).toHaveLength(1);
	});

	it("refuses to read a file it cannot parse, naming it", async () => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "{not json", "utf8");

		await expect(store.listByUser("user-A")).rejects.toThrow(
			/is not valid JSON/,
		);
		// Starting from empty would replace the file on the next subscribe, and
		// the only trace would be notifications that stop arriving.
		expect(await readFile(path, "utf8")).toBe("{not json");
	});

	it("refuses JSON that is not a subscription store", async () => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, '["something", "else"]', "utf8");
		await expect(store.listByUser("user-A")).rejects.toThrow(
			/not a subscription store/,
		);
	});

	it("moves an endpoint to its new owner instead of leaving it on both", async () => {
		const endpoint = "https://push.example/shared";
		await store.save("user-A", subscription(endpoint));
		await store.save("user-B", subscription(endpoint));

		expect(await store.listByUser("user-A")).toEqual([]);
		expect(await store.listByUser("user-B")).toHaveLength(1);
	});

	it("deletes an endpoint whoever owns it", async () => {
		await store.save("user-A", subscription("https://push.example/dead"));
		await store.delete("https://push.example/dead");

		expect(await store.listByUser("user-A")).toEqual([]);
	});

	it("leaves no temporary file behind", async () => {
		await store.save("user-A", subscription("https://push.example/one"));
		// The write goes to <file>.tmp and is renamed over the real one, so a
		// crash leaves the previous file rather than a truncated one.
		await expect(readFile(`${path}.tmp`, "utf8")).rejects.toThrow();
	});

	it("answers an empty list before anything is written", async () => {
		expect(await store.listByUser("nobody")).toEqual([]);
	});
});
