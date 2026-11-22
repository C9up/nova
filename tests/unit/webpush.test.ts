/**
 * The Web Push request Nova builds: RFC 8291 encryption checked against the
 * RFC's own example, RFC 8292 tokens against its example, and a round trip
 * through a receiver written from RFC 8291 §3.4 (what a browser does).
 */

import {
	createDecipheriv,
	createECDH,
	createPublicKey,
	hkdfSync,
	verify,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	buildPushRequest,
	encryptAes128gcm,
	vapidToken,
} from "../../src/_internal/webpush.js";
import { generateVapidKeys } from "../../src/vapid.js";

/** base64url as the RFCs print it, line breaks and indentation included. */
function rfc(text: string): Buffer {
	return Buffer.from(text.replace(/\s+/g, ""), "base64url");
}

// RFC 8291 §5 and Appendix A.
const PLAINTEXT = rfc(
	"V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
);
const UA_PUBLIC = rfc(`BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx
                     aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4`);
const UA_PRIVATE = rfc("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94");
const AS_PRIVATE = rfc("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
const AUTH_SECRET = rfc("BTBZMqHH6r4Tts7J_aSIgg");
const SALT = rfc("DGv6ra1nlYgDCS1FRnbzlw");
const MESSAGE =
	rfc(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
   mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
   pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`);

/** The user agent's side of RFC 8291 §3.4: header, keys, then the record. */
function decrypt(
	message: Buffer,
	uaPrivate: Buffer,
	authSecret: Buffer,
): Buffer {
	const salt = message.subarray(0, 16);
	const recordSize = message.readUInt32BE(16);
	const keyIdLength = message.readUInt8(20);
	const asPublic = message.subarray(21, 21 + keyIdLength);
	const record = message.subarray(21 + keyIdLength);
	expect(recordSize).toBeGreaterThan(record.length);
	const ua = createECDH("prime256v1");
	ua.setPrivateKey(uaPrivate);
	const keyInfo = Buffer.concat([
		Buffer.from("WebPush: info\0"),
		ua.getPublicKey(),
		asPublic,
	]);
	const ikm = Buffer.from(
		hkdfSync("sha256", ua.computeSecret(asPublic), authSecret, keyInfo, 32),
	);
	const cek = hkdfSync(
		"sha256",
		ikm,
		salt,
		Buffer.from("Content-Encoding: aes128gcm\0"),
		16,
	);
	const nonce = hkdfSync(
		"sha256",
		ikm,
		salt,
		Buffer.from("Content-Encoding: nonce\0"),
		12,
	);
	const decipher = createDecipheriv(
		"aes-128-gcm",
		Buffer.from(cek),
		Buffer.from(nonce),
	);
	decipher.setAuthTag(record.subarray(record.length - 16));
	const padded = Buffer.concat([
		decipher.update(record.subarray(0, record.length - 16)),
		decipher.final(),
	]);
	// RFC 8291 §4: the delimiter MUST be 0x02; no padding is added.
	expect(padded.at(-1)).toBe(0x02);
	return padded.subarray(0, padded.length - 1);
}

describe("aes128gcm encryption (RFC 8291)", () => {
	it("reproduces the RFC 8291 §5 message byte for byte", () => {
		const message = encryptAes128gcm(PLAINTEXT, UA_PUBLIC, AUTH_SECRET, {
			salt: SALT,
			senderPrivateKey: AS_PRIVATE,
		});
		expect(message.equals(MESSAGE)).toBe(true);
	});

	it("is read back by a receiver that follows the RFC", () => {
		expect(decrypt(MESSAGE, UA_PRIVATE, AUTH_SECRET).equals(PLAINTEXT)).toBe(
			true,
		);
	});

	it("uses a fresh key and salt for every message", () => {
		const first = encryptAes128gcm(PLAINTEXT, UA_PUBLIC, AUTH_SECRET);
		const second = encryptAes128gcm(PLAINTEXT, UA_PUBLIC, AUTH_SECRET);
		expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false);
		expect(first.subarray(21, 86).equals(second.subarray(21, 86))).toBe(false);
		expect(decrypt(first, UA_PRIVATE, AUTH_SECRET).equals(PLAINTEXT)).toBe(
			true,
		);
	});

	it("fits the largest payload Nova sends in the one 4096-octet record", () => {
		const largest = Buffer.alloc(3993, 0x61);
		const message = encryptAes128gcm(largest, UA_PUBLIC, AUTH_SECRET);
		// 86-octet header + 3993 + 1 delimiter + 16-octet tag: exactly 4096.
		expect(message.length).toBe(4096);
		expect(decrypt(message, UA_PRIVATE, AUTH_SECRET).equals(largest)).toBe(
			true,
		);
	});

	it("refuses a user agent key that is not a P-256 point", () => {
		const notAPoint = Buffer.alloc(65, 0x04);
		expect(() => encryptAes128gcm(PLAINTEXT, notAPoint, AUTH_SECRET)).toThrow();
	});
});

describe("VAPID token (RFC 8292)", () => {
	// RFC 8292 §2.4, Figures 1 and 2.
	const RFC_TOKEN = `eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3
        B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1ha
        Wx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_H
        LGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA`.replace(
		/\s+/g,
		"",
	);

	it("signs the very input the RFC example signs", () => {
		const { privateKey } = generateVapidKeys();
		const token = vapidToken(
			"https://push.example.net",
			"mailto:push@example.com",
			privateKey,
			1453523768,
		);
		const [header, claims] = token.split(".");
		expect(`${header}.${claims}`).toBe(
			RFC_TOKEN.split(".").slice(0, 2).join("."),
		);
	});

	it("writes the signature in the JOSE form the RFC example verifies in", () => {
		const key = createPublicKey({
			key: {
				kty: "EC",
				crv: "P-256",
				x: "DUfHPKLVFQzVvnCPGyfucbECzPDa7rWbXriLcysAjEc",
				y: "F6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs",
			},
			format: "jwk",
		});
		const [header, claims, signature] = RFC_TOKEN.split(".");
		expect(
			verify(
				"sha256",
				Buffer.from(`${header}.${claims}`),
				{ key, dsaEncoding: "ieee-p1363" },
				Buffer.from(signature ?? "", "base64url"),
			),
		).toBe(true);
	});

	it("signs with the configured key, verifiable by its public half", () => {
		const vapid = generateVapidKeys();
		const token = vapidToken(
			"https://push.example.net",
			"mailto:a@b.c",
			vapid.privateKey,
			1,
		);
		const point = Buffer.from(vapid.publicKey, "base64url");
		const key = createPublicKey({
			key: {
				kty: "EC",
				crv: "P-256",
				x: point.subarray(1, 33).toString("base64url"),
				y: point.subarray(33).toString("base64url"),
			},
			format: "jwk",
		});
		const [header, claims, signature] = token.split(".");
		expect(
			verify(
				"sha256",
				Buffer.from(`${header}.${claims}`),
				{ key, dsaEncoding: "ieee-p1363" },
				Buffer.from(signature ?? "", "base64url"),
			),
		).toBe(true);
	});
});

describe("buildPushRequest", () => {
	const vapid = { ...generateVapidKeys(), subject: "mailto:ops@example.com" };
	const ua = createECDH("prime256v1");
	ua.generateKeys();
	const subscription = {
		endpoint: "https://updates.push.services.mozilla.com:443/wpush/v2/abc?x=1",
		keys: {
			p256dh: ua.getPublicKey().toString("base64url"),
			auth: "tBHItJI5sVmRaTQX6w4qEA",
		},
	};

	function claimsOf(
		authorization: string | undefined,
	): Record<string, unknown> {
		const token = authorization?.match(/^vapid t=([^,]+), k=(.+)$/)?.[1] ?? "";
		return JSON.parse(
			Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
		);
	}

	it("carries the RFC 8030 / 8291 / 8292 headers and a body the browser reads", () => {
		const request = buildPushRequest(
			subscription,
			'{"title":"ping"}',
			{ vapid, ttl: 60 },
			{ now: 1_000 },
		);
		expect(request.method).toBe("POST");
		expect(request.headers).toEqual({
			ttl: "60",
			"content-type": "application/octet-stream",
			"content-encoding": "aes128gcm",
			authorization: expect.stringMatching(/^vapid t=ey[^,]+, k=/),
			urgency: "normal",
		});
		expect(
			request.headers.authorization?.endsWith(`, k=${vapid.publicKey}`),
		).toBe(true);
		const plaintext = decrypt(
			request.body,
			ua.getPrivateKey(),
			Buffer.from(subscription.keys.auth, "base64url"),
		);
		expect(plaintext.toString()).toBe('{"title":"ping"}');
	});

	it("binds the token to the endpoint's origin for twelve hours", () => {
		const request = buildPushRequest(
			subscription,
			"x",
			{ vapid, ttl: 0 },
			{ now: 1_000 },
		);
		expect(claimsOf(request.headers.authorization)).toEqual({
			aud: "https://updates.push.services.mozilla.com",
			exp: 1_000 + 12 * 60 * 60,
			sub: "mailto:ops@example.com",
		});
	});

	it("sends urgency and topic only as asked", () => {
		const request = buildPushRequest(subscription, "x", {
			vapid,
			ttl: 30,
			urgency: "high",
			topic: "alert",
		});
		expect(request.headers.urgency).toBe("high");
		expect(request.headers.topic).toBe("alert");
		expect(
			buildPushRequest(subscription, "x", { vapid, ttl: 30 }).headers,
		).not.toHaveProperty("topic");
	});
});
