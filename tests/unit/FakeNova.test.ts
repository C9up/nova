/**
 * Unit suite for FakeNova — the in-memory test double for the Nova class.
 *
 * Verifies: capture shape, defensive snapshot in getPushed(), predicate
 * forms (object + function), `containing` substring matcher (incl.
 * empty-needle guard), assertion error-message richness, reset
 * behaviour. No `web-push`, no network, no SubscriptionStore touched.
 */

import { describe, expect, it, vi } from "vitest";
import type {
	PushOptions,
	PushPayload,
	PushSubscription,
} from "../../src/index.js";
import {
	type CapturedPush,
	FakeNova,
	type FakeNovaPredicate,
} from "../../src/testing/FakeNova.js";

const SUB_A: PushSubscription = {
	endpoint: "https://fcm.googleapis.com/wp/AAA111",
	expirationTime: null,
	keys: { p256dh: "p256dh-A".padEnd(87, "x"), auth: "auth-A".padEnd(22, "y") },
};

const SUB_B: PushSubscription = {
	endpoint: "https://updates.push.services.mozilla.com/wpush/v2/BBB222",
	expirationTime: null,
	keys: { p256dh: "p256dh-B".padEnd(87, "x"), auth: "auth-B".padEnd(22, "y") },
};

function welcomePayload(overrides?: Partial<PushPayload>): PushPayload {
	return {
		title: "Welcome",
		body: "Glad to have you onboard",
		data: { token: "abc-123" },
		...overrides,
	};
}

describe("FakeNova — construction + push() capture", () => {
	it("starts empty (getPushed() returns [])", () => {
		const fake = new FakeNova();
		expect(fake.getPushed()).toEqual([]);
	});

	it("push() captures + returns synthetic { ok: true, status: 201, endpoint }", async () => {
		const fake = new FakeNova();
		const result = await fake.push(SUB_A, welcomePayload());
		expect(result).toEqual({
			ok: true,
			status: 201,
			endpoint: SUB_A.endpoint,
		});
		const captured = fake.getPushed();
		expect(captured).toHaveLength(1);
		expect(captured[0].kind).toBe("single");
		if (captured[0].kind === "single") {
			expect(captured[0].subscription.endpoint).toBe(SUB_A.endpoint);
			expect(captured[0].payload.title).toBe("Welcome");
		}
	});

	it("push() captures with the supplied options", async () => {
		const fake = new FakeNova();
		const opts: PushOptions = { ttl: 120, urgency: "high", topic: "welcome" };
		await fake.push(SUB_A, welcomePayload(), opts);
		const captured = fake.getPushed();
		expect(captured[0].options).toEqual(opts);
	});
});

describe("FakeNova — pushToUser() capture", () => {
	it("pushToUser() captures + returns []", async () => {
		const fake = new FakeNova();
		const result = await fake.pushToUser("user-A", welcomePayload());
		expect(result).toEqual([]);
		const captured = fake.getPushed();
		expect(captured).toHaveLength(1);
		expect(captured[0].kind).toBe("fan-out");
		if (captured[0].kind === "fan-out") {
			expect(captured[0].userId).toBe("user-A");
		}
	});

	it("pushToUser() captures both call kinds in order", async () => {
		const fake = new FakeNova();
		await fake.push(SUB_A, welcomePayload());
		await fake.pushToUser("user-B", welcomePayload({ title: "Reminder" }));
		const captured = fake.getPushed();
		expect(captured.map((c) => c.kind)).toEqual(["single", "fan-out"]);
	});
});

describe("FakeNova — defensive snapshot in getPushed()", () => {
	it("returns clones — mutating the returned array doesn't affect later snapshots", async () => {
		const fake = new FakeNova();
		await fake.push(SUB_A, welcomePayload());
		const first = fake.getPushed();
		first.push({
			kind: "fan-out",
			userId: "intruder",
			payload: { title: "x" },
			options: {},
			timestamp: 0,
		} as CapturedPush);
		expect(fake.getPushed()).toHaveLength(1);
	});

	it("payload mutations on the returned object don't bleed back into the internal store", async () => {
		const fake = new FakeNova();
		await fake.push(SUB_A, welcomePayload());
		const first = fake.getPushed();
		// Tamper with the returned snapshot
		(first[0] as { payload: PushPayload }).payload.title = "Tampered";
		const second = fake.getPushed();
		expect(second[0].payload.title).toBe("Welcome");
	});

	it("subscription mutations on the returned object don't bleed back", async () => {
		const fake = new FakeNova();
		await fake.push(SUB_A, welcomePayload());
		const first = fake.getPushed();
		if (first[0].kind === "single") {
			first[0].subscription.keys.p256dh = "tampered";
		}
		const second = fake.getPushed();
		if (second[0].kind === "single") {
			expect(second[0].subscription.keys.p256dh).not.toBe("tampered");
		}
	});
});

