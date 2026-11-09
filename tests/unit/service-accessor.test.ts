/**
 * The `services/main` accessor, before and after boot.
 *
 * It stands in for a singleton that does not exist until `NovaProvider.boot()`
 * runs, and a module loader inspects what it imports long before anyone uses
 * it — reading `then` to decide whether the namespace is thenable, and symbols
 * for interop. Throwing on those turns a plain import into a crash at import
 * time, far from any real use, which is what makes this worth pinning.
 */
import { describe, expect, it } from "vitest";
import { Nova, type PushPayload, type PushResult } from "../../src/Nova.js";
import { MemorySubscriptionDriver } from "../../src/SubscriptionStore.js";
import push, { getPush, setPush } from "../../src/services/main.js";

/** A real Nova, marked, whose pushToUser says which instance answered. */
class MarkedNova extends Nova {
	readonly marker = "the-instance";

	override async pushToUser(
		userId: string | number | bigint,
		_payload: PushPayload,
	): Promise<PushResult[]> {
		// `this` must be the instance, which is what `.bind` is there for.
		return [
			{ ok: true, status: 201, endpoint: `${String(userId)}@${this.marker}` },
		];
	}
}

function fakeNova(): MarkedNova {
	return new MarkedNova(new MemorySubscriptionDriver(), undefined);
}

describe("nova > the service accessor before boot", () => {
	it("answers undefined to `then` instead of throwing", () => {
		// A loader reads this to decide whether the module namespace is a
		// thenable. Throwing here breaks `import { setPush } from …`.
		expect(Reflect.get(push, "then")).toBeUndefined();
	});

	it("answers undefined to a symbol instead of throwing", () => {
		expect(Reflect.get(push, Symbol.toStringTag)).toBeUndefined();
		expect(Reflect.get(push, Symbol.iterator)).toBeUndefined();
		// Node's inspector reaches for this one when printing a value.
		expect(
			Reflect.get(push, Symbol.for("nodejs.util.inspect.custom")),
		).toBeUndefined();
	});

	it("reports on a genuine access, naming what to wire", () => {
		expect(() => Reflect.get(push, "pushToUser")).toThrow(
			/accessed before NovaProvider.boot\(\).*reamrc/s,
		);
	});

	it("has no singleton yet", () => {
		expect(getPush()).toBeUndefined();
	});
});

describe("nova > the service accessor after boot", () => {
	it("forwards a method bound to the instance", async () => {
		const nova = fakeNova();
		setPush(nova);

		expect(getPush()).toBe(nova);
		// Taken off the proxy and called detached — `this` still has to be the
		// instance, or every `push.pushToUser(...)` in an application breaks.
		const { pushToUser } = push;
		expect(await pushToUser("u-1", { title: "hi" })).toEqual([
			{ ok: true, status: 201, endpoint: "u-1@the-instance" },
		]);
	});

	it("forwards a non-function member as it is", () => {
		setPush(fakeNova());

		expect(Reflect.get(push, "marker")).toBe("the-instance");
	});
});
