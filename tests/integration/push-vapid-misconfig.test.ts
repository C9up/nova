/**
 * Integration test — calling `nova.push()` with no/incomplete VAPID config
 * must throw `NovaError('NOVA_VAPID_NOT_CONFIGURED', ...)` on the first
 * push, NOT at construction time (so apps that never push don't fail to
 * boot just because the env vars aren't wired).
 */

import { describe, expect, it } from "vitest";
import { Nova } from "../../src/Nova.js";
import {
	MemorySubscriptionDriver,
	type PushSubscription,
} from "../../src/SubscriptionStore.js";

const SUB: PushSubscription = {
	endpoint: "https://fcm.googleapis.com/fcm/send/whatever",
	expirationTime: null,
	keys: {
		p256dh:
			"BNcRdreALRFXTkOiHpMpfHJoDRvSgGUgmCNNxPaLyzPnlJSNiy3Y0VFm8eq2RRvODPHc4P10qOrjTlnmyUrpbyA",
		auth: "tBHItJI5sVmRaTQX6w4qEA",
	},
};

describe("nova.push() — VAPID misconfiguration", () => {
	it("does not throw at construction when vapid is undefined", () => {
		expect(
			() => new Nova(new MemorySubscriptionDriver(), undefined),
		).not.toThrow();
	});

	it("throws NovaError(NOVA_VAPID_NOT_CONFIGURED) on first push", async () => {
		const nova = new Nova(new MemorySubscriptionDriver(), undefined);
		await expect(nova.push(SUB, { title: "boom" })).rejects.toMatchObject({
			code: "NOVA_VAPID_NOT_CONFIGURED",
		});
	});

	it("error message references the 3 env-var names so the user knows what to fix", async () => {
		const nova = new Nova(new MemorySubscriptionDriver(), undefined);
		try {
			await nova.push(SUB, { title: "boom" });
			throw new Error("should have thrown");
		} catch (err) {
			const message = (err as Error).message;
			expect(message).toContain("NOVA_VAPID_PUBLIC_KEY");
			expect(message).toContain("NOVA_VAPID_PRIVATE_KEY");
			expect(message).toContain("NOVA_VAPID_SUBJECT");
		}
	});
});
