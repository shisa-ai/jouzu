import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SCAN_BYTES, type ScanEvidence, type TextScanner, unavailable } from "./textguard.js";

const OUTPUT_LIMIT = 64 * 1024;
const QUEUE_LIMIT = 16;
const QUEUE_BYTES = 2 * 1024 * 1024;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export interface NativeEvidence extends ScanEvidence {
	inputDigest?: string;
	decodeReasons?: string[];
}
interface Job {
	text: string;
	bytes: number;
	digest: string;
	resolve: (result: NativeEvidence) => void;
	done: boolean;
	timer: ReturnType<typeof setTimeout>;
	cleanup: () => void;
}

/** One isolated helper, serial bounded requests, and no scanner text in diagnostics. */
export class NativeTextGuard implements TextScanner {
	private child?: ChildProcessWithoutNullStreams;
	private directory?: string;
	private queue: Job[] = [];
	private queuedBytes = 0;
	private active?: Job;
	private pumping?: Promise<void>;
	private closed = false;
	private sequence = 0;
	private pending?: (line?: Buffer) => void;
	private closePromise?: Promise<void>;
	private verifiedIdentity?: string;
	private shutdown?: Promise<void>;

	constructor(private artifactDirectory = fileURLToPath(new URL("./textguard/", import.meta.url))) {}

	/** Available after executable verification; includes scanner, rules, and policy. */
	get identity(): string | undefined {
		return this.verifiedIdentity;
	}

