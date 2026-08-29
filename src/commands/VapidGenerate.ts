/**
 * `nova:vapid:generate` — mint a VAPID key pair and write it into `.env`.
 *
 * Web Push needs a stable key pair per application: the public half goes to
 * the browser at subscribe time, the private half signs every push. Losing the
 * private key invalidates every existing subscription, which is why this
 * refuses to overwrite one without being told to.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateVapidKeys } from "../vapid.js";
import { flag, type NovaCommandClass } from "./contract.js";

const PUBLIC_KEY = "NOVA_VAPID_PUBLIC_KEY";
const PRIVATE_KEY = "NOVA_VAPID_PRIVATE_KEY";

class VapidGenerate {
	static commandName = "nova:vapid:generate";
	static description =
		"Generate a VAPID key pair for Web Push (writes NOVA_VAPID_* into .env)";

	// Writes one file; nothing here needs a booted application.
	static options = { startApp: false };

	static flags = [
		flag("force", "boolean", {
			description:
				"Overwrite an existing key pair — every current subscription stops working",
		}),
	];

	force = false;

	async run(): Promise<void> {
		const envPath = resolve(process.cwd(), ".env");
		let existing = "";
		try {
			existing = readFileSync(envPath, "utf8");
		} catch {
			// No .env yet — the file is created below. A project configured
			// entirely through the shell environment is a legitimate state.
		}

		if (!this.force && readEnvValue(existing, PRIVATE_KEY)) {
			process.stderr.write(
				`${PRIVATE_KEY} is already set in .env. Re-run with --force to overwrite — ` +
					"every subscription signed with the current key stops working.\n",
			);
			process.exitCode = 1;
			return;
		}

		const pair = generateVapidKeys();
		let updated = upsertEnvVar(existing, PUBLIC_KEY, pair.publicKey);
		updated = upsertEnvVar(updated, PRIVATE_KEY, pair.privateKey);
		writeFileSync(envPath, updated);

		process.stdout.write(
			`  create  .env — ${PUBLIC_KEY}, ${PRIVATE_KEY}\n` +
				`  public  ${pair.publicKey}\n`,
		);
	}
}

/**
 * `satisfies` rather than `implements`: the kernel dispatches structurally, so
 * what has to hold is the STATIC side — the name, the description, the flag
 * metadata — and this is what checks it at compile time.
 */
export default VapidGenerate satisfies NovaCommandClass;

/** The value of `name` in a dotenv body, or `undefined`. */
function readEnvValue(body: string, name: string): string | undefined {
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		if (trimmed.slice(0, eq).trim() !== name) continue;
		const value = trimmed.slice(eq + 1).trim();
		return value === "" ? undefined : value;
	}
	return undefined;
}

/**
 * Set `name` in a dotenv body, replacing the line in place when it is already
 * there — appending a second one would leave the file with two answers.
 */
function upsertEnvVar(body: string, name: string, value: string): string {
	const lines = body.split("\n");
	const index = lines.findIndex((line) => {
		const trimmed = line.trim();
		return !trimmed.startsWith("#") && trimmed.split("=")[0]?.trim() === name;
	});
	if (index !== -1) {
		lines[index] = `${name}=${value}`;
		return lines.join("\n");
	}
	const separator = body === "" || body.endsWith("\n") ? "" : "\n";
	return `${body}${separator}${name}=${value}\n`;
}
