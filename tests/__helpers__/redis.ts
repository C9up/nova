/**
 * A real Redis for the Redis store's suites, gated on `REDIS_TEST_URL`.
 *
 * The store's writes are server-side scripts, and a fake cannot run one: a
 * fake re-implementing them in JavaScript would test the re-implementation.
 * So these suites talk to a real server. Without `REDIS_TEST_URL` they are
 * skipped; with it, a server that does not answer fails the run instead of
 * skipping it. CI starts one.
 *
 * The client is a few lines of RESP over a socket rather than a Redis
 * package, which nova does not depend on.
 */

import { connect, type Socket } from "node:net";
import { describe } from "vitest";

/** A reply, as RESP 2 carries it. An error inside an array stays an Error. */
export type Reply = string | number | null | Error | Reply[];

/** Where a reply ends in `buffer`, or undefined while it is incomplete. */
function parse(
	buffer: Buffer,
	at: number,
): { value: Reply; next: number } | undefined {
	const lineEnd = buffer.indexOf("\r\n", at);
	if (lineEnd === -1) return undefined;
	const type = String.fromCharCode(buffer[at] ?? 0);
	const line = buffer.toString("utf8", at + 1, lineEnd);
	const next = lineEnd + 2;
	switch (type) {
		case "+":
			return { value: line, next };
		case "-":
			return { value: new Error(line), next };
		case ":":
			return { value: Number(line), next };
		case "$": {
			const length = Number(line);
			if (length === -1) return { value: null, next };
			if (buffer.length < next + length + 2) return undefined;
			return {
				value: buffer.toString("utf8", next, next + length),
				next: next + length + 2,
			};
		}
		case "*": {
			const count = Number(line);
			if (count === -1) return { value: null, next };
			const items: Reply[] = [];
			let cursor = next;
			for (let i = 0; i < count; i++) {
				const item = parse(buffer, cursor);
				if (item === undefined) return undefined;
				items.push(item.value);
				cursor = item.next;
			}
			return { value: items, next: cursor };
		}
		default:
			throw new Error(`unexpected RESP type ${JSON.stringify(type)}`);
	}
}

function encode(args: ReadonlyArray<string | number>): Buffer {
	const parts = [`*${args.length}\r\n`];
	for (const arg of args) {
		const text = String(arg);
		parts.push(`$${Buffer.byteLength(text)}\r\n${text}\r\n`);
	}
	return Buffer.from(parts.join(""));
}

/** One connection: commands are pipelined and answered in order. */
export class RespClient {
	readonly #socket: Socket;
	readonly #waiting: Array<{
		resolve(value: Reply): void;
		reject(error: Error): void;
	}> = [];
	#buffer = Buffer.alloc(0);

	private constructor(socket: Socket) {
		this.#socket = socket;
		socket.on("data", (chunk) => {
			this.#buffer = Buffer.concat([this.#buffer, chunk]);
			for (;;) {
				const reply = parse(this.#buffer, 0);
				if (reply === undefined) return;
				this.#buffer = this.#buffer.subarray(reply.next);
				const waiter = this.#waiting.shift();
				if (waiter === undefined) continue;
				if (reply.value instanceof Error) waiter.reject(reply.value);
				else waiter.resolve(reply.value);
			}
		});
		socket.on("error", (error) => {
			for (const waiter of this.#waiting.splice(0)) waiter.reject(error);
		});
	}

	static async open(url: string): Promise<RespClient> {
		const { hostname, port } = new URL(url);
		const socket = connect({ host: hostname, port: Number(port || 6379) });
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve);
			socket.once("error", reject);
		});
		return new RespClient(socket);
	}

	command(...args: Array<string | number>): Promise<Reply> {
		return new Promise((resolve, reject) => {
			this.#waiting.push({ resolve, reject });
			this.#socket.write(encode(args));
		});
	}

	async close(): Promise<void> {
		await this.command("QUIT").catch(() => undefined);
		this.#socket.destroy();
	}

	// The commands the store issues, in the shape ioredis gives them.

	async get(key: string): Promise<string | null> {
		const reply = await this.command("GET", key);
		if (reply === null || typeof reply === "string") return reply;
		throw new Error(`GET answered ${String(reply)}`);
	}

	eval(
		script: string,
		numKeys: number,
		...args: Array<string | number>
	): Promise<Reply> {
		return this.command("EVAL", script, numKeys, ...args);
	}
}

const url = process.env.REDIS_TEST_URL ?? "";

if (url !== "") {
	// Set means meant: a server that does not answer is a failure, not a skip.
	const probe = await RespClient.open(url).catch((cause: unknown) => {
		throw new Error(`REDIS_TEST_URL is set but ${url} does not answer`, {
			cause,
		});
	});
	await probe.close();
}

/** Whether the suites below run. */
export const redisUrl = url;

/** A `describe` that runs where `REDIS_TEST_URL` names a server. */
export function describeRedis(name: string, body: () => void): void {
	if (url !== "") describe(name, body);
	else describe.skip(name, body);
}

let sequence = 0;
/** A key prefix no other test, file or run shares. */
export function freshPrefix(label: string): string {
	sequence += 1;
	return `nova-test:${process.pid}:${Date.now()}:${label}:${sequence}`;
}

/** Every key under `prefix`, removed. */
export async function dropPrefix(
	client: RespClient,
	prefix: string,
): Promise<void> {
	const keys = await client.command("KEYS", `${prefix}:*`);
	if (!Array.isArray(keys)) return;
	for (const key of keys) {
		if (typeof key === "string") await client.command("DEL", key);
	}
}