	scan(text: string, timeoutMs = 2000, signal?: AbortSignal): Promise<NativeEvidence> {
		if (this.closed) return Promise.resolve(unavailable("closed"));
		if (/[\uD800-\uDFFF]/u.test(text)) return Promise.resolve(unavailable("protocol"));
		const bytes = Buffer.byteLength(text);
		if (bytes > MAX_SCAN_BYTES) return Promise.resolve(unavailable("input-limit"));
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || signal?.aborted)
			return Promise.resolve(unavailable("timeout"));
		if (this.queue.length + Number(Boolean(this.active)) >= QUEUE_LIMIT || this.queuedBytes + bytes > QUEUE_BYTES)
			return Promise.resolve(unavailable("busy"));
		return new Promise((resolve) => {
			const job: Job = {
				text,
				bytes,
				digest: sha(text),
				resolve,
				done: false,
				timer: undefined as never,
				cleanup: () => {},
			};
			const cancel = () => {
				this.finish(job, unavailable("timeout"));
				if (this.active === job) this.child?.kill("SIGKILL");
				else {
					const index = this.queue.indexOf(job);
					if (index >= 0) {
						this.queue.splice(index, 1);
						this.queuedBytes -= job.bytes;
					}
				}
			};
			job.timer = setTimeout(cancel, Math.min(timeoutMs, 10000));
			signal?.addEventListener("abort", cancel, { once: true });
			job.cleanup = () => signal?.removeEventListener("abort", cancel);
			this.queue.push(job);
			this.queuedBytes += bytes;
			this.kick();
		});
	}

	private finish(job: Job, evidence: NativeEvidence): void {
		if (job.done) return;
		job.done = true;
		clearTimeout(job.timer);
		job.cleanup();
		job.resolve(evidence);
	}

	private async start(): Promise<void> {
		if (this.child) return;
		const arch = { x64: "amd64", arm64: "arm64" }[process.arch as "x64" | "arm64"];
		if (!arch || !["linux", "darwin", "win32"].includes(process.platform)) throw new Error("platform");
		const target = `${process.platform === "win32" ? "windows" : process.platform}-${arch}`;
		const expectedName = `textguard-${target}${process.platform === "win32" ? ".exe" : ""}`;
		const manifestPath = join(this.artifactDirectory, "manifest.json");
		const stat = await lstat(manifestPath);
		if (!stat.isFile() || stat.size > 16384) throw new Error("manifest");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		const artifact = manifest?.artifacts?.[target];
		if (
			manifest.schemaVersion !== 1 ||
			manifest.protocol !== 1 ||
			manifest.policy !== "default-trimmed-split-bundled-v1" ||
			!/^[a-f0-9]{64}$/.test(manifest.sourceDigest) ||
			artifact?.filename !== expectedName ||
			!/^[a-f0-9]{64}$/.test(artifact.sha256)
		)
			throw new Error("manifest");
		const executable = join(this.artifactDirectory, expectedName);
		const info = await lstat(executable);
		if (!info.isFile() || info.size !== artifact.bytes || info.size > 16 * 1024 * 1024) throw new Error("executable");
		if (sha(await readFile(executable)) !== artifact.sha256) throw new Error("integrity");
		this.verifiedIdentity = sha(
			JSON.stringify({
				source: manifest.sourceDigest,
				policy: manifest.policy,
				binary: artifact.sha256,
				protocol: manifest.protocol,
			}),
		);
		this.directory ??= await mkdtemp(join(tmpdir(), "jouzu-textguard-native-"));
		if (this.closed || this.active?.done) return;
		const env: NodeJS.ProcessEnv = {
			HOME: this.directory,
			USERPROFILE: this.directory,
			XDG_CONFIG_HOME: this.directory,
		};
		if (process.platform === "win32") {
			for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) if (process.env[key]) env[key] = process.env[key];
		}
		const child = spawn(executable, [], { cwd: this.directory, env, stdio: "pipe", windowsHide: true });
		this.child = child;
		let buffer = Buffer.alloc(0);
		let stderrBytes = 0;
		this.closePromise = new Promise((resolve) =>
			child.once("close", () => {
				if (this.child === child) this.child = undefined;
				const pending = this.pending;
				this.pending = undefined;
				pending?.();
				resolve();
			}),
		);
		child.on("error", () => {
			/* close resolves the pending request */
		});
		child.stdin.on("error", () => {
			child.kill("SIGKILL");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > OUTPUT_LIMIT) child.kill("SIGKILL");
		});
		child.stdout.on("data", (chunk: Buffer) => {
			if (!this.pending || buffer.length + chunk.length > OUTPUT_LIMIT) {
				child.kill("SIGKILL");
				return;
			}
			buffer = Buffer.concat([buffer, chunk]);
			const end = buffer.indexOf(10);
			if (end < 0) return;
			if (end !== buffer.length - 1) {
				child.kill("SIGKILL");
				return;
			}
			const line = buffer.subarray(0, end);
			buffer = Buffer.alloc(0);
			const pending = this.pending;
			this.pending = undefined;
			pending?.(line);
		});
	}

	private kick(): void {
		this.pumping ??= this.pump().finally(() => {
			this.pumping = undefined;
			if (this.queue.length && !this.closed) this.kick();
		});
	}

	private async pump(): Promise<void> {
		while (this.queue.length && !this.closed) {
			const job = this.queue.shift();
			if (!job) break;
			this.queuedBytes -= job.bytes;
			if (job.done) continue;
			this.active = job;
			try {
				await this.start();
				if (job.done || this.closed || !this.child) continue;
				const id = String(++this.sequence);
				const child = this.child;
				const line = await new Promise<Buffer | undefined>((resolve) => {
					this.pending = resolve;
					child.stdin.write(`${JSON.stringify({ version: 1, id, text: job.text })}\n`);
				});
				if (!job.done) {
					const evidence = line ? parseNativeEvidence(line, id, job.digest) : unavailable("process");
					if (evidence.reason === "protocol") child.kill("SIGKILL");
					this.finish(job, evidence);
				}
			} catch {
				this.finish(job, unavailable("process"));
				this.child?.kill("SIGKILL");
			} finally {
				if (this.child?.killed) await this.closePromise;
				this.active = undefined;
			}
		}
	}

	close(): Promise<void> {
		this.shutdown ??= this.stop();
		return this.shutdown;
	}

	private async stop(): Promise<void> {
		this.closed = true;
		for (const job of this.queue) this.finish(job, unavailable("closed"));
		this.queue = [];
		this.queuedBytes = 0;
		if (this.active) this.finish(this.active, unavailable("closed"));
		this.child?.kill("SIGKILL");
		await this.pumping;
		await this.closePromise;
		if (this.directory) await rm(this.directory, { recursive: true, force: true });
	}
}

