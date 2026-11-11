/**
 * The tokens nova binds, and what ream's container is told they resolve to.
 */

import type { ContainerBindings } from "@c9up/ream/types";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	MemorySubscriptionDriver,
	Nova,
	type NovaAppContext,
	NovaProvider,
	type SubscriptionStore,
} from "../../src/index.js";
import { asRequested } from "../__helpers__/container.js";

/** A container that keeps singletons, as ream's does. */
function appWith(prebound: Record<string, unknown> = {}): NovaAppContext {
	const factories = new Map<string | symbol, () => unknown>();
	const instances = new Map<string | symbol, unknown>(Object.entries(prebound));
	const container: NovaAppContext["container"] = {
		singleton(token, factory) {
			factories.set(token, factory);
		},
		async resolve<T = unknown>(token: string | symbol): Promise<T> {
			if (!instances.has(token)) {
				const factory = factories.get(token);
				if (!factory) throw new Error(`unbound: ${String(token)}`);
				instances.set(token, await factory());
			}
			return asRequested<T>(instances.get(token));
		},
		has: (token) => factories.has(token) || instances.has(token),
	};
	return { container, config: { get: () => undefined } };
}

describe("nova > container bindings", () => {
	it("binds nova.push and nova.subscriptions, and the older names to the same instances", async () => {
		const app = appWith();
		new NovaProvider(app).register();

		const push = await app.container.resolve("nova.push");
		const store = await app.container.resolve("nova.subscriptions");
		expect(push).toBeInstanceOf(Nova);
		expect(store).toBeInstanceOf(MemorySubscriptionDriver);
		expect(await app.container.resolve("nova")).toBe(push);
		expect(await app.container.resolve("SubscriptionStore")).toBe(store);
	});

	it("serves a store bound before it under either name, under both", async () => {
		const own = new MemorySubscriptionDriver();
		for (const token of ["SubscriptionStore", "nova.subscriptions"]) {
			const app = appWith({ [token]: own });
			new NovaProvider(app).register();

			expect(await app.container.resolve("nova.subscriptions")).toBe(own);
			expect(await app.container.resolve("SubscriptionStore")).toBe(own);
		}
	});

	it("tells ream's container what the tokens resolve to", () => {
		expectTypeOf<ContainerBindings["nova.push"]>().toEqualTypeOf<Nova>();
		expectTypeOf<ContainerBindings["nova"]>().toEqualTypeOf<Nova>();
		expectTypeOf<
			ContainerBindings["nova.subscriptions"]
		>().toEqualTypeOf<SubscriptionStore>();
		expectTypeOf<
			ContainerBindings["SubscriptionStore"]
		>().toEqualTypeOf<SubscriptionStore>();
	});
});
