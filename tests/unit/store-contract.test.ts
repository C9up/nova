/**
 * Rules every store keeps the same way, run against all four.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	FileSubscriptionStore,
	MemorySubscriptionDriver,
	RedisSubscriptionStore,
	SqlSubscriptionStore,
	type SubscriptionStore,
} from "../../src/index.js";
import { FakeRedis, sqliteConnection } from "../__helpers__/stores.js";
import {
	realAuth,
	realP256dh,
	subscription,
} from "../__helpers__/subscription.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const STORES: ReadonlyArray<
	readonly [string, () => Promise<SubscriptionStore>]
> = [
	["memory", async () => new MemorySubscriptionDriver()],
	[
		"file",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "nova-contract-"));
			cleanups.push(() => rm(directory, { recursive: true, force: true }));
			return new FileSubscriptionStore(join(directory, "subs.json"));
		},
	],
	[
		"sql",
		async () => {
			const db = sqliteConnection();
			cleanups.push(async () => db.close());
			return new SqlSubscriptionStore(db);
		},
	],
	["redis", async () => new RedisSubscriptionStore(new FakeRedis())],
];

describe.each(STORES)("%s store — taking over an endpoint", (_name, make) => {
	const endpoint = "https://fcm.googleapis.com/fcm/send/shared-device";

	it("moves it to another user who presents the same keys", async () => {
		const store = await make();
		const browser = subscription(endpoint);
		await store.save("victim", browser);

		// Logout, login as someone else, same browser: identical keys.
		await store.save("next-user", browser);

		expect(await store.listByUser("victim")).toEqual([]);
		expect(await store.listByUser("next-user")).toEqual([browser]);
	});

	it.each([
		["other keys", () => ({ p256dh: realP256dh(), auth: realAuth() })],
		[
			"the right p256dh but another auth",
			() => ({ p256dh: subscription(endpoint).keys.p256dh, auth: realAuth() }),
		],
	])(
		"refuses another user posting it with %s, and leaves the owner's row",
		async (_label, keys) => {
			const store = await make();
			const original = subscription(endpoint);
			await store.save("victim", original);

			await expect(
				store.save("attacker", { ...original, keys: keys() }),
			).rejects.toMatchObject({ code: "E_NOVA_SUBSCRIPTION_CONFLICT" });

			expect(await store.listByUser("victim")).toEqual([original]);
			expect(await store.listByUser("attacker")).toEqual([]);
		},
	);

	it("lets the owner replace their own keys", async () => {
		const store = await make();
		await store.save("owner", subscription(endpoint));
		const renewed = {
			...subscription(endpoint),
			keys: { p256dh: realP256dh(), auth: realAuth() },
		};

		await store.save("owner", renewed);

		expect(await store.listByUser("owner")).toEqual([renewed]);
	});
});
