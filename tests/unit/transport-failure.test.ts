import { describe, expect, it } from "vitest";
import { transportFailure } from "../../src/_internal/http.js";
import { transportError } from "../__helpers__/http.js";

describe("transportFailure", () => {
	it("reads the E_HTTP_CLIENT_* code of ream's client", () => {
		expect(
			transportFailure(transportError("timedOut", "https://push.example")),
		).toBe("timedOut");
		expect(
			transportFailure(
				transportError("privateAddress", "https://push.example"),
			),
		).toBe("privateAddress");
	});

	it("answers undefined for any other error", () => {
		expect(transportFailure(new Error("boom"))).toBeUndefined();
		expect(
			transportFailure(Object.assign(new Error("x"), { code: "E_OTHER" })),
		).toBeUndefined();
		expect(transportFailure("not an error")).toBeUndefined();
	});
});
