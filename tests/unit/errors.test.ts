import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { errors as clientErrors } from "../../src/client/subscribe.js";
import { errors } from "../../src/index.js";

describe("errors", () => {
	it("are exported as one namespace of flare exceptions", () => {
		const error = new errors.E_NOVA_SUBSCRIPTION_CONFLICT();
		expect(error).toBeInstanceOf(Exception);
		expect(error).toMatchObject({
			code: "E_NOVA_SUBSCRIPTION_CONFLICT",
			status: 409,
		});
		expect(new errors.E_NOVA_INVALID_SUBSCRIPTION("no keys")).toMatchObject({
			status: 400,
			message: "This subscription cannot be stored: no keys.",
		});
		expect(new errors.E_NOVA_NOT_BOOTED()).toMatchObject({
			code: "E_NOVA_NOT_BOOTED",
			status: 500,
		});
	});

	it("are exported by the browser client too", () => {
		const error = new clientErrors.E_NOVA_ENDPOINT_REJECTED(
			"subscribe",
			{ status: 401, statusText: "Unauthorized" },
			"nope",
		);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toMatchObject({
			code: "E_NOVA_ENDPOINT_REJECTED",
			status: 401,
			responseBody: "nope",
			message:
				"Nova subscribe endpoint responded 401 Unauthorized (expected 201)",
		});
	});
});
