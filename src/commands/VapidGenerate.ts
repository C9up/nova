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
import { BaseCommand, flags } from "@c9up/ream";
import { generateVapidKeys } from "../vapid.js";

const PUBLIC_KEY = "NOVA_VAPID_PUBLIC_KEY";
const PRIVATE_KEY = "NOVA_VAPID_PRIVATE_KEY";

export default class VapidGenerate extends BaseCommand {
	static override commandName = "nova:vapid:generate";
	static override description =
		"Generate a VAPID key pair for Web Push (writes NOVA_VAPID_* into .env)";

	@flags.boolean({
		description:
			"Overwrite an existing key pair — every current subscription stops working",
	})
	declare force: boolean;

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
			this.logger.error(
				`${PRIVATE_KEY} is already set in .env. Re-run with --force to overwrite — ` +
					"every subscription signed with the current key stops working.",
			);
			this.exitCode = 1;
			return;
		}

		const pair = generateVapidKeys();
		let updated = upsertEnvVar(existing, PUBLIC_KEY, pair.publicKey);
		updated = upsertEnvVar(updated, PRIVATE_KEY, pair.privateKey);
		writeFileSync(envPath, updated);

		this.logger.success(`Wrote ${PUBLIC_KEY} and ${PRIVATE_KEY} to .env`);
		this.logger.info(`Public key: ${pair.publicKey}`);
	}
}

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
