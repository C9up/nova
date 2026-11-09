/**
 * Without an injected client, a push goes through the framework's guarded
 * one — loaded on first push, since `@c9up/ream` is an optional peer.
 */

import dns, { type LookupAddress } from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySubscriptionDriver } from "../../src/SubscriptionStore.js";
import { generateVapidKeys } from "../../src/vapid.js";

const VAPID = { ...generateVapidKeys(), subject: "mailto:test@example.com" };
const KEYS = {
	p256dh: generateVapidKeys().publicKey,
	auth: "tBHItJI5sVmRaTQX6w4qEA",
};
const realLookup = dns.lookup;

afterEach(() => {
	Object.defineProperty(dns, "lookup", { value: realLookup, writable: true });
	syncBuiltinESMExports();
	vi.doUnmock("@c9up/ream/http-client");
	vi.resetModules();
	vi.restoreAllMocks();
});

/** Every name resolves to `address`, and each lookup is counted. */
function resolveEverythingTo(address: string): { lookups: string[] } {
	const lookups: string[] = [];
	const fake = (
		hostname: string,
		_options: unknown,
		callback: (error: null, addresses: LookupAddress[]) => void,
	): void => {
		lookups.push(hostname);
		callback(null, [{ address, family: address.includes(":") ? 6 : 4 }]);
	};
	Object.defineProperty(dns, "lookup", { value: fake, writable: true });
	syncBuiltinESMExports();
	return { lookups };
}

describe("Nova — the default outbound client", () => {
	it("refuses a push-service name that resolves to loopback (rebinding)", async () => {
		const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
		const dnsCalls = resolveEverythingTo("127.0.0.1");
		const { Nova } = await import("../../src/Nova.js");
		const nova = new Nova(new MemorySubscriptionDriver(), VAPID, {
			pushServices: ["push.example.net"],
		});
		const endpoint = "https://updates.push.example.net/wpush/v2/x";

		const result = await nova.push(
			{ endpoint, expirationTime: null, keys: KEYS },
			{ title: "x" },
		);

		expect(result).toEqual({
			ok: false,
			status: 0,
			endpoint,
			reason: "refused",
			cleaned: false,
		});
		// Decided on the address the socket would have used, not on the name.
		expect(dnsCalls.lookups).toContain("updates.push.example.net");
		expect(String(warned.mock.calls[0]?.[0])).toContain("privateAddress");
	}, 15_000);

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
	}, 15_000);
});
