/**
 * Which hosts a push may be sent to.
 *
 * A push endpoint is a capability URL the push service issues (RFC 8030
 * §8.4), and the browser hands it to the application — so whoever holds an
 * account can post any URL as "their" endpoint, and the server would send a
 * POST there on every notification. The outbound client already refuses
 * private addresses at connect time; this narrows the target further, to the
 * push services browsers actually use, so a public host the attacker runs is
 * refused too. Checked when a subscription arrives and again before each
 * send, which covers rows stored before the list existed or after it changed.
 */

import { isIP } from "node:net";

/**
 * The push services of the browsers in use: Chrome, Edge (Chromium), Opera,
 * Samsung Internet → FCM; Firefox → Mozilla autopush; legacy Edge → WNS;
 * Safari → Apple. Each entry matches the host and its subdomains.
 */
export const DEFAULT_PUSH_SERVICES: readonly string[] = Object.freeze([
	"fcm.googleapis.com",
	"push.services.mozilla.com",
	"notify.windows.com",
	"push.apple.com",
]);

export interface PushTargetPolicy {
	/** Hosts a push may go to; each also matches its subdomains. */
	pushServices?: readonly string[];
	/**
	 * Exact `host` or `host:port` exemptions, for a push service running next
	 * to the app in development. Also exempt from the public-address rule.
	 */
	allowHosts?: readonly string[];
}

/** The policy with its defaults applied and its entries normalised. */
export interface ResolvedPushTargetPolicy {
	readonly pushServices: readonly string[];
	readonly allowHosts: readonly string[];
}

export function resolvePushTargetPolicy(
	policy: PushTargetPolicy = {},
): ResolvedPushTargetPolicy {
	const pushServices = (policy.pushServices ?? DEFAULT_PUSH_SERVICES).map(
		(entry) => normaliseEntry(entry, "pushServices"),
	);
	const allowHosts = (policy.allowHosts ?? []).map((entry) =>
		normaliseEntry(entry, "allowHosts"),
	);
	return { pushServices, allowHosts };
}

function normaliseEntry(entry: string, option: string): string {
	const value = typeof entry === "string" ? entry.trim().toLowerCase() : "";
	// A leading dot or wildcard would read as "any subdomain", which every
	// entry already means; an empty one would match everything.
	if (value === "" || value.startsWith(".") || value.includes("*")) {
		throw new TypeError(
			`[nova] invalid delivery option \`${option}\`: "${String(entry)}" is not a host name`,
		);
	}
	return value;
}

/** Why `endpoint` may not be pushed to, or null when it may. */
export function pushTargetProblem(
	endpoint: string,
	policy: ResolvedPushTargetPolicy,
): string | null {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return "the endpoint is not a URL";
	}
	if (url.protocol !== "https:") return "the endpoint is not an https URL";
	if (url.username !== "" || url.password !== "") {
		return "the endpoint carries credentials";
	}
	const hostname = url.hostname;
	const port = url.port === "" ? "443" : url.port;
	if (
		policy.allowHosts.includes(hostname) ||
		policy.allowHosts.includes(`${hostname}:${port}`)
	) {
		return null;
	}
	// Push services are reached by name; an address literal is never one.
	if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) {
		return "the endpoint host is an IP address, not a push service";
	}
	const matched = policy.pushServices.some(
		(service) => hostname === service || hostname.endsWith(`.${service}`),
	);
	if (!matched) return `${hostname} is not a known push service`;
	return null;
}
