/**
 * VAPID key generation — RFC 8292 §3.
 *
 * Produces a P-256 ECDH key pair where:
 *  - `publicKey`  is base64url(0x04 || X || Y)        — 65 raw bytes encoded
 *  - `privateKey` is base64url(d)                     — 32 raw bytes encoded
 *
 * Implementation uses Node's stdlib `crypto.generateKeyPairSync('ec')` with
 * the JWK export, then assembles the uncompressed point. No `web-push`
 * dependency, no third-party ASN.1 parser.
 */

import { generateKeyPairSync } from "node:crypto";
import { decodeBase64Url, encodeBase64Url } from "./_internal/base64url.js";

export interface VapidKeyPair {
	/** Base64url-encoded uncompressed P-256 point (65 bytes: `0x04 || X || Y`). */
	publicKey: string;
	/** Base64url-encoded raw 32-byte ECDH scalar. */
	privateKey: string;
}

export function generateVapidKeys(): VapidKeyPair {
	const { publicKey, privateKey } = generateKeyPairSync("ec", {
		namedCurve: "P-256",
	});

	const pubJwk = publicKey.export({ format: "jwk" });
	const privJwk = privateKey.export({ format: "jwk" });

	if (pubJwk.kty !== "EC" || pubJwk.crv !== "P-256") {
		throw new Error(
			`unexpected public JWK kty/crv: ${pubJwk.kty}/${pubJwk.crv}`,
		);
	}
	if (privJwk.kty !== "EC" || privJwk.crv !== "P-256") {
		throw new Error(
			`unexpected private JWK kty/crv: ${privJwk.kty}/${privJwk.crv}`,
		);
	}
	if (typeof pubJwk.x !== "string" || typeof pubJwk.y !== "string") {
		throw new Error("public JWK is missing x/y coordinates");
	}
	if (typeof privJwk.d !== "string") {
		throw new Error("private JWK is missing d scalar");
	}

	const x = decodeBase64Url(pubJwk.x);
	const y = decodeBase64Url(pubJwk.y);
	const d = decodeBase64Url(privJwk.d);
	if (x.length !== 32 || y.length !== 32 || d.length !== 32) {
		throw new Error(
			`invalid scalar lengths: x=${x.length} y=${y.length} d=${d.length}`,
		);
	}

	const uncompressed = new Uint8Array(65);
	uncompressed[0] = 0x04;
	uncompressed.set(x, 1);
	uncompressed.set(y, 33);

	return {
		publicKey: encodeBase64Url(uncompressed),
		privateKey: privJwk.d,
	};
}
