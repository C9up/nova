/**
 * VAPID config validator — invoked lazily on first `nova.push()` so apps
 * that never push (subscription-side only, or Helix-faked) don't fail to
 * boot just because the env vars aren't wired.
 */

import type { NovaVapidConfig } from "../config.js";
import { NovaError } from "../errors.js";

const BASE64URL_CHARS = /^[A-Za-z0-9_-]+$/;
// P-256 base64url no-padding lengths are exact: 32 bytes → 43 chars, 65 bytes → 87 chars.
const PUBLIC_KEY_LENGTH = 87;
const PRIVATE_KEY_LENGTH = 43;

export function validateVapidConfig(
	config: NovaVapidConfig | undefined,
): NovaVapidConfig {
	if (!config) throw missing("VAPID config block");

	if (typeof config.publicKey !== "string" || config.publicKey.length === 0) {
		throw missing("publicKey");
	}
	checkBase64UrlShape(
		"publicKey",
		config.publicKey,
		PUBLIC_KEY_LENGTH,
		"87-char base64url (uncompressed P-256 point)",
	);

	if (typeof config.privateKey !== "string" || config.privateKey.length === 0) {
		throw missing("privateKey");
	}
	checkBase64UrlShape(
		"privateKey",
		config.privateKey,
		PRIVATE_KEY_LENGTH,
		"43-char base64url (raw 32-byte scalar)",
	);

	if (typeof config.subject !== "string" || config.subject.length === 0) {
		throw missing("subject");
	}
	if (!/^(mailto:.+@.+|https:\/\/.+)/.test(config.subject)) {
		throw invalidShape(
			"subject",
			"must be `mailto:<address>` or `https://<host>` (non-empty content after the prefix)",
		);
	}

	return {
		publicKey: config.publicKey,
		privateKey: config.privateKey,
		subject: config.subject,
	};
}

function checkBase64UrlShape(
	field: string,
	value: string,
	expectedLength: number,
	expectedDescription: string,
): void {
	if (value.includes("=")) {
		throw invalidShape(
			field,
			`${expectedDescription} — value contains \`=\` padding; strip it (base64url uses no padding per RFC 4648 §5)`,
		);
	}
	if (value.length !== expectedLength) {
		throw invalidShape(
			field,
			`${expectedDescription} — got ${value.length} chars`,
		);
	}
	if (!BASE64URL_CHARS.test(value)) {
		throw invalidShape(
			field,
			`${expectedDescription} — value contains characters outside the base64url alphabet (\`A-Z\`, \`a-z\`, \`0-9\`, \`-\`, \`_\`)`,
		);
	}
}

function missing(field: string): NovaError {
	return new NovaError(
		"NOVA_VAPID_NOT_CONFIGURED",
		`Nova VAPID ${field} is missing. Configure NOVA_VAPID_PUBLIC_KEY, NOVA_VAPID_PRIVATE_KEY, NOVA_VAPID_SUBJECT in your env (mint a pair with \`generateVapidKeys()\` from '@c9up/nova') and pass them through \`config/nova.ts\`.`,
	);
}

function invalidShape(field: string, expected: string): NovaError {
	return new NovaError(
		"NOVA_VAPID_NOT_CONFIGURED",
		`Nova VAPID ${field} is malformed (expected ${expected}). Set NOVA_VAPID_PUBLIC_KEY, NOVA_VAPID_PRIVATE_KEY, NOVA_VAPID_SUBJECT correctly in your env (mint a pair with \`generateVapidKeys()\` from '@c9up/nova').`,
	);
}