export function parseNativeEvidence(line: Buffer, id: string, digest: string): NativeEvidence {
	try {
		if (line.length > OUTPUT_LIMIT) return unavailable("protocol");
		const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
		if (
			value.version !== 1 ||
			value.id !== id ||
			value.input_sha256 !== digest ||
			!["clear", "findings", "unavailable"].includes(value.status) ||
			!Array.isArray(value.findings) ||
			value.findings.length > 64 ||
			!Number.isSafeInteger(value.finding_count) ||
			value.finding_count < value.findings.length ||
			value.finding_count > 4096 ||
			!Array.isArray(value.decode_reasons) ||
			value.decode_reasons.length > 9
		)
			return unavailable("protocol");
		const counts = value.severity_counts;
		if (
			!counts ||
			Object.keys(counts).length !== 3 ||
			!["info", "warn", "error"].every((k) => Number.isSafeInteger(counts[k]) && counts[k] >= 0) ||
			counts.info + counts.warn + counts.error !== value.finding_count
		)
			return unavailable("protocol");
		for (const finding of value.findings) {
			if (
				!finding ||
				typeof finding.kind !== "string" ||
				!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/.test(finding.kind) ||
				!["info", "warn", "error"].includes(finding.severity) ||
				!(
					finding.offset === null ||
					(Number.isSafeInteger(finding.offset) && finding.offset >= 0 && finding.offset <= MAX_SCAN_BYTES)
				) ||
				typeof finding.codepoint !== "string" ||
				!/^(?:U\+[A-F0-9]{4,6})?$/.test(finding.codepoint)
			)
				return unavailable("protocol");
		}
		if (!value.decode_reasons.every((r: unknown) => typeof r === "string" && /^encoding:[a-z_]{1,40}$/.test(r)))
			return unavailable("protocol");
		if (
			(value.status === "clear" && value.finding_count !== 0) ||
			(value.status === "findings" && value.finding_count === 0)
		)
			return unavailable("protocol");
		if (value.status === "unavailable") {
			if (
				!["finding-limit", "decode-limit", "input-limit", "scanner", "protocol", "output-limit"].includes(value.reason)
			)
				return unavailable("protocol");
		} else if (value.reason !== undefined) return unavailable("protocol");
		const sampled = { info: 0, warn: 0, error: 0 };
		const findings = value.findings.map(
			(finding: { kind: string; severity: "info" | "warn" | "error"; offset: number | null; codepoint: string }) => {
				sampled[finding.severity]++;
				return { kind: finding.kind, severity: finding.severity, offset: finding.offset, codepoint: finding.codepoint };
			},
		);
		if (sampled.info > counts.info || sampled.warn > counts.warn || sampled.error > counts.error)
			return unavailable("protocol");
		if (
			value.status !== "unavailable" &&
			(findings.length !== Math.min(64, value.finding_count) ||
				value.decode_reasons.some((r: string) =>
					["encoding:decode_bound_hit", "encoding:decode_depth_limited"].includes(r),
				))
		)
			return unavailable("protocol");
		return {
			status: value.status,
			findings,
			findingCount: value.finding_count,
			severityCounts: counts,
			inputDigest: digest,
			decodeReasons: value.decode_reasons,
			...(value.reason ? { reason: value.reason } : {}),
		};
	} catch {
		return unavailable("protocol");
	}
}
