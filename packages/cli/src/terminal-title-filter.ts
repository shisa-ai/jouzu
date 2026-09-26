/** Streaming OSC 0/1/2 suppression, including split writes and ST terminators. */
export class TerminalTitleFilter {
	private pending: number[] = [];
	private title = false;
	private escape = false;
	filter(chunk: string | Uint8Array): Buffer {
		const output: number[] = [];
		for (const byte of typeof chunk === "string" ? Buffer.from(chunk) : chunk) {
			if (this.title) {
				if (byte === 7 || (this.escape && byte === 92)) this.title = false;
				this.escape = byte === 27;
				continue;
			}
			if (this.pending.length === 0) {
				if (byte === 27) this.pending.push(byte);
				else output.push(byte);
				continue;
			}
			this.pending.push(byte);
			const [first, second, third, fourth] = this.pending;
			if (
				first === 27 &&
				second === 93 &&
				(third === undefined || (third >= 48 && third <= 50)) &&
				fourth === undefined
			)
				continue;
			if (second === 93 && third !== undefined && third >= 48 && third <= 50 && fourth === 59) {
				this.title = true;
				this.escape = false;
			} else if (byte === 27) {
				output.push(...this.pending.slice(0, -1));
				this.pending = [27];
				continue;
			} else output.push(...this.pending);
			this.pending = [];
		}
		return Buffer.from(output);
	}
}
