import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_SCAN_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SCANNER_VERSION = "1.0.0";
export type UnavailableReason =
	| "input-limit"
	| "output-limit"
	| "timeout"
	| "process"
	| "version"
	| "protocol"
	| "busy"
	| "closed"
	| "file"
	| "budget";
export interface ScanFinding {
	kind: string;
	severity: "info" | "warn" | "error";
	offset: number | null;
}
export interface ScanEvidence {
	status: "clear" | "findings" | "unavailable";
	findings: ScanFinding[];
	reason?: UnavailableReason;
	findingCount?: number;
	severityCounts?: Record<ScanFinding["severity"], number>;
}
export interface TextScanner {
	scan(text: string, timeoutMs?: number): Promise<ScanEvidence>;
	close(): Promise<void>;
}
export const unavailable = (reason: UnavailableReason): ScanEvidence => ({
	status: "unavailable",
	findings: [],
	reason,
});

interface ProcessRequest {
	command: string;
	args: string[];
	input: string;
	env: NodeJS.ProcessEnv;
	cwd: string;
	timeoutMs: number;
}
interface ProcessResult {
	stdout: string;
	code?: number | null;
	reason?: UnavailableReason;
}

/** No shell, bounded pipes, and no source text or child diagnostics in errors. */
export function runBoundedProcess(request: ProcessRequest): Promise<ProcessResult> {
	return new Promise((resolve) => {
		const child = spawn(request.command, request.args, {
			cwd: request.cwd,
			env: request.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const chunks: Buffer[] = [];
		let bytes = 0;
		let reason: UnavailableReason | undefined;
		const stop = (value: UnavailableReason) => {
			reason ??= value;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => stop("timeout"), request.timeoutMs);
		child.stdout.on("data", (data: Buffer) => {
			bytes += data.length;
			if (bytes > MAX_OUTPUT_BYTES) stop("output-limit");
			else if (!reason) chunks.push(data);
		});
		child.stderr.on("data", (data: Buffer) => {
			bytes += data.length;
			if (bytes > MAX_OUTPUT_BYTES) stop("output-limit");
		});
		child.stdin.on("error", () => {
			/* Early exit may close stdin before the bounded input is written. */
		});
		child.on("error", () => {
			reason ??= "process";
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve(reason ? { stdout: "", reason } : { stdout: Buffer.concat(chunks).toString("utf8"), code });
		});
		child.stdin.end(request.input, "utf8");
	});
}

function parseEvidence(output: ProcessResult): ScanEvidence {
	if (output.reason) return unavailable(output.reason);
	if (output.code === null || output.code === undefined || output.code < 0 || output.code > 3)
		return unavailable("process");
	try {
		const payload = JSON.parse(output.stdout);
		if (payload?.path !== "stdin" || !Array.isArray(payload.result?.findings) || payload.result.semantic != null)
			return unavailable("protocol");
		const findings: ScanFinding[] = [];
		let severityCode = 0;
		const severityCounts = { info: 0, warn: 0, error: 0 };
		for (const finding of payload.result.findings) {
			if (
				!finding ||
				typeof finding.kind !== "string" ||
				!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/u.test(finding.kind) ||
				!["info", "warn", "error"].includes(finding.severity) ||
				!(finding.offset === null || (Number.isSafeInteger(finding.offset) && finding.offset >= 0))
			)
				return unavailable("protocol");
			severityCounts[finding.severity as ScanFinding["severity"]] += 1;
			severityCode = Math.max(
				severityCode,
				{ info: 1, warn: 2, error: 3 }[finding.severity as ScanFinding["severity"]],
			);
			if (findings.length < 16)
				findings.push({ kind: finding.kind, severity: finding.severity, offset: finding.offset });
		}
		if (severityCode !== output.code) return unavailable("protocol");
		return {
			status: severityCode ? "findings" : "clear",
			findings,
			findingCount: payload.result.findings.length,
			severityCounts,
		};
	} catch {
		return unavailable("protocol");
	}
}

export class PythonTextGuard implements TextScanner {
	private readonly cache = new Map<string, ScanEvidence>();
	private initialization?: Promise<UnavailableReason | undefined>;
	private directory?: string;
	private closed = false;
	private active = 0;
	private readonly jobs = new Set<Promise<ScanEvidence>>();
	private readonly env: NodeJS.ProcessEnv = {};
	private readonly run: typeof runBoundedProcess;
	constructor(private readonly options: { python: string; yara?: boolean; run?: typeof runBoundedProcess }) {
		this.run = options.run ?? runBoundedProcess;
		// Keep only OS startup variables. Local project/Python/TextGuard settings and credentials are excluded.
		for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]) {
			if (process.env[key] !== undefined) this.env[key] = process.env[key];
		}
	}
	private async initialize(): Promise<UnavailableReason | undefined> {
		try {
			this.directory = await mkdtemp(join(tmpdir(), "jouzu-textguard-"));
			this.env.XDG_CONFIG_HOME = this.directory;
			const probe = await this.execute(["-c", "import textguard; print(textguard.__version__)"], "", 2000);
			if (probe.reason) return probe.reason;
			if (probe.code !== 0) return "process";
			return probe.stdout.trim() === SCANNER_VERSION ? undefined : "version";
		} catch {
			return "process";
		}
	}
	private execute(args: string[], input: string, timeoutMs: number): Promise<ProcessResult> {
		return this.run({
			command: this.options.python,
			args: ["-I", "-X", "utf8", ...args],
			input,
			env: this.env,
			cwd: this.directory as string,
			timeoutMs,
		});
	}
	async scan(text: string, timeoutMs = 2000): Promise<ScanEvidence> {
		if (this.closed) return unavailable("closed");
		if (Buffer.byteLength(text, "utf8") > MAX_SCAN_BYTES) return unavailable("input-limit");
		const key = createHash("sha256").update(text).digest("hex");
		const cached = this.cache.get(key);
		if (cached) return cached;
		if (this.active >= 4) return unavailable("busy");
		this.active += 1;
		const job = this.scanUncached(text, Math.max(1, Math.min(2000, timeoutMs)));
		this.jobs.add(job);
		try {
			const evidence = await job;
			if (evidence.status !== "unavailable") {
				if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value as string);
				this.cache.set(key, evidence);
			}
			return evidence;
		} finally {
			this.active -= 1;
			this.jobs.delete(job);
		}
	}
	private async scanUncached(text: string, timeoutMs: number): Promise<ScanEvidence> {
		try {
			const start = performance.now();
			this.initialization ??= this.initialize();
			const failure = await this.initialization;
			if (failure) return unavailable(failure);
			const remaining = timeoutMs - (performance.now() - start);
			if (remaining <= 0) return unavailable("timeout");
			return parseEvidence(
				await this.execute(
					[
						"-m",
						"textguard.cli",
						"scan",
						"-",
						"--json",
						"--preset",
						"default",
						"--confusables",
						"trimmed",
						"--split-tokens",
						this.options.yara ? "--yara-bundled" : "--no-yara-bundled",
					],
					text,
					remaining,
				),
			);
		} catch {
			return unavailable("process");
		}
	}
	async close(): Promise<void> {
		this.closed = true;
		await Promise.allSettled(this.jobs);
		if (this.directory) await rm(this.directory, { recursive: true, force: true });
		this.cache.clear();
	}
}
