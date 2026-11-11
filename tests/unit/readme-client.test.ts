/**
 * The browser half of the README, held to the client's real signature:
 * `subscribe(vapidPublicKey, options)`. Copied from a README that passes one
 * object, the key reaches `urlBase64ToUint8Array` as that object and throws
 * before the browser is asked anything, and the options are dropped.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const README = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"README.md",
);

/** The code blocks that import from `@c9up/nova/client`. */
async function clientBlocks(): Promise<string[]> {
	const text = await readFile(README, "utf8");
	return [...text.matchAll(/```ts\n([\s\S]*?)```/g)]
		.map((match) => match[1] ?? "")
		.filter((block) => block.includes("@c9up/nova/client"));
}

describe("README > the browser half", () => {
	it("calls subscribe() with the key first and the options second", async () => {
		const calls = (await clientBlocks()).flatMap((block) => [
			...block.matchAll(/\bsubscribe\(\s*([^,)\s]*)/g),
		]);

		expect(calls.length).toBeGreaterThan(0);
		for (const [, first] of calls) {
			expect(first).not.toBe("{");
			expect(first).not.toBe("");
		}
	});
});
