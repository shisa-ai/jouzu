import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const OWNER = "@jouzu-label-owner";
const VALUE = "@jouzu-label-value";
const STATUS_FORMATS = new Set(["#I:#W#F", "#I:#W#{?window_flags,#{window_flags}, }"]);
const DISPLAY_NAME = `#{?#{&&:#{${OWNER}},#{&&:#{==:#{pane_title},#{${VALUE}}},#{||:#{automatic-rename},#{==:#{window_name},}}}},#{pane_title},#W}`;
export function paneLabelStatusFormat(original: string): string | undefined {
	return STATUS_FORMATS.has(original) ? original.replace("#W", DISPLAY_NAME) : undefined;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (...args: string[]) => args.map(quote).join(" ");
export const validPaneLabel = (value: string): boolean => /^[a-z0-9](?:[a-z0-9-]{0,10}[a-z0-9])?$/.test(value);

/** Recognize workspace-prefixed shell titles for a running Jouzu command. */
export function automaticPaneTitle(title: string, cwd: string, home = homedir()): boolean {
	if (title === "" || title === "jouzu") return true;
	const folders = [cwd];
	if (cwd === home) folders.push("~");
	else if (cwd.startsWith(`${home}/`)) folders.push(`~${cwd.slice(home.length)}`);
	return folders.some((folder) => {
		const prefix = `${folder}: `;
		return title.startsWith(prefix) && /^(jz|jouzu)(?: [^\r\n]*)? - \1$/.test(title.slice(prefix.length));
	});
}

/** One captured pane on one captured server. Never follows the active pane. */
export class TmuxLabels {
	private readonly owner = randomUUID();
	private previous: string | undefined;
	private last: string | undefined;
	private lost = false;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly folders: string[];
	constructor(
		private readonly socket: string,
		private readonly pane: string,
		cwd = process.cwd(),
		logicalCwd = process.env.PWD,
	) {
		this.folders = [cwd];
		try {
			if (logicalCwd && isAbsolute(logicalCwd) && realpathSync(logicalCwd) === realpathSync(cwd))
				this.folders.push(logicalCwd);
		} catch {
			/* A missing or stale shell path cannot authorize a title claim. */
		}
	}

	static fromEnvironment(env: NodeJS.ProcessEnv = process.env): TmuxLabels | undefined {
		const socket = env.TMUX?.replace(/,\d+,\d+$/, "");
		const pane = env.TMUX_PANE;
		return socket && pane && /^%\d+$/.test(pane) ? new TmuxLabels(socket, pane, process.cwd(), env.PWD) : undefined;
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
					if (!explicit && !this.folders.some((folder) => automaticPaneTitle(title, folder))) return false;
					this.previous = title;
					// Keep observed titles out of the format expression: paths and arguments can
					// contain commas, braces, or tmux format syntax. Compare option values instead.
					const expected = `@jouzu-label-title-${this.owner}`;
					try {
						if (!explicit) await this.run("set-option", "-p", "-t", this.pane, expected, title);
						const guard = explicit
							? `#{==:#{${OWNER}},}`
							: `#{&&:#{==:#{${OWNER}},},#{==:#{pane_title},#{${expected}}}}`;
						// The empty-owner check and title comparison execute with the claim in one queue.
						await this.run(
							"if-shell",
							"-F",
							"-t",
							this.pane,
							guard,
							`${command("set-option", "-p", "-t", this.pane, OWNER, this.owner)} ; ${command("select-pane", "-t", this.pane, "-T", label)}`,
						);
					} finally {
						// A cleanup failure must not bypass verification of a claim already made.
						if (!explicit) await this.run("set-option", "-pu", "-t", this.pane, expected).catch(() => {});
					}
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
				await this.run("set-option", "-p", "-t", this.pane, VALUE, label);
				await this.installStatusDisplay().catch(() => {});
				return true;
			} catch {
				return false;
			}
		});
	}

	/** Recognized stock formats only. The conditional falls back after release or manual rename. */
	private async installStatusDisplay(): Promise<void> {
		const expected = `@jouzu-label-format-${this.owner}`;
		try {
			for (const option of ["window-status-format", "window-status-current-format"]) {
				const original = await this.run("show-options", "-wAv", "-t", this.pane, option);
				const replacement = paneLabelStatusFormat(original);
				if (!replacement) continue;
				await this.run("set-option", "-p", "-t", this.pane, expected, original);
				await this.run(
					"if-shell",
					"-F",
					"-t",
					this.pane,
					`#{&&:#{==:#{${OWNER}},${this.owner}},#{==:#{${option}},#{${expected}}}}`,
					command("set-option", "-w", "-t", this.pane, option, replacement),
				);
			}
		} finally {
			await this.run("set-option", "-pu", "-t", this.pane, expected);
		}
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
			`${command("set-option", "-pu", "-t", this.pane, OWNER)} ; ${command("set-option", "-pu", "-t", this.pane, VALUE)}`,
		);
		await this.run("set-option", "-pu", "-t", this.pane, `@jouzu-label-title-${this.owner}`).catch(() => {});
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
