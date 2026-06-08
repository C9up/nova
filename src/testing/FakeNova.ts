/**
 * FakeNova — in-memory test double for the `Nova` class shipped in 48.2.
 *
 * Captures every `push` / `pushToUser` call into an internal array; never
 * touches `web-push`, never validates VAPID, never reads `SubscriptionStore`.
 * Apps that need real fan-out semantics (one PushResult per device, 410
 * cleanup) construct a real `Nova` against a `MemorySubscriptionDriver`
 * pre-loaded with fixtures — that path runs the actual delivery logic.
 *
 * Reach via `@c9up/nova/testing`; not re-exported from the main barrel
 * (mirrors Rover's `FakeMail` shape).
 *
 *   import { FakeNova } from "@c9up/nova/testing";
 *   import { nova, useContainer } from "@c9up/helix";
 *
 *   useContainer(container);
 *   nova.fake(FakeNova);
 *   // ... code under test calls container.resolve('nova').push(...)
 *   nova.assertPushed({ userId: "user-A", title: "Welcome" });
 */

import type {
	PushOptions,
	PushPayload,
	PushResult,
	PushSubscription,
} from "../index.js";

export type CapturedPush =
	| {
			kind: "single";
			subscription: PushSubscription;
			payload: PushPayload;
			options: PushOptions;
			timestamp: number;
	  }
	| {
			kind: "fan-out";
			userId: string;
			payload: PushPayload;
			options: PushOptions;
			timestamp: number;
	  };

export interface FakeNovaPredicate {
	/** Matches `pushToUser` calls only (kind === 'fan-out'). */
	userId?: string;
	/** Matches single-subscription `push` calls only (kind === 'single'). */
	endpoint?: string;
	/** Exact-match on `payload.title`. */
	title?: string;
	/** Exact-match on `payload.body`. */
	body?: string;
	/** Matches `options.urgency`. */
	urgency?: "very-low" | "low" | "normal" | "high";
	/** Matches `options.topic`. */
	topic?: string;
	/**
	 * Substring match against `JSON.stringify(payload)` — catches values
	 * inside `data` too. Empty string is rejected (would match every
	 * captured push).
	 */
	containing?: string;
}

export type FakeNovaPredicateArg =
	| FakeNovaPredicate
	| ((captured: CapturedPush) => boolean);

export class FakeNova {
	#captured: CapturedPush[] = [];

	async push(
		subscription: PushSubscription,
		payload: PushPayload,
		options: PushOptions = {},
	): Promise<PushResult> {
		this.#captured.push({
			kind: "single",
			subscription: cloneSubscription(subscription),
			payload: clonePayload(payload),
			options: cloneOptions(options),
			timestamp: Date.now(),
		});
		return { ok: true, status: 201, endpoint: subscription.endpoint };
	}

	async pushToUser(
		userId: string,
		payload: PushPayload,
		options: PushOptions = {},
	): Promise<PushResult[]> {
		this.#captured.push({
			kind: "fan-out",
			userId,
			payload: clonePayload(payload),
			options: cloneOptions(options),
			timestamp: Date.now(),
		});
		// The fake does NOT consult any SubscriptionStore — assertions reason
		// about the call itself, not about per-device fan-out. Apps that need
		// per-device PushResult behaviour use the real Nova class with a
		// pre-loaded MemorySubscriptionDriver.
		return [];
	}

	/**
	 * Defensive snapshot — every captured entry is rebuilt so test mutations
	 * cannot corrupt later assertions. One-level deep on `payload.data`
	 * (matches FakeMail's clone depth on `headers`); deeply-nested data
	 * shapes mutating callers must structuredClone themselves.
	 */
	getPushed(): CapturedPush[] {
		return this.#captured.map(cloneCaptured);
	}

	reset(): void {
		this.#captured = [];
	}

	assertPushed(predicate: FakeNovaPredicateArg): void {
		const match = makeMatcher(predicate);
		if (this.#captured.some(match)) return;
		throw new Error(
			`FakeNova.assertPushed() failed — no captured push matches ${describePredicate(predicate)}.\n${describeCaptured(this.#captured)}`,
		);
	}

	assertNotPushed(predicate: FakeNovaPredicateArg): void {
		const match = makeMatcher(predicate);
		const found = this.#captured.find(match);
		if (!found) return;
		throw new Error(
			`FakeNova.assertNotPushed() failed — at least one captured push matches ${describePredicate(predicate)}.\n${describeCaptured(this.#captured)}`,
		);
	}
}

