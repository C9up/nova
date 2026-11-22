/**
 * The Web Push request itself, built on `node:crypto` alone: the VAPID token
 * (RFC 8292) and the `aes128gcm` payload encryption (RFC 8291 over RFC 8188).
 *
 * It replaces `web-push`'s `generateRequestDetails`, the one thing Nova used
 * from that package, together with the chain it brought (`jws`, `asn1.js`,
 * `bn.js`, `http_ece`, `https-proxy-agent`, `minimist`). The request is the
 * same: the same headers, the same 12-hour token, the same single record.
 *
 * NAMED DEVIATIONS from `web-push` 3.6.7:
 * - The token's audience is the endpoint's origin as RFC 8292 §2 defines it
 *   (`new URL(endpoint).origin`); web-push wrote `protocol//host` from the
 *   legacy URL parser, which keeps an explicit default port (`:443`).
 * - No GCM path. web-push signed nothing for `android.googleapis.com/gcm/send`
 *   (GCM, shut down in 2019) and sent a server key instead; every endpoint
 *   gets a VAPID token here.
 * - No legacy `aesgcm` encoding, no proxy or agent options: Nova never asked
 *   for them, and its own client carries the request.
 */

import {
	createCipheriv,
	createECDH,
	createPrivateKey,
	hkdfSync,
	randomBytes,
	sign,
} from "node:crypto";

/** RFC 8188 §2: the record size announced in the header. */
const RECORD_SIZE = 4096;
/** web-push's token lifetime; RFC 8292 §2 allows at most 24 hours. */
const TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;
/** RFC 8188 §2.1: a 16-octet salt. */
const SALT_BYTES = 16;
/** RFC 8188 §2: the delimiter that closes the last (here, only) record. */
const LAST_RECORD_DELIMITER = 0x02;

export interface VapidCredentials {
	/** base64url uncompressed P-256 point, sent as `k`. */
	publicKey: string;
	/** base64url 32-byte scalar that signs the token. */
	privateKey: string;
	/** `mailto:` or `https:` contact, the token's `sub`. */
	subject: string;
}

export interface PushRequestOptions {
	vapid: VapidCredentials;
	ttl: number;
	urgency?: "very-low" | "low" | "normal" | "high";
	topic?: string;
}

export interface PushRequest {
	method: "POST";
	headers: Record<string, string>;
	body: Buffer;
}

/** Fixed inputs a test substitutes for the random ones. */
export interface PushSeed {
	/** Seconds since the epoch the token counts its lifetime from. */
	now?: number;
	salt?: Uint8Array;
	/** The application server's ephemeral ECDH private key (32 bytes). */
	senderPrivateKey?: Uint8Array;
}

/**
 * Build the push request for `subscription`: the encrypted `plaintext` and
 * the headers RFC 8030 / 8291 / 8292 ask for. Throws on keys the encryption
 * cannot use, which the subscription checks refuse before this is reached.
 */
export function buildPushRequest(
	subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
	plaintext: string,
	options: PushRequestOptions,
	seed: PushSeed = {},
): PushRequest {
	const body = encryptAes128gcm(
		Buffer.from(plaintext),
		Buffer.from(subscription.keys.p256dh, "base64url"),
		Buffer.from(subscription.keys.auth, "base64url"),
		seed,
	);
	const now = seed.now ?? Math.floor(Date.now() / 1000);
	const token = vapidToken(
		new URL(subscription.endpoint).origin,
		options.vapid.subject,
		options.vapid.privateKey,
		now + TOKEN_LIFETIME_SECONDS,
	);
	const headers: Record<string, string> = {
		ttl: String(options.ttl),
		"content-type": "application/octet-stream",
		"content-encoding": "aes128gcm",
		authorization: `vapid t=${token}, k=${options.vapid.publicKey}`,
		urgency: options.urgency ?? "normal",
	};
	if (options.topic !== undefined) headers.topic = options.topic;
	return { method: "POST", headers, body };
}

/**
 * RFC 8291 §3.4: one `aes128gcm` record for the user agent's key pair and
 * auth secret, under a fresh ephemeral key and salt unless `seed` fixes them.
 * The result is the 86-octet header followed by the record.
 */
export function encryptAes128gcm(
	plaintext: Uint8Array,
	userAgentPublicKey: Uint8Array,
	authSecret: Uint8Array,
	seed: PushSeed = {},
): Buffer {
	const sender = createECDH("prime256v1");
	if (seed.senderPrivateKey) sender.setPrivateKey(seed.senderPrivateKey);
	else sender.generateKeys();
	const senderPublicKey = sender.getPublicKey();
	const salt = seed.salt ?? randomBytes(SALT_BYTES);

	const ecdhSecret = sender.computeSecret(userAgentPublicKey);
	const keyInfo = Buffer.concat([
		Buffer.from("WebPush: info\0", "ascii"),
		userAgentPublicKey,
		senderPublicKey,
	]);
	const ikm = hkdf(ecdhSecret, authSecret, keyInfo, 32);
	const cek = hkdf(
		ikm,
		salt,
		Buffer.from("Content-Encoding: aes128gcm\0", "ascii"),
		16,
	);
	const nonce = hkdf(
		ikm,
		salt,
		Buffer.from("Content-Encoding: nonce\0", "ascii"),
		12,
	);

	const header = Buffer.alloc(SALT_BYTES + 4 + 1);
	Buffer.from(salt).copy(header, 0);
	header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
	header.writeUInt8(senderPublicKey.length, SALT_BYTES + 4);

	const cipher = createCipheriv("aes-128-gcm", cek, nonce);
	const record = Buffer.concat([
		cipher.update(plaintext),
		cipher.update(Buffer.from([LAST_RECORD_DELIMITER])),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	return Buffer.concat([header, senderPublicKey, record]);
}

/**
 * RFC 8292 §2: an ES256 JWT carrying `aud`, `exp` and `sub`, in that order
 * and with that header, as web-push wrote it.
 */
export function vapidToken(
	audience: string,
	subject: string,
	privateKey: string,
	expiration: number,
): string {
	const header = encodeSegment({ typ: "JWT", alg: "ES256" });
	const claims = encodeSegment({
		aud: audience,
		exp: expiration,
		sub: subject,
	});
	const signingInput = `${header}.${claims}`;
	const signature = sign("sha256", Buffer.from(signingInput), {
		key: signingKey(Buffer.from(privateKey, "base64url")),
		dsaEncoding: "ieee-p1363",
	});
	return `${signingInput}.${signature.toString("base64url")}`;
}

function encodeSegment(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * The VAPID scalar as a key: SEC 1 `ECPrivateKey` without the public point,
 * the DER web-push encoded too (version 1, the scalar, prime256v1).
 */
function signingKey(scalar: Buffer) {
	const der = Buffer.concat([
		Buffer.from([0x30, 0x31, 0x02, 0x01, 0x01, 0x04, 0x20]),
		scalar,
		Buffer.from([
			0xa0, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
		]),
	]);
	return createPrivateKey({ key: der, format: "der", type: "sec1" });
}

function hkdf(
	ikm: Uint8Array,
	salt: Uint8Array,
	info: Uint8Array,
	length: number,
): Buffer {
	return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}
