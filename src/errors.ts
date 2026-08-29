/**
 * NovaError — structured error (agnostic; no @c9up/ream dependency).
 */
export class NovaError extends Error {
	readonly code: string;
	readonly hint?: string;

	constructor(
		code: string,
		message: string,
		options?: { hint?: string; cause?: unknown },
	) {
		// `cause` keeps the underlying failure attached — a JSON parse error says
		// which byte it choked on, and that is the half worth reading.
		super(
			message,
			options?.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = "NovaError";
		this.code = code;
		this.hint = options?.hint;
	}
}