describe("FakeNova — reset()", () => {
	it("reset() clears the captured array", async () => {
		const fake = new FakeNova();
		await fake.push(SUB_A, welcomePayload());
		fake.reset();
		expect(fake.getPushed()).toEqual([]);
	});
});

describe("FakeNova — assertPushed (object predicate)", () => {
	it("matches a pushToUser call by userId", async () => {
		const fake = new FakeNova();
		await fake.pushToUser("user-A", welcomePayload());
		expect(() => fake.assertPushed({ userId: "user-A" })).not.toThrow();
	});

	it("matches a single push call by endpoint", async () => {
		const fake = new FakeNova();
		await fake.push(SUB_A, welcomePayload());
		expect(() => fake.assertPushed({ endpoint: SUB_A.endpoint })).not.toThrow();
	});

	it("userId predicate does NOT match single-push captures", async () => {
		const fake = new FakeNova();
		await fake.push(SUB_A, welcomePayload());
		expect(() => fake.assertPushed({ userId: "user-A" })).toThrow(
			/no captured push matches/,
		);
	});

	it("endpoint predicate does NOT match fan-out captures", async () => {
		const fake = new FakeNova();
		await fake.pushToUser("user-A", welcomePayload());
		expect(() => fake.assertPushed({ endpoint: SUB_A.endpoint })).toThrow(
			/no captured push matches/,
		);
	});

	it("matches title exactly", async () => {
		const fake = new FakeNova();
		await fake.pushToUser("user-A", welcomePayload({ title: "Welcome" }));
		expect(() => fake.assertPushed({ title: "Welcome" })).not.toThrow();
		expect(() => fake.assertPushed({ title: "welcome" })).toThrow(
			/FakeNova\.assertPushed\(\) failed/,
		);
	});

	it("matches urgency + topic from options", async () => {
		const fake = new FakeNova();
		await fake.push(SUB_A, welcomePayload(), { urgency: "high", topic: "x" });
		expect(() =>
			fake.assertPushed({ urgency: "high", topic: "x" }),
		).not.toThrow();
		expect(() => fake.assertPushed({ urgency: "low" })).toThrow(
			/FakeNova\.assertPushed\(\) failed/,
		);
	});

	it("matches via JSON.stringify substring (containing)", async () => {
		const fake = new FakeNova();
		await fake.pushToUser(
			"user-A",
			welcomePayload({ data: { token: "secret-magic-payload" } }),
		);
		expect(() =>
			fake.assertPushed({ containing: "secret-magic-payload" }),
		).not.toThrow();
		expect(() => fake.assertPushed({ containing: "absent-needle" })).toThrow(
			/FakeNova\.assertPushed\(\) failed/,
		);
	});

	it("rejects empty-string `containing` (would match everything)", async () => {
		const fake = new FakeNova();
		await fake.pushToUser("user-A", welcomePayload());
		expect(() =>
			fake.assertPushed({ containing: "" } as FakeNovaPredicate),
		).toThrow(/`containing` predicate cannot be an empty string/);
	});

	it("all predicate fields are AND-combined", async () => {
		const fake = new FakeNova();
		await fake.pushToUser("user-A", welcomePayload({ title: "Welcome" }));
		// userId matches but title doesn't
		expect(() =>
			fake.assertPushed({ userId: "user-A", title: "Wrong" }),
		).toThrow(/FakeNova\.assertPushed\(\) failed/);
		// both match
		expect(() =>
			fake.assertPushed({ userId: "user-A", title: "Welcome" }),
		).not.toThrow();
	});
});

describe("FakeNova — assertPushed (function predicate)", () => {
	it("invokes the function once per capture", async () => {
		const fake = new FakeNova();
		await fake.push(SUB_A, welcomePayload());
		await fake.pushToUser("user-A", welcomePayload());
		const calls: CapturedPush["kind"][] = [];
		fake.assertPushed((c) => {
			calls.push(c.kind);
			return c.kind === "fan-out";
		});
		expect(calls).toEqual(["single", "fan-out"]);
	});

	it("function predicate failure includes <function predicate> placeholder", async () => {
		const fake = new FakeNova();
		await fake.push(SUB_A, welcomePayload());
		expect(() => fake.assertPushed(() => false)).toThrow(
			/<function predicate>/,
		);
	});
});

