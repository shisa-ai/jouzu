import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execute = promisify(execFile);
const OWNER = "@jouzu-label-owner";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (...args: string[]) => args.map(quote).join(" ");
export const validPaneLabel = (value: string): boolean => /^[a-z0-9](?:[a-z0-9-]{0,10}[a-z0-9])?$/.test(value);

/** One captured pane on one captured server. Never follows the active pane. */
export class TmuxLabels {
	private readonly owner = randomUUID();
	private previous: string | undefined;
	private last: string | undefined;
	private lost = false;
	private queue: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly socket: string,
		private readonly pane: string,
	) {}

	static fromEnvironment(env: NodeJS.ProcessEnv = process.env): TmuxLabels | undefined {
		const socket = env.TMUX?.replace(/,\d+,\d+$/, "");
		const pane = env.TMUX_PANE;
		return socket && pane && /^%\d+$/.test(pane) ? new TmuxLabels(socket, pane) : undefined;
	}

	private async run(...args: string[]): Promise<string> {
		const result = await execute("tmux", ["-S", this.socket, ...args], { timeout: 1000, maxBuffer: 16_384 });
		return result.stdout.replace(/\n$/, "");
	}

	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.then(operation);
		this.queue = next.catch(() => {});
		return next;
	}

	/** Explicit claim permits replacing an unknown title, but never another attachment's claim. */
	update(label: string, explicit = false): Promise<boolean> {
		return this.serial(async () => {
			if (!validPaneLabel(label) || (this.lost && !explicit)) return false;
			if (explicit) this.lost = false;
			try {
				if (this.last === undefined) {
					const title = await this.run("display-message", "-p", "-t", this.pane, "#{pane_title}");
					if (!explicit && title !== "") return false;
					this.previous = title;
					// Both the empty-owner check and mutation execute in one tmux command queue.
					const guard = explicit ? `#{==:#{${OWNER}},}` : `#{&&:#{==:#{${OWNER}},},#{==:#{pane_title},}}`;
					await this.run(
						"if-shell",
						"-F",
						"-t",
						this.pane,
						guard,
						`${command("set-option", "-p", "-t", this.pane, OWNER, this.owner)} ; ${command("select-pane", "-t", this.pane, "-T", label)}`,
					);
				} else {
					await this.run(
						"if-shell",
						"-F",
						"-t",
						this.pane,
						this.guard(),
						command("select-pane", "-t", this.pane, "-T", label),
					);
				}
				const observed = await this.run("display-message", "-p", "-t", this.pane, `#{${OWNER}}:#{pane_title}`);
				if (observed !== `${this.owner}:${label}`) {
					await this.clearOwner();
					this.last = undefined;
					this.lost = true;
					return false;
				}
				this.last = label;
				return true;
			} catch {
				return false;
			}
		});
	}

	private guard(): string {
		return `#{&&:#{==:#{${OWNER}},${this.owner}},#{==:#{pane_title},${this.last}}}`;
	}

	private async clearOwner(): Promise<void> {
		await this.run(
			"if-shell",
			"-F",
			"-t",
			this.pane,
			`#{==:#{${OWNER}},${this.owner}}`,
			command("set-option", "-pu", "-t", this.pane, OWNER),
		);
	}

	/** A manual rename wins, including at shutdown. Pinning releases without restoring. */
	release(restore = true): Promise<void> {
		return this.serial(async () => {
			try {
				if (restore && this.last !== undefined && this.previous !== undefined) {
					await this.run(
						"if-shell",
						"-F",
						"-t",
						this.pane,
						this.guard(),
						command("select-pane", "-t", this.pane, "-T", this.previous.replaceAll("#", "##")),
					);
				}
				await this.clearOwner();
			} catch {
				/* A missing server or pane is already released. */
			}
			this.last = undefined;
			this.previous = undefined;
		});
	}
}
