import { describe, expect, it } from "vitest";
import {
	decodeBase64Url,
	encodeBase64Url,
} from "../../src/_internal/base64url.js";
import { generateVapidKeys } from "../../src/vapid.js";

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

describe("nova > vapid", () => {
	it("returns base64url-shaped public + private keys", () => {
		const { publicKey, privateKey } = generateVapidKeys();
		expect(publicKey).toMatch(BASE64URL_RE);
		expect(privateKey).toMatch(BASE64URL_RE);
		expect(publicKey.includes("=")).toBe(false);
		expect(publicKey.includes("+")).toBe(false);
		expect(publicKey.includes("/")).toBe(false);
		expect(privateKey.includes("=")).toBe(false);
		expect(privateKey.includes("+")).toBe(false);
		expect(privateKey.includes("/")).toBe(false);
	});

	it("public key decodes to 65 bytes starting with 0x04", () => {
		const { publicKey } = generateVapidKeys();
		const raw = decodeBase64Url(publicKey);
		expect(raw.length).toBe(65);
		expect(raw[0]).toBe(0x04);
	});

	it("private key decodes to a 32-byte scalar", () => {
		const { privateKey } = generateVapidKeys();
		const raw = decodeBase64Url(privateKey);
		expect(raw.length).toBe(32);
	});

	it("produces a different pair on every invocation", () => {
		const a = generateVapidKeys();
		const b = generateVapidKeys();
		expect(a.publicKey).not.toBe(b.publicKey);
		expect(a.privateKey).not.toBe(b.privateKey);
	});
});

describe("nova > base64url helpers", () => {
	it("round-trips arbitrary bytes", () => {
		const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
		const encoded = encodeBase64Url(bytes);
		expect(encoded).toMatch(BASE64URL_RE);
		const decoded = decodeBase64Url(encoded);
		expect(Array.from(decoded)).toEqual(Array.from(bytes));
	});

	it("emits no padding characters", () => {
		expect(encodeBase64Url(new Uint8Array([1]))).not.toContain("=");
		expect(encodeBase64Url(new Uint8Array([1, 2]))).not.toContain("=");
		expect(encodeBase64Url(new Uint8Array([1, 2, 3]))).not.toContain("=");
	});

	it("decodes input that arrives with padding", () => {
		const padded = "AQID";
		const decoded = decodeBase64Url(`${padded}==`);
		expect(Array.from(decoded)).toEqual([1, 2, 3]);
	});
});
