import { describe, expect, it } from "vitest";
import {
	MemorySubscriptionDriver,
	type PushSubscription,
} from "../../src/SubscriptionStore.js";

function fixture(
	endpoint = "https://fcm.googleapis.com/fcm/send/abc",
): PushSubscription {
	return {
		endpoint,
		expirationTime: null,
		keys: { p256dh: "BNcRdreA-fake", auth: "tBHItJI5sVm-fake" },
	};
}

describe("nova > MemorySubscriptionDriver", () => {
	it("saves and lists by user", async () => {
		const store = new MemorySubscriptionDriver();
		await store.save("u1", fixture("https://example/a"));
		await store.save("u1", fixture("https://example/b"));
		await store.save("u2", fixture("https://example/c"));

		const u1 = await store.listByUser("u1");
		expect(u1.map((s) => s.endpoint).sort()).toEqual([
			"https://example/a",
			"https://example/b",
		]);

		const u2 = await store.listByUser("u2");
		expect(u2).toHaveLength(1);
	});

	it("upserts on duplicate endpoint for the same user", async () => {
		const store = new MemorySubscriptionDriver();
		const first = fixture("https://example/dup");
		first.keys.auth = "old-auth";
		await store.save("u1", first);
		const replacement = fixture("https://example/dup");
		replacement.keys.auth = "new-auth";
		await store.save("u1", replacement);

		const list = await store.listByUser("u1");
		expect(list).toHaveLength(1);
		expect(list[0]?.keys.auth).toBe("new-auth");
	});

	it("returns an empty array for an unknown user", async () => {
		const store = new MemorySubscriptionDriver();
		const list = await store.listByUser("nobody");
		expect(list).toEqual([]);
	});

	it("deletes an existing subscription by endpoint", async () => {
		const store = new MemorySubscriptionDriver();
		await store.save("u1", fixture("https://example/keep"));
		await store.save("u1", fixture("https://example/drop"));
		await store.delete("https://example/drop");

		const remaining = await store.listByUser("u1");
		expect(remaining.map((s) => s.endpoint)).toEqual(["https://example/keep"]);
	});

	it("does not throw when deleting an unknown endpoint", async () => {
		const store = new MemorySubscriptionDriver();
		await expect(
			store.delete("https://example/never-saved"),
		).resolves.toBeUndefined();
	});

	it("re-saving the same endpoint under a new user moves it (no cross-account leak)", async () => {
		// Shared-device scenario: u1 subscribes the browser, logs out,
		// u2 logs in and the same browser endpoint re-subscribes. The
		// endpoint must end up bound to u2 ONLY — otherwise push
		// notifications fan out to u1's account whenever u2 receives one.
		const store = new MemorySubscriptionDriver();
		const endpoint = "https://example/shared-browser";
		await store.save("u1", fixture(endpoint));
		await store.save("u2", fixture(endpoint));

		const u1 = await store.listByUser("u1");
		const u2 = await store.listByUser("u2");
		expect(u1).toEqual([]);
		expect(u2.map((s) => s.endpoint)).toEqual([endpoint]);
	});

	it("re-saving the same endpoint under the SAME user is still idempotent", async () => {
		const store = new MemorySubscriptionDriver();
		const endpoint = "https://example/re-subscribed";
		await store.save("u1", fixture(endpoint));
		// Re-save (e.g. PushManager.subscribe() returned the same endpoint).
		await store.save("u1", fixture(endpoint));
		const listed = await store.listByUser("u1");
		expect(listed.map((s) => s.endpoint)).toEqual([endpoint]);
	});
});
