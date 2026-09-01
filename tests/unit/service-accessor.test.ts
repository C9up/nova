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
import type { Nova, PushPayload } from "../../src/Nova.js";
import push, { getPush, setPush } from "../../src/services/main.js";

/** Just enough of a Nova to prove binding and forwarding. */
function fakeNova(): Nova {
	const self = {
		marker: "the-instance",
		// The real arity, so the stub cannot drift from what it stands in for.
		pushToUser(userId: string, _payload: PushPayload) {
			// `this` must be the instance, which is what `.bind` is there for.
			return `${userId}@${(this as { marker: string }).marker}`;
		},
	};
	return self as unknown as Nova;
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
		expect(pushToUser("u-1", { title: "hi" })).toBe("u-1@the-instance");
	});

	it("forwards a non-function member as it is", () => {
		setPush(fakeNova());

		expect(Reflect.get(push, "marker")).toBe("the-instance");
	});
});
