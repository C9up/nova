/**
 * Without an injected client, a push goes through the framework's guarded
 * one — loaded on first push, since `@c9up/ream` is an optional peer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySubscriptionDriver } from "../../src/SubscriptionStore.js";
import { generateVapidKeys } from "../../src/vapid.js";

const VAPID = { ...generateVapidKeys(), subject: "mailto:test@example.com" };
const KEYS = {
	p256dh: generateVapidKeys().publicKey,
	auth: "tBHItJI5sVmRaTQX6w4qEA",
};

afterEach(() => {
	vi.doUnmock("@c9up/ream/http-client");
	vi.resetModules();
	vi.restoreAllMocks();
});

describe("Nova — the default outbound client", () => {
	it("refuses a loopback endpoint without opening a connection", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const { Nova } = await import("../../src/Nova.js");
		const nova = new Nova(new MemorySubscriptionDriver(), VAPID);
		const endpoint = "https://127.0.0.1:1/push";

		const result = await nova.push(
			{ endpoint, expirationTime: null, keys: KEYS },
			{
				title: "x",
			},
		);

		expect(result).toMatchObject({ ok: false, status: 0, endpoint });
		expect(String(logged.mock.calls[0]?.[0])).toContain("privateAddress");
	});

	it("names the missing peer when @c9up/ream is not installed", async () => {
		vi.doMock("@c9up/ream/http-client", () => {
			throw new Error("Cannot find package '@c9up/ream'");
		});
		const { Nova } = await import("../../src/Nova.js");
		const nova = new Nova(new MemorySubscriptionDriver(), VAPID);

		await expect(
			nova.push(
				{
					endpoint: "https://fcm.googleapis.com/fcm/send/x",
					expirationTime: null,
					keys: KEYS,
				},
				{ title: "x" },
			),
		).rejects.toMatchObject({ code: "E_NOVA_HTTP_CLIENT_MISSING" });
	});
});