function makeMatcher(
	predicate: FakeNovaPredicateArg,
): (c: CapturedPush) => boolean {
	if (typeof predicate === "function") return predicate;
	const p = predicate;
	if (p.containing !== undefined && p.containing === "") {
		throw new Error(
			"FakeNova: `containing` predicate cannot be an empty string — it would match every captured push. Pass a non-empty needle.",
		);
	}
	return (c) => {
		// userId only matches fan-out captures; endpoint only matches single.
		if (p.userId !== undefined) {
			if (c.kind !== "fan-out") return false;
			if (c.userId !== p.userId) return false;
		}
		if (p.endpoint !== undefined) {
			if (c.kind !== "single") return false;
			if (c.subscription.endpoint !== p.endpoint) return false;
		}
		if (p.title !== undefined && c.payload.title !== p.title) return false;
		if (p.body !== undefined && c.payload.body !== p.body) return false;
		if (p.urgency !== undefined && c.options.urgency !== p.urgency)
			return false;
		if (p.topic !== undefined && c.options.topic !== p.topic) return false;
		if (p.containing !== undefined) {
			const needle = p.containing;
			let serialised: string;
			try {
				serialised = JSON.stringify(c.payload);
			} catch (cause) {
				// Non-serialisable payload (BigInt, circular reference, etc).
				// Treat as no-match rather than crashing the entire assertion
				// — surface the decision via `console.warn` so the test author
				// can spot it without the suite collapsing.
				console.warn(
					`[FakeNova] assertPushed: payload is not JSON-serialisable; treating as no-match for containing=${JSON.stringify(needle)}`,
					cause,
				);
				return false;
			}
			if (!serialised.includes(needle)) return false;
		}
		return true;
	};
}

function describePredicate(predicate: FakeNovaPredicateArg): string {
	if (typeof predicate === "function") return "<function predicate>";
	return JSON.stringify(predicate);
}

function describeCaptured(captured: CapturedPush[]): string {
	if (captured.length === 0) return "Captured: (none)";
	const lines = captured.map((c, i) => {
		if (c.kind === "single") {
			return `  [${i}] kind=single endpoint=${hostOf(c.subscription.endpoint)} title="${c.payload.title}"`;
		}
		return `  [${i}] kind=fan-out userId="${c.userId}" title="${c.payload.title}"`;
	});
	return `Captured (${captured.length}):\n${lines.join("\n")}`;
}

function hostOf(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return endpoint.slice(0, 40);
	}
}

function cloneSubscription(s: PushSubscription): PushSubscription {
	// `keys` is required by the type but a permissive caller (test runtime
	// passing an under-typed object) could omit it; fall back to a frozen
	// empty-string pair so the snapshot is still a usable PushSubscription.
	const keys = s.keys
		? { p256dh: s.keys.p256dh, auth: s.keys.auth }
		: { p256dh: "", auth: "" };
	return {
		endpoint: s.endpoint,
		expirationTime: s.expirationTime,
		keys,
	};
}

function clonePayload(p: PushPayload): PushPayload {
	// Per cerebrum DNR (2026-04-26) "test fakes capture via structuredClone":
	// `data` is the user-controlled nested field — deep-clone via
	// structuredClone so nested arrays / Date / Map / Set / Buffer no longer
	// share references with the internal store. structuredClone throws on
	// non-cloneable values (functions, DOM nodes, Symbols); fall back to
	// shallow `{ ...p.data }` with a console.warn so the snapshot is at
	// least usable + the test author is alerted.
	let data: PushPayload["data"];
	if (p.data === undefined) {
		data = undefined;
	} else {
		try {
			data = structuredClone(p.data);
		} catch (cause) {
			console.warn(
				"[FakeNova] payload.data is not structured-cloneable (function/Symbol/DOM-node?); falling back to shallow spread — nested mutations will bleed",
				cause,
			);
			data = { ...p.data };
		}
	}
	return {
		title: p.title,
		body: p.body,
		icon: p.icon,
		url: p.url,
		data,
		tag: p.tag,
	};
}

function cloneOptions(o: PushOptions): PushOptions {
	return { ttl: o.ttl, urgency: o.urgency, topic: o.topic };
}

function cloneCaptured(c: CapturedPush): CapturedPush {
	if (c.kind === "single") {
		return {
			kind: "single",
			subscription: cloneSubscription(c.subscription),
			payload: clonePayload(c.payload),
			options: cloneOptions(c.options),
			timestamp: c.timestamp,
		};
	}
	return {
		kind: "fan-out",
		userId: c.userId,
		payload: clonePayload(c.payload),
		options: cloneOptions(c.options),
		timestamp: c.timestamp,
	};
}
