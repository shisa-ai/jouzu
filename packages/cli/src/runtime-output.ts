const ANSI_SEQUENCE = String.raw`\x1B\[[0-?]*[ -/]*[@-~]`;
const PI_RESUME_HINT = new RegExp(
	String.raw`(To resume this session:(?:${ANSI_SEQUENCE})*[\t ]+)pi[^\r\n]*[\t ]--session[\t ]+([A-Za-z0-9._-]+)(?=\r?\n|$)`,
	"g",
);

/** Replace Pi's process-level exit hint without changing stock Pi or its session files. */
export function rewriteResumeHint(text: string): string {
	return text.replace(PI_RESUME_HINT, "$1jz --session $2");
}

const PI_WINDOW_TITLE_PREFIX = "\u001b]0;π - ";
const JOUZU_WINDOW_TITLE_PREFIX = "\u001b]0;Jouzu - ";

/** Brand Pi-owned terminal title sequences without changing other process output. */
export function rewritePiWindowTitle(text: string): string {
	return text.replaceAll(PI_WINDOW_TITLE_PREFIX, JOUZU_WINDOW_TITLE_PREFIX);
}

/** Brand Pi output for the lifetime of one runtime invocation. */
export async function withJouzuOutput<T>(operation: () => Promise<T>, interactive = false): Promise<T> {
	const originalWrite = process.stdout.write;
	const jouzuWrite = function (this: NodeJS.WriteStream, chunk: Uint8Array | string, ...args: unknown[]): boolean {
		let output = typeof chunk === "string" ? rewriteResumeHint(chunk) : chunk;
		if (interactive && typeof output === "string") output = rewritePiWindowTitle(output);
		return Reflect.apply(originalWrite, this, [output, ...args]) as boolean;
	} as typeof process.stdout.write;

	process.stdout.write = jouzuWrite;
	try {
		return await operation();
	} finally {
		if (process.stdout.write === jouzuWrite) process.stdout.write = originalWrite;
	}
}
