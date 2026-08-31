/**
 * File-backed subscription storage — one JSON file on disk.
 *
 * The option for an application that has neither a database nor Redis: a
 * single-node deployment, a small internal tool, a self-hosted instance. The
 * in-memory driver loses every subscription on restart; this one does not, and
 * it needs nothing installed.
 *
 *   // config/nova.ts
 *   import { defineConfig, FileSubscriptionStore } from '@c9up/nova'
 *
 *   export default defineConfig({
 *     store: new FileSubscriptionStore('storage/push_subscriptions.json'),
 *   })
 *
 * ONE PROCESS. The file is rewritten atomically and writes are serialised
 * within this instance, so a burst of subscribes cannot interleave — but two
 * processes writing the same file will overwrite each other, because nothing
 * here takes a lock the operating system enforces. Behind a cluster, `pm2 -i`,
 * or several containers, use {@link SqlSubscriptionStore} or
 * {@link RedisSubscriptionStore}.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { NovaError } from "./errors.js";
import type {
	PushSubscription,
	SubscriptionStore,
} from "./SubscriptionStore.js";

/** One stored subscription, keyed by the endpoint that identifies it. */
interface StoredSubscription {
	userId: string;
	expirationTime: number | null;
	p256dh: string;
	auth: string;
}

/** The file's contents. `version` is what makes a format change detectable. */
interface StoreFile {
	version: 1;
	subscriptions: Record<string, StoredSubscription>;
}

export class FileSubscriptionStore implements SubscriptionStore {
	readonly #path: string;
	/** Serialises writes: the file is read, changed and rewritten as one step. */
	#queue: Promise<unknown> = Promise.resolve();

	/** @param path Where the file lives, absolute or relative to the process. */
	constructor(path: string) {
		this.#path = resolve(path);
	}

	async save(userId: string, subscription: PushSubscription): Promise<void> {
		await this.#mutate((file) => {
			// Whoever held this endpoint before loses it: a push endpoint is
			// globally unique per push service, so a browser reused across a
			// logout/login pair would otherwise stay attached to both accounts, and
			// the next notification for the old one would land on the new user's
			// screen. Writing the record replaces the owner outright.
			file.subscriptions[subscription.endpoint] = {
				userId,
				expirationTime: subscription.expirationTime,
				p256dh: subscription.keys.p256dh,
				auth: subscription.keys.auth,
			};
		});
	}

	async listByUser(userId: string): Promise<PushSubscription[]> {
		const file = await this.#read();
		return Object.entries(file.subscriptions)
			.filter(([, stored]) => stored.userId === userId)
			.map(([endpoint, stored]) => ({
				endpoint,
				expirationTime: stored.expirationTime,
				keys: { p256dh: stored.p256dh, auth: stored.auth },
			}));
	}

	async delete(endpoint: string): Promise<void> {
		await this.#mutate((file) => {
			delete file.subscriptions[endpoint];
		});
	}

	/**
	 * Read, change, rewrite — one at a time.
	 *
	 * Every mutation goes through this queue, so two subscribes arriving
	 * together cannot both read the same file and write back over each other.
	 */
	async #mutate(change: (file: StoreFile) => void): Promise<void> {
		const run = this.#queue.then(async () => {
			const file = await this.#read();
			change(file);
			await this.#write(file);
		});
		// The queue must keep flowing even when one mutation fails, or every
		// later write would inherit that rejection.
		this.#queue = run.catch(() => undefined);
		await run;
	}

	/**
	 * The file's contents, or an empty store when it does not exist yet.
	 *
	 * Unreadable content throws instead of starting empty: the next write would
	 * otherwise replace a file full of subscriptions with an empty one, and the
	 * only trace of the accident would be users no longer receiving anything.
	 */
	async #read(): Promise<StoreFile> {
		let raw: string;
		try {
			raw = await readFile(this.#path, "utf8");
		} catch (cause) {
			if (isNotFound(cause)) return { version: 1, subscriptions: {} };
			throw cause;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (cause) {
			throw new NovaError(
				"E_NOVA_STORE_FILE_UNREADABLE",
				`${this.#path} is not valid JSON, so the subscriptions it holds cannot be read.`,
				{
					hint: "Fix or move the file. Starting from empty would overwrite it on the next subscribe.",
					cause,
				},
			);
		}

		if (!isStoreFile(parsed)) {
			throw new NovaError(
				"E_NOVA_STORE_FILE_UNREADABLE",
				`${this.#path} is JSON but not a usable subscription store: ${storeFileProblem(parsed)}.`,
				{
					hint: 'Expected { "version": 1, "subscriptions": { "<endpoint>": { "userId": "…", "expirationTime": null, "p256dh": "…", "auth": "…" } } }. Fix or move the file — reading it as empty would overwrite the subscriptions it still holds.',
				},
			);
		}
		return parsed;
	}

	/**
	 * Write to a temporary file, then rename over the real one.
	 *
	 * `rename` is atomic within a filesystem, so a crash mid-write leaves the
	 * previous file intact rather than a truncated one — which for this store
	 * would mean every subscription gone.
	 */
	async #write(file: StoreFile): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		const temporary = `${this.#path}.tmp`;
		await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
		await rename(temporary, this.#path);
	}
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

function isStoreFile(value: unknown): value is StoreFile {
	return storeFileProblem(value) === null;
}

/**
 * What is wrong with the file, or null when nothing is.
 *
 * The shape is checked down to the individual record, not just to
 * `{ version, subscriptions }`. A half-valid entry used to pass: `listByUser`
 * then handed the push layer `{ p256dh: undefined, auth: undefined }`, and the
 * failure surfaced far from here as an encryption error naming neither the
 * file nor the endpoint that caused it.
 */
function storeFileProblem(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "the file holds a JSON value that is not an object";
	}
	if (!("version" in value)) return "the `version` field is missing";
	// This is the whole point of carrying a version: a file written by a later
	// format is refused by name, rather than being read with today's
	// assumptions and written back mangled.
	if (value.version !== 1) {
		return `the format version is ${JSON.stringify(value.version)}, and this build only reads version 1`;
	}
	if (!("subscriptions" in value))
		return "the `subscriptions` field is missing";
	const { subscriptions } = value;
	if (
		typeof subscriptions !== "object" ||
		subscriptions === null ||
		Array.isArray(subscriptions)
	) {
		return "`subscriptions` is not an object";
	}
	for (const [endpoint, stored] of Object.entries(subscriptions)) {
		const problem = subscriptionProblem(stored);
		if (problem !== null) return `the entry for ${endpoint} ${problem}`;
	}
	return null;
}

/** What is wrong with one stored record, or null when nothing is. */
function subscriptionProblem(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "is not an object";
	}
	if (!("userId" in value) || typeof value.userId !== "string") {
		return "has no `userId` string";
	}
	if (!("p256dh" in value) || typeof value.p256dh !== "string") {
		return "has no `p256dh` string";
	}
	if (!("auth" in value) || typeof value.auth !== "string") {
		return "has no `auth` string";
	}
	// `null` is the legitimate value for a subscription that does not expire,
	// which is most of them — so the check is null-or-number, not truthiness.
	if (!("expirationTime" in value)) return "has no `expirationTime`";
	const { expirationTime } = value;
	if (expirationTime !== null && typeof expirationTime !== "number") {
		return "has an `expirationTime` that is neither a number nor null";
	}
	return null;
}
