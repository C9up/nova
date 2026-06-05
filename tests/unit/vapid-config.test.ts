import { describe, expect, it } from "vitest";
import { validateVapidConfig } from "../../src/_internal/vapid-config.js";

const VALID = {
	publicKey:
		"BNcRdreALRFXTkOiHpMpfHJoDRvSgGUgmCNNxPaLyzPnlJSNiy3Y0VFm8eq2RRvODPHc4P10qOrjTlnmyUrpbyA",
	privateKey: "tBHItJI5sVmRaTQX6w4qEAtBHItJI5sVmRaTQX6w4qE",
	subject: "mailto:noreply@example.com",
};

describe("validateVapidConfig", () => {
	it("returns the config when all three fields are valid", () => {
		expect(validateVapidConfig(VALID)).toEqual(VALID);
	});

	it("accepts https:// as subject", () => {
		const result = validateVapidConfig({
			...VALID,
			subject: "https://app.example/",
		});
		expect(result.subject).toBe("https://app.example/");
	});

	it("throws NOVA_VAPID_NOT_CONFIGURED when config is undefined", () => {
		expect(() => validateVapidConfig(undefined)).toThrow(
			expect.objectContaining({ code: "NOVA_VAPID_NOT_CONFIGURED" }),
		);
	});

	it("throws when publicKey is empty", () => {
		expect(() => validateVapidConfig({ ...VALID, publicKey: "" })).toThrow(
			/publicKey is missing/,
		);
	});

	it("throws when publicKey is too short", () => {
		expect(() =>
			validateVapidConfig({ ...VALID, publicKey: "BNcRdreA" }),
		).toThrow(/publicKey is malformed/);
	});

	it("throws when publicKey contains invalid base64url chars", () => {
		const bad = `${VALID.publicKey.slice(0, -1)}!`;
		expect(() => validateVapidConfig({ ...VALID, publicKey: bad })).toThrow(
			/publicKey is malformed/,
		);
	});

	it("throws when privateKey is empty", () => {
		expect(() => validateVapidConfig({ ...VALID, privateKey: "" })).toThrow(
			/privateKey is missing/,
		);
	});

	it("throws when privateKey is too short", () => {
		expect(() => validateVapidConfig({ ...VALID, privateKey: "abc" })).toThrow(
			/privateKey is malformed/,
		);
	});

	it("throws when subject is empty", () => {
		expect(() => validateVapidConfig({ ...VALID, subject: "" })).toThrow(
			/subject is missing/,
		);
	});

	it("throws when subject has wrong prefix (no mailto: or https://)", () => {
		expect(() =>
			validateVapidConfig({ ...VALID, subject: "ftp://example" }),
		).toThrow(/must be `mailto:<address>` or `https:\/\/<host>`/);
	});

	it("throws when subject is `http://` (insecure)", () => {
		expect(() =>
			validateVapidConfig({ ...VALID, subject: "http://example" }),
		).toThrow(/must be `mailto:<address>` or `https:\/\/<host>`/);
	});

	it("throws when subject is bare `mailto:` (no address)", () => {
		expect(() => validateVapidConfig({ ...VALID, subject: "mailto:" })).toThrow(
			/non-empty content/,
		);
	});

	it("throws when subject is bare `https://` (no host)", () => {
		expect(() =>
			validateVapidConfig({ ...VALID, subject: "https://" }),
		).toThrow(/non-empty content/);
	});

	it("emits a specific hint when publicKey contains `=` padding", () => {
		const padded = `${VALID.publicKey.slice(0, -1)}=`;
		expect(() => validateVapidConfig({ ...VALID, publicKey: padded })).toThrow(
			/strip it/,
		);
	});

	it("rejects publicKey that is one char short of exact length", () => {
		const tooShort = VALID.publicKey.slice(0, -1);
		expect(() =>
			validateVapidConfig({ ...VALID, publicKey: tooShort }),
		).toThrow(/got 86 chars/);
	});

	it("rejects privateKey that is one char too long", () => {
		const tooLong = `${VALID.privateKey}A`;
		expect(() =>
			validateVapidConfig({ ...VALID, privateKey: tooLong }),
		).toThrow(/got 44 chars/);
	});

	it("invalidShape error message references the 3 env-var names", () => {
		try {
			validateVapidConfig({ ...VALID, subject: "ftp://nope" });
			throw new Error("should have thrown");
		} catch (err) {
			const message = (err as Error).message;
			expect(message).toContain("NOVA_VAPID_PUBLIC_KEY");
			expect(message).toContain("NOVA_VAPID_PRIVATE_KEY");
			expect(message).toContain("NOVA_VAPID_SUBJECT");
		}
	});
});
