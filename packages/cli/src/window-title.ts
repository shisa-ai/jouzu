type AsyncOperation<T> = () => Promise<T>;

const PI_WINDOW_TITLE_PREFIX = "\u001b]0;π - ";
const JOUZU_WINDOW_TITLE_PREFIX = "\u001b]0;Jouzu - ";

/** Brand Pi-owned terminal title sequences without changing other process output. */
export function rewritePiWindowTitle(text: string): string {
	return text.replaceAll(PI_WINDOW_TITLE_PREFIX, JOUZU_WINDOW_TITLE_PREFIX);
}

/** Scope terminal-title branding to the pinned Pi runtime invocation. */
export async function withJouzuWindowTitle<T>(operation: AsyncOperation<T>): Promise<T> {
	const originalWrite = process.stdout.write;
	const jouzuWrite = function (this: NodeJS.WriteStream, chunk: Uint8Array | string, ...args: unknown[]): boolean {
		const output = typeof chunk === "string" ? rewritePiWindowTitle(chunk) : chunk;
		return Reflect.apply(originalWrite, this, [output, ...args]) as boolean;
	} as typeof process.stdout.write;

	process.stdout.write = jouzuWrite;
	try {
		return await operation();
	} finally {
		if (process.stdout.write === jouzuWrite) process.stdout.write = originalWrite;
	}
}
