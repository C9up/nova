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
				`${this.#path} is JSON but not a subscription store.`,
				{ hint: 'Expected { "version": 1, "subscriptions": { … } }.' },
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
	if (typeof value !== "object" || value === null) return false;
	if (!("subscriptions" in value) || !("version" in value)) return false;
	const { subscriptions } = value;
	return typeof subscriptions === "object" && subscriptions !== null;
}
