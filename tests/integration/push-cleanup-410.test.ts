/**
 * Integration test — RFC 8030 §7.3 mandates that subscriptions returning
 * 404/410 are gone. `nova.push()` MUST call `store.delete(endpoint)` so the
 * caller's bucket doesn't grow unboundedly with dead subscriptions.
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

const ENDPOINT_HOST = "https://updates.push.services.mozilla.com";
const ENDPOINT_PATH = "/wpush/v2/cleanup-410-test";
const ENDPOINT = `${ENDPOINT_HOST}${ENDPOINT_PATH}`;

let SUB: PushSubscription;
let VAPID: NovaVapidConfig;

beforeAll(() => {
	VAPID = { ...generateVapidKeys(), subject: "mailto:test@example.com" };
	const ephemeral = generateVapidKeys();
	SUB = {
		endpoint: ENDPOINT,
		expirationTime: null,
		keys: {
			p256dh: ephemeral.publicKey,
			auth: "tBHItJI5sVmRaTQX6w4qEA",
		},
	};
});

beforeEach(() => {
	nock.disableNetConnect();
});

afterEach(() => {
	nock.cleanAll();
	nock.enableNetConnect();
});

describe("nova.push() — 410 cleanup contract", () => {
	it("calls store.delete(endpoint) and returns cleaned=true on 410", async () => {
		nock(ENDPOINT_HOST).post(ENDPOINT_PATH).reply(410, "");

		const store = new MemorySubscriptionDriver();
		await store.save("u1", SUB);
		expect(await store.listByUser("u1")).toHaveLength(1);

		const nova = new Nova(store, VAPID);
		const result = await nova.push(SUB, { title: "should-be-gone" });

		expect(result).toEqual({
			ok: false,
			status: 410,
			endpoint: ENDPOINT,
			reason: "gone",
			cleaned: true,
		});
		expect(await store.listByUser("u1")).toEqual([]);
	});

	it("calls store.delete(endpoint) and returns cleaned=true on 404", async () => {
		nock(ENDPOINT_HOST).post(ENDPOINT_PATH).reply(404, "");

		const store = new MemorySubscriptionDriver();
		await store.save("u1", SUB);
		const nova = new Nova(store, VAPID);
		const result = await nova.push(SUB, { title: "ditto" });

		expect(result).toMatchObject({
			ok: false,
			status: 404,
			reason: "gone",
			cleaned: true,
		});
		expect(await store.listByUser("u1")).toEqual([]);
	});

	it("does NOT cleanup on non-gone failures (e.g., 429)", async () => {
		nock(ENDPOINT_HOST).post(ENDPOINT_PATH).reply(429, "rate-limited");

		const store = new MemorySubscriptionDriver();
		await store.save("u1", SUB);
		const nova = new Nova(store, VAPID);
		const result = await nova.push(SUB, { title: "too-fast" });

		expect(result).toMatchObject({
			ok: false,
			status: 429,
			reason: "rate-limited",
			cleaned: false,
		});
		expect(await store.listByUser("u1")).toHaveLength(1);
	});
});
