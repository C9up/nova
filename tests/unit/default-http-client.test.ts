/**
 * Without an injected client, a push goes through the framework's guarded
 * one — loaded on first push, since `@c9up/ream` is an optional peer. The
 * loader is exercised through its module seam, so the suite does not depend on
 * which release of the peer (if any) is installed. That the guarded client
 * refuses private addresses is the peer's own contract, tested there.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	defaultHttpClient,
	type GuardedClientOptions,
	type ModuleLoader,
	type PushHttpClient,
} from "../../src/_internal/http.js";
import { MemorySubscriptionDriver } from "../../src/SubscriptionStore.js";
import { generateVapidKeys } from "../../src/vapid.js";
import { fakePushHttp } from "../__helpers__/http.js";

const VAPID = { ...generateVapidKeys(), subject: "mailto:test@example.com" };
const SUB = {
	endpoint: "https://fcm.googleapis.com/fcm/send/x",
	expirationTime: null,
	keys: {
		p256dh: generateVapidKeys().publicKey,
		auth: "tBHItJI5sVmRaTQX6w4qEA",
	},
};

afterEach(() => {
	vi.doUnmock("../../src/_internal/http.js");
	vi.resetModules();
	vi.restoreAllMocks();
});

/** A loader that answers `module`, and records which specifiers it was asked for. */
function loaderOf(module: unknown): {
	load: ModuleLoader;
	asked: string[];
} {
	const asked: string[] = [];
	return {
		asked,
		load: async (specifier) => {
			asked.push(specifier);
			return module;
		},
	};
}

const failingLoader: ModuleLoader = async () => {
	throw new Error("Cannot find package '@c9up/ream'");
};

/** A module whose `HttpClient` records the options it was built with. */
function guardedModule(): {
	module: { HttpClient: new (options: GuardedClientOptions) => PushHttpClient };
	built: GuardedClientOptions[];
} {
	const built: GuardedClientOptions[] = [];
	class HttpClient implements PushHttpClient {
		constructor(options: GuardedClientOptions) {
			built.push(options);
		}
		async request(): Promise<{ status: number; header: () => undefined }> {
			return { status: 201, header: () => undefined };
		}
	}
	return { module: { HttpClient }, built };
}

describe("defaultHttpClient — loading the guarded client", () => {
	it("asks for the framework's outbound client entry point", async () => {
		const { module } = guardedModule();
		const { load, asked } = loaderOf(module);
		await defaultHttpClient({}, load);
		expect(asked).toEqual(["@c9up/ream/http-client"]);
	});

	it("builds it with no redirects, Nova's user agent and the allowed hosts", async () => {
		const { module, built } = guardedModule();
		const client = await defaultHttpClient(
			{ allowHosts: ["localhost:8443"] },
			loaderOf(module).load,
		);
		expect(client).toBeInstanceOf(module.HttpClient);
		expect(built).toEqual([
			{
				maxRedirects: 0,
				userAgent: "@c9up/nova",
				allowHosts: ["localhost:8443"],
			},
		]);
	});

	it("names the missing peer when it cannot be imported", async () => {
		const failure = defaultHttpClient({}, failingLoader);
		await expect(failure).rejects.toMatchObject({
			name: "NovaError",
			code: "E_NOVA_HTTP_CLIENT_MISSING",
			message: expect.stringContaining("not installed"),
			cause: expect.objectContaining({
				message: expect.stringContaining("Cannot find package"),
			}),
		});
	});

	it.each([
		["no HttpClient export", {}],
		["a non-function HttpClient", { HttpClient: "HttpClient" }],
		["a module that is not an object", "module"],
		["null", null],
	])("refuses a copy with %s", async (_label, module) => {
		await expect(
			defaultHttpClient({}, loaderOf(module).load),
		).rejects.toMatchObject({
			code: "E_NOVA_HTTP_CLIENT_MISSING",
			message: expect.stringContaining("does not export `HttpClient`"),
		});
	});

	it("refuses an HttpClient that cannot be constructed", async () => {
		const notAConstructor = (): void => {};
		await expect(
			defaultHttpClient({}, loaderOf({ HttpClient: notAConstructor }).load),
		).rejects.toMatchObject({
			code: "E_NOVA_HTTP_CLIENT_MISSING",
			message: expect.stringContaining("could not build one"),
			cause: expect.any(TypeError),
		});
	});

	it("refuses an HttpClient whose instances cannot send", async () => {
		class HttpClient {}
		await expect(
			defaultHttpClient({}, loaderOf({ HttpClient }).load),
		).rejects.toMatchObject({
			code: "E_NOVA_HTTP_CLIENT_MISSING",
			message: expect.stringContaining("without `request()`"),
		});
	});
});

describe("Nova — the default outbound client", () => {
	/**
	 * Nova with its loader seam replaced: each push that needs the default
	 * client takes the next loader from `loaders`.
	 */
	async function novaLoadingWith(
		loaders: ModuleLoader[],
		allowHosts?: string[],
	): Promise<import("../../src/Nova.js").Nova> {
		vi.doMock("../../src/_internal/http.js", async (importOriginal) => {
			const original =
				await importOriginal<typeof import("../../src/_internal/http.js")>();
			return {
				...original,
				defaultHttpClient: (
					options: Parameters<typeof original.defaultHttpClient>[0],
				) => {
					const next = loaders.shift() ?? failingLoader;
					return original.defaultHttpClient(options, next);
				},
			};
		});
		const { Nova } = await import("../../src/Nova.js");
		return new Nova(new MemorySubscriptionDriver(), VAPID, {
			...(allowHosts === undefined ? {} : { allowHosts }),
		});
	}

	it("rejects a push with E_NOVA_HTTP_CLIENT_MISSING when the peer is absent", async () => {
		const nova = await novaLoadingWith([failingLoader]);
		await expect(nova.push(SUB, { title: "x" })).rejects.toMatchObject({
			code: "E_NOVA_HTTP_CLIENT_MISSING",
		});
	});

	it("does not keep a failed load: installing the peer and retrying works", async () => {
		const http = fakePushHttp().on("POST", () => true, { status: 201 });
		const nova = await novaLoadingWith([
			failingLoader,
			loaderOf({
				HttpClient: class {
					request = http.request;
				},
			}).load,
		]);

		await expect(nova.push(SUB, { title: "x" })).rejects.toMatchObject({
			code: "E_NOVA_HTTP_CLIENT_MISSING",
		});
		expect(await nova.push(SUB, { title: "x" })).toEqual({
			ok: true,
			status: 201,
			endpoint: SUB.endpoint,
		});
		expect(http.requests).toHaveLength(1);
	});

	it("loads the client once and builds it with the instance's allowed hosts", async () => {
		const { module, built } = guardedModule();
		const loader = loaderOf(module);
		const nova = await novaLoadingWith([loader.load], ["localhost:8443"]);

		await nova.push(SUB, { title: "x" });
		await nova.push(SUB, { title: "x" });

		expect(loader.asked).toHaveLength(1);
		expect(built).toEqual([
			{
				maxRedirects: 0,
				userAgent: "@c9up/nova",
				allowHosts: ["localhost:8443"],
			},
		]);
	});
});
