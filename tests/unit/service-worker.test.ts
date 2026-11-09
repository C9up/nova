/**
 * The scaffolded service worker, run as a browser would run it: the stub's
 * body in its own context, with `self` standing in for the worker scope.
 *
 * A notification is shown under the application's name, so where a click on
 * it leads is the application's word. The URL comes from the push payload —
 * often from content (a comment link, a redirect target) — and must not open
 * another site, nor a `javascript:` or `data:` URL.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { stubsRoot } from "../../src/stubs.js";

const ORIGIN = "https://app.example.com";

function stubBody(): string {
	const raw = readFileSync(resolve(stubsRoot, "public/sw.stub"), "utf8");
	return raw.split(/^---\r?\n/m, 3)[2] ?? "";
}

interface WindowClientStub {
	url: string;
	visibilityState: string;
	focused: boolean;
	focus(): Promise<WindowClientStub>;
}

/** Load the worker and click a notification carrying `url`. */
async function click(
	url: unknown,
	open: WindowClientStub[] = [],
	body: string = stubBody(),
): Promise<{ opened: string[]; focused: string[] }> {
	const listeners = new Map<string, (event: unknown) => void>();
	const opened: string[] = [];
	const focused: string[] = [];
	const self = {
		location: { origin: ORIGIN },
		addEventListener(type: string, listener: (event: unknown) => void) {
			listeners.set(type, listener);
		},
		skipWaiting: () => undefined,
		clients: {
			claim: async () => undefined,
			matchAll: async () =>
				open.map((client) => ({
					...client,
					focus: async () => {
						focused.push(client.url);
						return client;
					},
				})),
			openWindow: async (target: string) => {
				opened.push(target);
				return null;
			},
		},
		registration: { showNotification: async () => undefined },
	};
	runInNewContext(body, { self, URL });

	const pending: Promise<unknown>[] = [];
	const listener = listeners.get("notificationclick");
	if (!listener) throw new Error("the worker registers no notificationclick");
	listener({
		notification: { close: () => undefined, data: { url } },
		waitUntil: (promise: Promise<unknown>) => pending.push(promise),
	});
	await Promise.all(pending);
	return { opened, focused };
}

describe("service worker stub — notificationclick", () => {
	it.each([
		["/inbox/42", `${ORIGIN}/inbox/42`],
		["inbox/42?tab=unread", `${ORIGIN}/inbox/42?tab=unread`],
		[`${ORIGIN}/settings`, `${ORIGIN}/settings`],
	])("opens the same-origin target %s", async (url, expected) => {
		expect((await click(url)).opened).toEqual([expected]);
	});

	it.each([
		"https://evil.example/login?next=app",
		"//evil.example/phish",
		"http://app.example.com/downgraded",
		"https://app.example.com.evil.example/",
		"javascript:alert(document.cookie)",
		"data:text/html,<script>alert(1)</script>",
		"blob:https://evil.example/uuid",
	])("opens nothing for %s", async (url) => {
		const { opened, focused } = await click(url, [
			{
				url: String(url),
				visibilityState: "visible",
				focused: true,
				focus: async function () {
					return this;
				},
			},
		]);
		expect(opened).toEqual([]);
		expect(focused).toEqual([]);
	});

	it.each([undefined, 42, { href: "/x" }])(
		"opens nothing when the url is %j",
		async (url) => {
			expect((await click(url)).opened).toEqual([]);
		},
	);

	it("focuses an open tab on the target instead of opening another", async () => {
		const tab: WindowClientStub = {
			url: `${ORIGIN}/inbox/42`,
			visibilityState: "visible",
			focused: false,
			focus: async function () {
				return this;
			},
		};
		const { opened, focused } = await click("/inbox/42", [tab]);
		expect(focused).toEqual([`${ORIGIN}/inbox/42`]);
		expect(opened).toEqual([]);
	});
});

describe("service worker stub — ALLOWED_ORIGINS", () => {
	it("opens another origin only once the app lists it", async () => {
		const listed = stubBody().replace(
			"const ALLOWED_ORIGINS = []",
			"const ALLOWED_ORIGINS = ['https://docs.example.com']",
		);
		expect(listed).not.toBe(stubBody());
		expect(
			(await click("https://docs.example.com/guide", [], listed)).opened,
		).toEqual(["https://docs.example.com/guide"]);
		expect((await click("https://evil.example/", [], listed)).opened).toEqual(
			[],
		);
	});
});