describe("FakeNova — assertNotPushed", () => {
	it("passes when no capture matches", async () => {
		const fake = new FakeNova();
		await fake.pushToUser("user-A", welcomePayload());
		expect(() => fake.assertNotPushed({ userId: "user-B" })).not.toThrow();
	});

	it("throws when at least one capture matches", async () => {
		const fake = new FakeNova();
		await fake.pushToUser("user-A", welcomePayload());
		expect(() => fake.assertNotPushed({ userId: "user-A" })).toThrow(
			/at least one captured push matches/,
		);
	});
});

describe("FakeNova — assertion error message richness", () => {
	it("assertPushed failure dumps the captured state", async () => {
		const fake = new FakeNova();
		await fake.push(SUB_A, welcomePayload({ title: "Welcome" }));
		await fake.pushToUser("user-Z", welcomePayload({ title: "Reminder" }));
		expect(() => fake.assertPushed({ title: "MissingTitle" })).toThrow(
			/Captured \(2\)[\s\S]*Welcome[\s\S]*userId="user-Z"[\s\S]*Reminder/,
		);
	});

	it("describes endpoint via host (not full URL) to keep the message short", async () => {
		const fake = new FakeNova();
		await fake.push(SUB_A, welcomePayload({ title: "X" }));
		expect(() => fake.assertPushed({ title: "Y" })).toThrow(
			/endpoint=fcm\.googleapis\.com/,
		);
	});

	it("'Captured: (none)' when no calls were recorded", () => {
		const fake = new FakeNova();
		expect(() => fake.assertPushed({ userId: "user-A" })).toThrow(
			/Captured: \(none\)/,
		);
	});
});

describe("FakeNova — defensive serialisation of `containing` matcher", () => {
	it("treats a non-serialisable payload (BigInt) as no-match instead of crashing", async () => {
		const fake = new FakeNova();
		await fake.pushToUser(
			"user-A",
			welcomePayload({
				data: { tally: 9_007_199_254_740_993n as unknown as number },
			}),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(() => fake.assertPushed({ containing: "anything" })).toThrow(
			/no captured push matches/,
		);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("treats a circular-reference payload as no-match instead of crashing", async () => {
		const fake = new FakeNova();
		const circular: Record<string, unknown> = { ref: null };
		circular.ref = circular;
		await fake.pushToUser("user-A", welcomePayload({ data: circular }));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(() => fake.assertPushed({ containing: "anything" })).toThrow(
			/no captured push matches/,
		);
		warn.mockRestore();
	});
});

describe("FakeNova — deep clone of payload.data", () => {
	it("nested array mutations on the snapshot don't affect later snapshots", async () => {
		const fake = new FakeNova();
		await fake.pushToUser(
			"user-A",
			welcomePayload({ data: { tags: ["a", "b"] } }),
		);
		const first = fake.getPushed();
		(first[0].payload.data as { tags: string[] }).tags.push("tampered");
		const second = fake.getPushed();
		expect((second[0].payload.data as { tags: string[] }).tags).toEqual([
			"a",
			"b",
		]);
	});

	it("nested Date objects in payload.data are cloned (not shared)", async () => {
		const fake = new FakeNova();
		const original = new Date(1_900_000_000_000);
		await fake.pushToUser(
			"user-A",
			welcomePayload({ data: { when: original as unknown as string } }),
		);
		const snapshot = fake.getPushed();
		const snappedDate = (snapshot[0].payload.data as { when: Date }).when;
		expect(snappedDate.getTime()).toBe(original.getTime());
		// structuredClone produces a NEW Date instance
		expect(snappedDate).not.toBe(original);
	});
});

describe("FakeNova — defensive cloneSubscription on missing keys", () => {
	it("does not throw when keys is undefined (legal under permissive types)", async () => {
		const fake = new FakeNova();
		const subWithoutKeys = {
			endpoint: "https://x/y",
			expirationTime: null,
			keys: undefined as unknown as { p256dh: string; auth: string },
		};
		await fake.push(subWithoutKeys, welcomePayload());
		const captured = fake.getPushed();
		expect(captured[0].kind).toBe("single");
		if (captured[0].kind === "single") {
			expect(captured[0].subscription.keys).toEqual({ p256dh: "", auth: "" });
		}
	});
});

describe("FakeNova — supports both subscriptions in order", () => {
	it("captures both push calls preserving order", async () => {
		const fake = new FakeNova();
		await fake.push(SUB_A, welcomePayload({ title: "First" }));
		await fake.push(SUB_B, welcomePayload({ title: "Second" }));
		const captured = fake.getPushed();
		expect(captured.map((c) => c.payload.title)).toEqual(["First", "Second"]);
	});
});
