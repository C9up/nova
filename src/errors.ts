/**
 * NovaError — structured error (agnostic; no @c9up/ream dependency).
 */
export class NovaError extends Error {
	readonly code: string;
	readonly hint?: string;

	constructor(code: string, message: string, options?: { hint?: string }) {
		super(message);
		this.name = "NovaError";
		this.code = code;
		this.hint = options?.hint;
	}
}
