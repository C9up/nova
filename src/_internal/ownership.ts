/**
 * Who may take over an endpoint already stored for someone else.
 *
 * One browser used by two accounts (logout, login) posts the same endpoint
 * for the second user, and it has to move: the next notification for the
 * first account must not land on the second one's screen. But the endpoint
 * alone is not proof of holding the subscription — it leaks into logs and
 * results. The `auth` secret is: the browser generates it with the
 * subscription and only ever gives it to the application (RFC 8291 §3.2). So
 * the endpoint moves when the keys match the stored ones, and is refused
 * otherwise — a different account cannot cut the owner off, nor have pushes
 * encrypted for keys the owner's browser does not hold.
 */

import { timingSafeEqual } from "node:crypto";
import { NovaError } from "../errors.js";

interface Keys {
	p256dh: string;
	auth: string;
}

function same(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

/** Throw unless `userId` may store `endpoint` with `keys`, given its current owner. */
export function assertMayTakeOver(
	endpoint: string,
	userId: string,
	current: { userId: string; keys: Keys } | undefined,
	keys: Keys,
): void {
	if (current === undefined || current.userId === userId) return;
	// Both compared, without short-circuit, so the time does not say which.
	const p256dhMatches = same(current.keys.p256dh, keys.p256dh);
	const authMatches = same(current.keys.auth, keys.auth);
	if (p256dhMatches && authMatches) return;
	throw new NovaError(
		"E_NOVA_SUBSCRIPTION_CONFLICT",
		`The endpoint ${hostOf(endpoint)}/… is subscribed by another user with other keys.`,
		{
			hint: "A browser moving between accounts posts the same keys; different ones mean the poster does not hold this subscription.",
		},
	);
}

function hostOf(endpoint: string): string {
	try {
		return new URL(endpoint).origin;
	} catch {
		return "<invalid-endpoint>";
	}
}
