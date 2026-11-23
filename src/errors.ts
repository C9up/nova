/**
 * The errors of nova, one class per code. An application tests `error.code`
 * or `error instanceof errors.E_NOVA_…`; the HTTP exception handler reads
 * `error.status`.
 */

import { createError, Exception } from "@c9up/flare";

/** `@c9up/nova/services/main` was used before `NovaProvider.boot()` ran. */
export const E_NOVA_NOT_BOOTED = createError(
	"[nova] Nova singleton accessed before NovaProvider.boot() ran. Check that `@c9up/nova/provider` is listed in your reamrc.ts providers.",
	"E_NOVA_NOT_BOOTED",
);

/** A delivery or store option is out of range. */
export const E_NOVA_INVALID_OPTION = createError<[string]>(
	"[nova] invalid %s",
	"E_NOVA_INVALID_OPTION",
);

/** A value that should be a user id (a non-empty string or an integer) is not one. */
export const E_NOVA_INVALID_USER_ID = createError<[string]>(
	"%s",
	"E_NOVA_INVALID_USER_ID",
);

/** The subscribe handler ran without an authenticated user. */
export const E_NOVA_MISSING_USER = createError(
	"Subscription handler reached without an authenticated user. Did you disable the guard?",
	"E_NOVA_MISSING_USER",
);

/** `FakeNova.assertPushed()` or `assertNotPushed()` does not hold. */
export const E_NOVA_ASSERTION_FAILED = createError<[string, string]>(
	"FakeNova.%s() failed — %s",
	"E_NOVA_ASSERTION_FAILED",
);

/** A `FakeNova` assertion was given an empty `containing`. */
export const E_NOVA_INVALID_PREDICATE = createError(
	"FakeNova: `containing` predicate cannot be an empty string — it would match every captured push. Pass a non-empty needle.",
	"E_NOVA_INVALID_PREDICATE",
);

/** An invariant of nova broke: the VAPID key pair Node generated has an unexpected shape. */
export const E_NOVA_INTERNAL = createError<[string]>(
	"[nova] the generated VAPID key pair has an unexpected shape: %s",
	"E_NOVA_INTERNAL",
);

/** The VAPID configuration is missing or malformed. */
export const E_NOVA_VAPID_NOT_CONFIGURED = createError<[string]>(
	"%s",
	"E_NOVA_VAPID_NOT_CONFIGURED",
);

/** A Redis key prefix holds a space. */
export const E_NOVA_INVALID_PREFIX = createError<[string]>(
	'Invalid key prefix "%s" — a Redis key cannot contain a space.',
	"E_NOVA_INVALID_PREFIX",
);

/** `@c9up/quasar` is not installed, so a connection name cannot be resolved. */
export const E_NOVA_QUASAR_MISSING = createError<[string]>(
	"%s",
	"E_NOVA_QUASAR_MISSING",
);

/** The named Redis connection lacks a command the subscription store issues. */
export const E_NOVA_REDIS_INCOMPLETE = createError<[string]>(
	"%s",
	"E_NOVA_REDIS_INCOMPLETE",
);

/** The configured store name is not among the declared `stores`. */
export class E_NOVA_UNKNOWN_STORE extends Exception {
	static override code = "E_NOVA_UNKNOWN_STORE";

	constructor(message: string, help: string) {
		super(message);
		this.help = help;
	}
}

/** A subscription handed to a store holds values a browser never sends. */
export class E_NOVA_INVALID_SUBSCRIPTION extends Exception {
	static override status = 400;
	static override code = "E_NOVA_INVALID_SUBSCRIPTION";
	static override help =
		"Subscriptions arriving through the subscribe endpoint are already checked; a hand-built one has to hold the same values a browser sends.";

	constructor(problem: string) {
		super(`This subscription cannot be stored: ${problem}.`);
	}
}

/** Another user holds the endpoint, or a concurrent write kept changing it. */
export class E_NOVA_SUBSCRIPTION_CONFLICT extends Exception {
	static override status = 409;
	static override code = "E_NOVA_SUBSCRIPTION_CONFLICT";

	/** `host` names the endpoint held by another user; without it, the write raced. */
	constructor(host?: string) {
		super(
			host === undefined
				? "The subscription kept changing while it was being stored."
				: `The endpoint ${host}/… is subscribed by another user with other keys.`,
		);
		this.help =
			host === undefined
				? "Another request was writing the same endpoint at the same time. Retry the subscribe."
				: "A browser moving between accounts posts the same keys; different ones mean the poster does not hold this subscription.";
	}
}

/** A SQL table name that cannot be used as an identifier. */
export class E_NOVA_INVALID_TABLE extends Exception {
	static override code = "E_NOVA_INVALID_TABLE";
	static override help =
		"Letters, digits and underscores only, not starting with a digit.";

	constructor(public readonly table: string) {
		super(
			`Invalid table name "${table}" — it reaches the SQL as an identifier, where a parameter cannot go.`,
		);
	}
}

/** The subscription file does not parse, or does not hold a subscription store. */
export class E_NOVA_STORE_FILE_UNREADABLE extends Exception {
	static override code = "E_NOVA_STORE_FILE_UNREADABLE";

	/** `problem` says what the parsed JSON lacks; without it, the file is not JSON. */
	constructor(
		public readonly path: string,
		problem?: string,
		options?: ErrorOptions,
	) {
		super(
			problem === undefined
				? `${path} is not valid JSON, so the subscriptions it holds cannot be read.`
				: `${path} is JSON but not a usable subscription store: ${problem}.`,
			options,
		);
		this.help =
			problem === undefined
				? "Fix or move the file. Starting from empty would overwrite it on the next subscribe."
				: 'Expected { "version": 1, "subscriptions": { "<endpoint>": { "userId": "…", "expirationTime": null, "p256dh": "…", "auth": "…" } } }. Fix or move the file — reading it as empty would overwrite the subscriptions it still holds.';
	}
}

/** The Redis record of a subscription changed under every attempt to write it. */
export class E_NOVA_STORE_BUSY extends Exception {
	static override code = "E_NOVA_STORE_BUSY";
	static override help =
		"Something rewrites this endpoint's record continuously; retry later.";

	constructor(public readonly attempts: number) {
		super(
			`A subscription changed under every one of ${attempts} attempts to write it.`,
		);
	}
}

/** No outbound HTTP client to send a push with. */
export class E_NOVA_HTTP_CLIENT_MISSING extends Exception {
	static override code = "E_NOVA_HTTP_CLIENT_MISSING";
	static override help =
		"Install @c9up/ream (^0.2.29), or pass your own client as `http` in the Nova options.";

	constructor(detail: string, options?: ErrorOptions) {
		super(
			`Sending a push needs the outbound HTTP client from @c9up/ream, ${detail}.`,
			options,
		);
	}
}
