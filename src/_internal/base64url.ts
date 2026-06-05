/**
 * Environment-agnostic base64url helpers (RFC 4648 §5, no padding).
 *
 * Lives in `_internal/` because it is shared between the Node-side `vapid.ts`
 * and the browser-side `client/subscribe.ts`. The implementation deliberately
 * avoids any `node:` import and any browser-specific global so the same module
 * compiles for both bundles.
 */

const STANDARD_TO_URL: Record<string, string> = { "+": "-", "/": "_" };
const URL_TO_STANDARD: Record<string, string> = { "-": "+", _: "/" };

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i] as number);
	}
	if (typeof btoa === "function") {
		return btoa(binary);
	}
	// Node fallback — `btoa` is available in Node ≥16, this branch is for safety.
	return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(b64: string): Uint8Array {
	if (typeof atob === "function") {
		const binary = atob(b64);
		const out = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			out[i] = binary.charCodeAt(i);
		}
		return out;
	}
	return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Encode raw bytes to base64url (no padding). */
export function encodeBase64Url(bytes: Uint8Array): string {
	const standard = bytesToBase64(bytes);
	let out = "";
	for (let i = 0; i < standard.length; i++) {
		const ch = standard[i] as string;
		if (ch === "=") continue;
		out += STANDARD_TO_URL[ch] ?? ch;
	}
	return out;
}

/** Decode base64url (with or without padding) to raw bytes. */
export function decodeBase64Url(input: string): Uint8Array {
	let standard = "";
	for (let i = 0; i < input.length; i++) {
		const ch = input[i] as string;
		if (ch === "=") continue;
		standard += URL_TO_STANDARD[ch] ?? ch;
	}
	const padLen = (4 - (standard.length % 4)) % 4;
	standard += "=".repeat(padLen);
	return base64ToBytes(standard);
}
