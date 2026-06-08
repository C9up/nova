/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	NovaClientError,
	registerServiceWorker,
	subscribe,
	urlBase64ToUint8Array,
} from "../../src/client/subscribe.js";

interface SubscriptionStub {
	toJSON(): Record<string, unknown>;
}

function installNavigatorMocks(opts: {
	subscription: SubscriptionStub;
	registerSpy?: ReturnType<typeof vi.fn>;
	subscribeSpy?: ReturnType<typeof vi.fn>;
}) {
	const subscribeSpy =
		opts.subscribeSpy ?? vi.fn().mockResolvedValue(opts.subscription);
	const registration = {
		pushManager: { subscribe: subscribeSpy },
	};
	const registerSpy =
		opts.registerSpy ?? vi.fn().mockResolvedValue(registration);
	Object.defineProperty(globalThis.navigator, "serviceWorker", {
		configurable: true,
		value: {
			register: registerSpy,
			ready: Promise.resolve(registration),
		},
	});
	return { registerSpy, subscribeSpy };
}

afterEach(() => {
	vi.unstubAllGlobals();
	if ("serviceWorker" in globalThis.navigator) {
		Object.defineProperty(globalThis.navigator, "serviceWorker", {
			configurable: true,
			value: undefined,
		});
	}
});

describe("nova > client > urlBase64ToUint8Array", () => {
	it("converts a 65-byte VAPID key from base64url to a Uint8Array", () => {
		const bytes = new Uint8Array(65);
		bytes[0] = 0x04;
		for (let i = 1; i < 65; i++) bytes[i] = i;
		const encoded = btoa(String.fromCharCode(...bytes))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");

		const decoded = urlBase64ToUint8Array(encoded);
		expect(decoded).toBeInstanceOf(Uint8Array);
		expect(decoded.length).toBe(65);
		expect(decoded[0]).toBe(0x04);
		expect(Array.from(decoded.slice(1, 5))).toEqual([1, 2, 3, 4]);
	});
});

describe("nova > client > registerServiceWorker", () => {
	it("registers the SW at the default /sw.js path", async () => {
		const { registerSpy } = installNavigatorMocks({
			subscription: { toJSON: () => ({}) },
		});
		await registerServiceWorker();
		expect(registerSpy).toHaveBeenCalledWith("/sw.js", { scope: "/" });
	});

	it("registers the SW at a custom path when provided", async () => {
		const { registerSpy } = installNavigatorMocks({
			subscription: { toJSON: () => ({}) },
		});
		await registerServiceWorker("/custom-sw.js");
		expect(registerSpy).toHaveBeenCalledWith("/custom-sw.js", { scope: "/" });
	});

	it("throws NovaClientError when serviceWorker is unavailable", async () => {
		Object.defineProperty(globalThis.navigator, "serviceWorker", {
			configurable: true,
			value: undefined,
		});
		await expect(registerServiceWorker()).rejects.toBeInstanceOf(
			NovaClientError,
		);
	});
});

