/**
 * Integration test — multi-device fan-out via `nova.pushToUser()`.
 * Verifies parallel dispatch, per-subscription error isolation, and
 * automatic cleanup of stale subscriptions during the fan-out.
 */

import nock from "nock";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NovaVapidConfig } from "../../src/config.js";
import { Nova } from "../../src/Nova.js";
import {
	MemorySubscriptionDriver,
	type PushSubscription,
} from "../../src/SubscriptionStore.js";
import { generateVapidKeys } from "../../src/vapid.js";

const HOST_FCM = "https://fcm.googleapis.com";
const HOST_MOZ = "https://updates.push.services.mozilla.com";
const HOST_APN = "https://web.push.apple.com";

const PATH_FCM = "/fcm/send/device-1";
const PATH_MOZ = "/wpush/v2/device-2";
const PATH_APN = "/3/device/device-3";

let SUB_FCM: PushSubscription;
let SUB_MOZ: PushSubscription;
let SUB_APN: PushSubscription;
let VAPID: NovaVapidConfig;

beforeAll(() => {
	VAPID = { ...generateVapidKeys(), subject: "mailto:test@example.com" };
	const k1 = generateVapidKeys();
	const k2 = generateVapidKeys();
	const k3 = generateVapidKeys();
	SUB_FCM = mkSub(`${HOST_FCM}${PATH_FCM}`, k1.publicKey);
	SUB_MOZ = mkSub(`${HOST_MOZ}${PATH_MOZ}`, k2.publicKey);
	SUB_APN = mkSub(`${HOST_APN}${PATH_APN}`, k3.publicKey);
});

function mkSub(endpoint: string, p256dh: string): PushSubscription {
	return {
		endpoint,
		expirationTime: null,
		keys: { p256dh, auth: "tBHItJI5sVmRaTQX6w4qEA" },
	};
}

beforeEach(() => {
	nock.disableNetConnect();
});

afterEach(() => {
	nock.cleanAll();
	nock.enableNetConnect();
});

describe("nova.pushToUser() — multi-device fan-out", () => {
	it("returns [] when the user has no subscriptions", async () => {
		const nova = new Nova(new MemorySubscriptionDriver(), VAPID);
		expect(await nova.pushToUser("nobody", { title: "x" })).toEqual([]);
	});

	it("pushes to every subscription and returns all results", async () => {
		nock(HOST_FCM).post(PATH_FCM).reply(201, "");
		nock(HOST_MOZ).post(PATH_MOZ).reply(201, "");
		nock(HOST_APN).post(PATH_APN).reply(201, "");

		const store = new MemorySubscriptionDriver();
		await store.save("u1", SUB_FCM);
		await store.save("u1", SUB_MOZ);
		await store.save("u1", SUB_APN);

		const nova = new Nova(store, VAPID);
		const results = await nova.pushToUser("u1", { title: "broadcast" });

		expect(results).toHaveLength(3);
		expect(results.every((r) => r.ok === true)).toBe(true);
	});

	it("isolates failures: 410 cleans only the gone sub, others succeed", async () => {
		nock(HOST_FCM).post(PATH_FCM).reply(201, ""); // ok
		nock(HOST_MOZ).post(PATH_MOZ).reply(410, ""); // gone — should clean
		nock(HOST_APN).post(PATH_APN).reply(201, ""); // ok

		const store = new MemorySubscriptionDriver();
		await store.save("u1", SUB_FCM);
		await store.save("u1", SUB_MOZ);
		await store.save("u1", SUB_APN);

		const nova = new Nova(store, VAPID);
		const results = await nova.pushToUser("u1", { title: "fan-out" });

		expect(results).toHaveLength(3);
		const goneResult = results.find((r) => r.endpoint === SUB_MOZ.endpoint);
		expect(goneResult).toMatchObject({
			ok: false,
			status: 410,
			reason: "gone",
			cleaned: true,
		});

		const remaining = await store.listByUser("u1");
		expect(remaining).toHaveLength(2);
		const remainingEndpoints = remaining.map((s) => s.endpoint);
		expect(remainingEndpoints).toContain(SUB_FCM.endpoint);
		expect(remainingEndpoints).toContain(SUB_APN.endpoint);
		expect(remainingEndpoints).not.toContain(SUB_MOZ.endpoint);
	});

	it("isolates failures: mixed 5xx + 200 — neither cleaned", async () => {
		nock(HOST_FCM).post(PATH_FCM).reply(503, "down");
		nock(HOST_MOZ).post(PATH_MOZ).reply(201, "");

		const store = new MemorySubscriptionDriver();
		await store.save("u1", SUB_FCM);
		await store.save("u1", SUB_MOZ);

		const nova = new Nova(store, VAPID);
		const results = await nova.pushToUser("u1", { title: "x" });

		expect(results).toHaveLength(2);
		expect(await store.listByUser("u1")).toHaveLength(2); // nothing cleaned
	});
});
