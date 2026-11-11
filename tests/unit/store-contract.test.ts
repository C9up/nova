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
import { SubscribeController } from "../../src/SubscribeController.js";
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

describe.each(STORES)("%s store — subscriptions per user", (name, make) => {
	const endpointOf = (n: number) =>
		`https://fcm.googleapis.com/fcm/send/${name}-cap-${n}`;
	/** SQL orders by a timestamp; distinct seconds make "oldest" exact. */
	const tick = () =>
		name === "sql"
			? new Promise((resolve) => setTimeout(resolve, 1_050))
			: Promise.resolve();

	it("evicts the oldest on the (cap+1)th save, in the store itself", async () => {
		const store = await make();
		for (const n of [1, 2, 3]) {
			await store.save("u1", subscription(endpointOf(n)), { maxPerUser: 2 });
			await tick();
		}

		const kept = (await store.listByUser("u1")).map((s) => s.endpoint);
		expect(kept).toEqual([endpointOf(2), endpointOf(3)]);
	}, 15_000);

	it("re-saving a held endpoint at the cap evicts nothing", async () => {
		const store = await make();
		await store.save("u1", subscription(endpointOf(1)), { maxPerUser: 2 });
		await store.save("u1", subscription(endpointOf(2)), { maxPerUser: 2 });

		await store.save("u1", subscription(endpointOf(2), 42), {
			maxPerUser: 2,
		});

		expect(await store.listByUser("u1")).toHaveLength(2);
	});

	it("holds the cap under a flood of concurrent subscribes", async () => {
		const store = await make();
		const flood = Array.from({ length: 60 }, (_, n) =>
			store.save("u1", subscription(endpointOf(100 + n)), { maxPerUser: 5 }),
		);

		await Promise.all(flood);

		expect(await store.listByUser("u1")).toHaveLength(5);
	});

	it("defaults to 20 when the caller names no cap", async () => {
		const store = await make();
		for (let n = 0; n < 25; n++) {
			await store.save("u1", subscription(endpointOf(200 + n)));
		}

		expect(await store.listByUser("u1")).toHaveLength(20);
	});

	it.each([0, -1, 1.5, Number.NaN])("refuses a cap of %s", async (max) => {
		const store = await make();
		await expect(
			store.save("u1", subscription(endpointOf(300)), { maxPerUser: max }),
		).rejects.toThrow(/maxPerUser/);
		expect(await store.listByUser("u1")).toEqual([]);
	});

	it("does not touch another user's subscriptions", async () => {
		const store = await make();
		await store.save("u1", subscription(endpointOf(400)), { maxPerUser: 1 });
		await store.save("u2", subscription(endpointOf(401)), { maxPerUser: 1 });
		await store.save("u2", subscription(endpointOf(402)), { maxPerUser: 1 });

		expect(await store.listByUser("u1")).toHaveLength(1);
		expect((await store.listByUser("u2")).map((s) => s.endpoint)).toEqual([
			endpointOf(402),
		]);
	});

	it("is what the subscribe route applies", async () => {
		const store = await make();
		const controller = new SubscribeController(store, {
			maxSubscriptionsPerUser: 1,
		});
		for (const n of [500, 501]) {
			await controller.handle({
				request: { body: () => subscription(endpointOf(n)) },
				response: { status: () => ({ json: () => {} }) },
				auth: { user: { id: "u1" } },
			});
			await tick();
		}

		expect((await store.listByUser("u1")).map((s) => s.endpoint)).toEqual([
			endpointOf(501),
		]);
	}, 15_000);
});

describe("subscriptions per user — the setting", () => {
	it.each([0, -1, 1.5, Number.NaN])("refuses %s", (max) => {
		expect(
			() =>
				new SubscribeController(new MemorySubscriptionDriver(), {
					maxSubscriptionsPerUser: max,
				}),
		).toThrow(/maxSubscriptionsPerUser/);
	});

	it("defaults to 20", async () => {
		const store = new MemorySubscriptionDriver();
		const controller = new SubscribeController(store);
		for (let n = 0; n < 25; n++) {
			await controller.handle({
				request: {
					body: () => subscription(`https://fcm.googleapis.com/fcm/send/d${n}`),
				},
				response: { status: () => ({ json: () => {} }) },
				auth: { user: { id: "u1" } },
			});
		}
		expect(await store.listByUser("u1")).toHaveLength(20);
	});
});