describe("nova > client > subscribe", () => {
	const VAPID_KEY = "BNcRdreA-fake-vapid-public-key";
	const SAMPLE_PUSH = {
		endpoint: "https://fcm.googleapis.com/fcm/send/abc",
		keys: { p256dh: "p256-fake", auth: "auth-fake" },
	};

	it("posts the subscription JSON to the default endpoint", async () => {
		const subscription: SubscriptionStub = { toJSON: () => SAMPLE_PUSH };
		installNavigatorMocks({ subscription });
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(
				new Response(
					JSON.stringify({ ok: true, endpoint: SAMPLE_PUSH.endpoint }),
					{ status: 201 },
				),
			);
		vi.stubGlobal("fetch", fetchSpy);

		const result = await subscribe(VAPID_KEY);
		expect(result).toBe(subscription);
		expect(fetchSpy).toHaveBeenCalledWith(
			"/api/nova/subscribe",
			expect.objectContaining({
				method: "POST",
				credentials: "include",
			}),
		);
		const callArgs = fetchSpy.mock.calls[0] as [string, RequestInit];
		const init = callArgs[1];
		expect(init.body).toBe(JSON.stringify(SAMPLE_PUSH));
		const headers = init.headers as Headers;
		expect(headers.get("content-type")).toBe("application/json");
	});

	it("forwards a Bearer accessToken in the Authorization header", async () => {
		const subscription: SubscriptionStub = { toJSON: () => SAMPLE_PUSH };
		installNavigatorMocks({ subscription });
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 201 }));
		vi.stubGlobal("fetch", fetchSpy);

		await subscribe(VAPID_KEY, { accessToken: "abc.def.ghi" });
		const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit)
			.headers as Headers;
		expect(headers.get("authorization")).toBe("Bearer abc.def.ghi");
		expect(headers.get("content-type")).toBe("application/json");
	});

	it("merges custom headers and lets them override the accessToken shortcut", async () => {
		const subscription: SubscriptionStub = { toJSON: () => SAMPLE_PUSH };
		installNavigatorMocks({ subscription });
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 201 }));
		vi.stubGlobal("fetch", fetchSpy);

		await subscribe(VAPID_KEY, {
			accessToken: "shorthand-token",
			headers: {
				authorization: "Bearer explicit-token",
				"x-tenant-id": "t-42",
			},
		});
		const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit)
			.headers as Headers;
		expect(headers.get("authorization")).toBe("Bearer explicit-token");
		expect(headers.get("x-tenant-id")).toBe("t-42");
	});

	it("does not synthesize an Authorization header when neither accessToken nor headers provide one", async () => {
		const subscription: SubscriptionStub = { toJSON: () => SAMPLE_PUSH };
		installNavigatorMocks({ subscription });
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 201 }));
		vi.stubGlobal("fetch", fetchSpy);

		await subscribe(VAPID_KEY);
		const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit)
			.headers as Headers;
		expect(headers.has("authorization")).toBe(false);
	});

	it("honours custom endpoint and credentials", async () => {
		const subscription: SubscriptionStub = { toJSON: () => SAMPLE_PUSH };
		installNavigatorMocks({ subscription });
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 201 }));
		vi.stubGlobal("fetch", fetchSpy);

		await subscribe(VAPID_KEY, {
			endpoint: "/v2/push/subscribe",
			credentials: "same-origin",
		});
		expect(fetchSpy).toHaveBeenCalledWith(
			"/v2/push/subscribe",
			expect.objectContaining({ credentials: "same-origin" }),
		);
	});

	it("calls pushManager.subscribe with userVisibleOnly + applicationServerKey", async () => {
		const subscription: SubscriptionStub = { toJSON: () => SAMPLE_PUSH };
		const { subscribeSpy } = installNavigatorMocks({ subscription });
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("{}", { status: 201 })),
		);

		await subscribe(VAPID_KEY);
		const args = subscribeSpy.mock.calls[0]?.[0] as PushSubscriptionOptionsInit;
		expect(args.userVisibleOnly).toBe(true);
		expect(args.applicationServerKey).toBeInstanceOf(Uint8Array);
	});

	it("throws NovaClientError on non-2xx response", async () => {
		const subscription: SubscriptionStub = { toJSON: () => SAMPLE_PUSH };
		installNavigatorMocks({ subscription });
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					new Response("nope", { status: 401, statusText: "Unauthorized" }),
				),
		);

		await expect(subscribe(VAPID_KEY)).rejects.toMatchObject({
			name: "NovaClientError",
			status: 401,
			responseBody: "nope",
		});
	});

	it("throws NovaClientError when serviceWorker is unavailable", async () => {
		Object.defineProperty(globalThis.navigator, "serviceWorker", {
			configurable: true,
			value: undefined,
		});
		await expect(subscribe(VAPID_KEY)).rejects.toBeInstanceOf(NovaClientError);
	});
});
