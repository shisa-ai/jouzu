import { type ChildProcess, execFileSync, fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { JouzuPaths } from "../paths.js";
import { ensurePrivateDirectory, writeFilePrivateAtomic } from "../private-fs.js";
import { acquireStateLock } from "../state-lock.js";
import type { WorkerCommand, WorkerEvent, WorkerLaunch } from "./protocol.js";
import { captureReviewCandidate, type ReviewCandidate } from "./review.js";
import { type AgentRole, digest, parseAgentConfig } from "./roles.js";

export type RunStatus = "queued" | "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface AgentRun {
	id: string;
	parentSessionId: string;
	parentEntryId?: string;
	previousRunId?: string;
	role: AgentRole;
	roleRevision: string;
	model: { provider: string; id: string };
	review?: { candidate: ReviewCandidate; status: "pending" | "unchanged" | "changed" | "unverified" };
	cwd: string;
	task: string;
	status: RunStatus;
	createdAt: string;
	updatedAt: string;
	sessionFile?: string;
	childSessionId?: string;
	currentTool?: string;
	result?: string;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number | null;
		costComplete?: boolean;
	};
}
export interface WorkerHandle {
	send(command: WorkerCommand): void;
	stop(): Promise<void>;
}
export type WorkerFactory = (
	launch: WorkerLaunch,
	emit: (event: WorkerEvent) => void,
	exit: (success: boolean) => void,
) => WorkerHandle;

const ACTIVE = new Set<RunStatus>(["queued", "starting", "running"]);
export function isActiveRun(run: AgentRun): boolean {
	return ACTIVE.has(run.status);
}
export function roleCanWrite(role: AgentRole): boolean {
	return role.tools.some((name) => ["write", "edit", "bash", "powershell"].includes(name));
}
export function workerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of [
		"PATH",
		"HOME",
		"USERPROFILE",
		"SYSTEMROOT",
		"SystemRoot",
		"WINDIR",
		"COMSPEC",
		"PATHEXT",
		"TEMP",
		"TMP",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		"SHELL",
	])
		if (source[name]) env[name] = source[name];
	return { ...env, PI_SKIP_VERSION_CHECK: "1", NO_COLOR: "1" };
}
function killTree(child: ChildProcess): Promise<void> {
	return new Promise((done) => {
		if (!child.pid) return done();
		if (process.platform === "win32") {
			const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
				windowsHide: true,
				stdio: "ignore",
				shell: false,
			});
			killer.once("error", () => {
				child.kill("SIGKILL");
				done();
			});
			killer.once("close", () => done());
		} else {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {}
			}
			done();
		}
	});
}
export const processWorker: WorkerFactory = (launch, emit, onExit) => {
	const child = fork(new URL("./worker.js", import.meta.url), [], {
		cwd: launch.cwd,
		env: workerEnvironment(),
		execArgv: [],
		stdio: ["ignore", "ignore", "ignore", "ipc"],
		detached: process.platform !== "win32",
	});
	let exited = false;
	let resolveExit: () => void;
	const closed = new Promise<void>((done) => {
		resolveExit = done;
	});
	child.on("message", (event: WorkerEvent) => emit(event));
	const finish = (ok: boolean) => {
		if (exited) return;
		exited = true;
		void killTree(child).finally(() => {
			resolveExit();
			onExit(ok);
		});
	};
	child.once("error", () => finish(false));
	child.once("exit", (code) => finish(code === 0));
	child.send({ type: "start", launch } satisfies WorkerCommand, (error) => {
		if (error) finish(false);
	});
	return {
		send(command) {
			if (exited || !child.connected) throw new Error("Agent is no longer running.");
			child.send(command, (error) => {
				if (error) finish(false);
			});
		},
		async stop() {
			if (exited) return closed;
			// Pi aborts active tools before exiting. Preserve a descendant list for forced cleanup.
			let descendants: number[] = [];
			if (process.platform !== "win32" && child.pid) {
				try {
					const pairs = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 2000 })
						.trim()
						.split("\n")
						.map((line) => line.trim().split(/\s+/).map(Number));
					const parents = new Set([child.pid]);
					for (let changed = true; changed; ) {
						changed = false;
						for (const [pid, parent] of pairs)
							if (parents.has(parent) && !parents.has(pid)) {
								parents.add(pid);
								changed = true;
							}
					}
					descendants = [...parents].filter((pid) => pid !== child.pid);
				} catch {}
			}
			if (child.connected) child.send({ type: "stop" } satisfies WorkerCommand, () => {});
			let timer: ReturnType<typeof setTimeout>;
			await Promise.race([
				closed,
				new Promise<void>((done) => {
					timer = setTimeout(done, 3000);
				}),
			]);
			clearTimeout(timer!);
			for (const pid of descendants.reverse()) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
			if (!exited) await killTree(child);
			await closed;
		},
	};
};
function ownedJson(path: string): AgentRun {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000)
		throw new Error("Storage: invalid agent run record.");
	const run = JSON.parse(readFileSync(path, "utf8")) as AgentRun;
	parseAgentConfig({ schemaVersion: 1, maxConcurrent: 1, roles: [run.role] });
	if (
		!run.model ||
		typeof run.model.id !== "string" ||
		typeof run.model.provider !== "string" ||
		typeof run.cwd !== "string" ||
		typeof run.createdAt !== "string" ||
		typeof run.task !== "string" ||
		!run.usage ||
		!["queued", "starting", "running", "completed", "failed", "cancelled", "interrupted"].includes(run.status) ||
		run.roleRevision !== digest(run.role)
	)
		throw new Error("Invalid agent run record.");
	return run;
}
export class SubagentManager {
	private readonly root: string;
	private readonly runs = new Map<string, AgentRun>();
	private readonly pending = new Map<string, WorkerLaunch>();
	private readonly workers = new Map<string, WorkerHandle>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly results = new Map<string, WorkerEvent & { type: "result" }>();
	private readonly listeners = new Set<() => void>();
	private readonly releases = new Map<string, () => void>();
	private releaseOwner?: () => void;
	private queueTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private pumping = false;
	private storageError?: string;
	constructor(
		private readonly paths: JouzuPaths,
		readonly parentSessionId: string,
		private readonly maxConcurrent: number,
		private readonly factory: WorkerFactory = processWorker,
		private readonly onComplete?: (run: AgentRun) => void,
	) {
		this.root = join(paths.stateDir, "subagents", digest(parentSessionId));
		if (!existsSync(this.root)) return;
		for (const id of readdirSync(this.root)) {
			if (!/^[a-f0-9-]{36}$/.test(id)) continue;
			try {
				if (lstatSync(join(this.root, id)).isSymbolicLink()) throw new Error("Invalid run directory.");
				const run = ownedJson(join(this.root, id, "run.json"));
				if (run.id === id && run.parentSessionId === parentSessionId) this.runs.set(id, run);
			} catch {
				this.storageError = "Storage: an agent record could not be read. Inspect the stored session before retrying.";
			}
		}
	}
	private directory(id: string): string {
		const path = join(this.root, id);
		if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Storage: invalid run directory.");
		return path;
	}
	attach(): void {
		this.acquireOwner();
	}
	private acquireOwner(): void {
		if (this.disposed) throw new Error("This agent session has closed.");
		if (this.storageError) throw new Error(this.storageError);
		if (this.releaseOwner) return;
		ensurePrivateDirectory(this.paths.stateDir, this.root);
		this.releaseOwner = acquireStateLock({
			path: join(this.root, "owner.lock"),
			staleMs: -1,
			describe: "subagent session",
			onBusy: () =>
				new Error("This session's agents are controlled by another Jouzu process. Close it before starting more work."),
		});
		for (const run of this.runs.values())
			if (isActiveRun(run)) {
				run.status = "interrupted";
				run.result = "Previous execution could not be verified. Inspect the workspace before resuming.";
				this.persist(run);
			}
	}
	private persist(run: AgentRun): void {
		run.updatedAt = new Date().toISOString();
		writeFilePrivateAtomic(join(this.directory(run.id), "run.json"), `${JSON.stringify(run)}\n`, this.root);
	}
	private event(run: AgentRun, event: unknown): void {
		const path = join(this.directory(run.id), "events.jsonl");
		if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Storage: invalid agent event file.");
		appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...(event as object) })}\n`, {
			mode: 0o600,
		});
	}
	private changed(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {}
		}
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	list(): AgentRun[] {
		return [...this.runs.values()]
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map((run) => structuredClone(run));
	}
	get(id: string): AgentRun {
		const run = this.runs.get(id);
		if (!run) throw new Error("Agent run was not found in this parent session.");
		return structuredClone(run);
	}
	read(id: string, offset = 0, limit = 12_000): { text: string; nextOffset: number | null; totalBytes: number } {
		this.get(id);
		if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 32_000)
			throw new Error("Read: use a nonnegative byte offset and a limit of 1–32000 bytes.");
		const path = join(this.directory(id), "events.jsonl");
		if (!existsSync(path)) return { text: "No output yet.", nextOffset: null, totalBytes: 0 };
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Storage: invalid agent event file.");
		if (offset > stat.size) throw new Error("Read offset is past the end of the agent output.");
		const fd = openSync(path, "r");
		try {
			const data = Buffer.alloc(Math.min(Math.max(limit, 4) + 3, stat.size - offset));
			const read = readSync(fd, data, 0, data.length, offset);
			let bytes = Math.min(Math.max(limit, 4), read);
			// Include a complete UTF-8 character at the page boundary.
			while (bytes < read && (data[bytes] & 0xc0) === 0x80) bytes++;
			if (offset && read && (data[0] & 0xc0) === 0x80)
				throw new Error("Read offset must begin at a UTF-8 character boundary. Use nextOffset from the previous page.");
			return {
				text: data.subarray(0, bytes).toString("utf8"),
				nextOffset: offset + bytes < stat.size ? offset + bytes : null,
				totalBytes: stat.size,
			};
		} finally {
			closeSync(fd);
		}
	}
	launch(launch: Omit<WorkerLaunch, "directory">, parentEntryId?: string, previousRunId?: string): AgentRun {
		this.acquireOwner();
		if (!launch.task.trim() || launch.task.length > 32_000) throw new Error("Task: enter 1–32000 characters.");
		if (launch.role.placement === "main") throw new Error("Choose a role that can run as a child agent.");
		if (this.pending.size >= 32) throw new Error("Agent queue is full. Wait for work to finish.");
		const id = randomUUID();
		const now = new Date().toISOString();
		const run: AgentRun = {
			id,
			parentSessionId: this.parentSessionId,
			parentEntryId,
			previousRunId,
			role: structuredClone(launch.role),
			roleRevision: digest(launch.role),
			model: { provider: launch.model.provider, id: launch.model.id },
			cwd: realpathSync(launch.cwd),
			task: launch.task,
			status: "queued",
			createdAt: now,
			updatedAt: now,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null, costComplete: true },
		};
		let sessionFile: string | undefined;
		if (previousRunId) {
			const previous = this.get(previousRunId);
			if (isActiveRun(previous)) throw new Error("Stop or finish this agent before resuming it.");
			if (
				previous.cwd !== run.cwd ||
				previous.roleRevision !== run.roleRevision ||
				previous.model.id !== run.model.id ||
				previous.model.provider !== run.model.provider
			)
				throw new Error("Resume requires the original workspace, role revision, and model.");
			sessionFile = previous.sessionFile;
			if (
				[...this.runs.values()].some(
					(other) =>
						isActiveRun(other) &&
						(other.sessionFile === sessionFile || this.pending.get(other.id)?.sessionFile === sessionFile),
				)
			)
				throw new Error("This child session already has an active follow-up.");
			if (!sessionFile || !existsSync(sessionFile) || !this.containsSession(sessionFile))
				throw new Error("The saved child session is unavailable.");
		}
		run.sessionFile = sessionFile;
		if (run.role.judging) run.review = { candidate: captureReviewCandidate(run.cwd), status: "pending" };
		ensurePrivateDirectory(this.root, this.directory(id));
		this.persist(run);
		this.event(run, { type: "task", text: launch.task, roleRevision: run.roleRevision });
		this.runs.set(id, run);
		this.pending.set(id, {
			...launch,
			role: structuredClone(run.role),
			model: structuredClone(launch.model),
			auth: structuredClone(launch.auth),
			task: run.review
				? `${launch.task}\n\nReview candidate: ${JSON.stringify(run.review.candidate)}. Inspect the assigned scope independently. Return findings with severity, file/line, failure conditions and evidence, then coverage and checks you could not perform. A response is not approval to ship.`
				: launch.task,
			cwd: run.cwd,
			directory: sessionFile ? dirname(sessionFile) : this.directory(id),
			sessionFile,
		});
		this.pump();
		this.changed();
		return this.get(id);
	}
	private containsSession(path: string): boolean {
		const rel = relative(realpathSync(this.root), realpathSync(path));
		return (
			!!rel &&
			!isAbsolute(rel) &&
			rel !== ".." &&
			!rel.startsWith(`..${sep}`) &&
			lstatSync(path).isFile() &&
			!lstatSync(path).isSymbolicLink()
		);
	}
	private pump(): void {
		if (this.pumping || this.disposed) return;
		this.pumping = true;
		try {
			for (const [id, launch] of this.pending) {
				if (this.workers.size >= this.maxConcurrent) break;
				const run = this.runs.get(id)!;
				const sameWorkspace = [...this.workers.keys()]
					.map((key) => this.runs.get(key)!)
					.filter((other) => other.cwd === run.cwd);
				if (sameWorkspace.some((other) => roleCanWrite(other.role)) || (roleCanWrite(run.role) && sameWorkspace.length))
					continue;
				let release: (() => void) | undefined;
				try {
					// Serialize workspace writers across parent sessions as well.
					if (roleCanWrite(run.role))
						release = acquireStateLock({
							path: join(this.paths.stateDir, "subagent-writers", `${digest(run.cwd)}.lock`),
							staleMs: -1,
							describe: "workspace writer",
							onBusy: () => new Error("Writer busy"),
						});
				} catch {
					continue;
				}
				if (release) this.releases.set(id, release);
				this.pending.delete(id);
				run.status = "starting";
				this.persist(run);
				try {
					const handle = this.factory(
						launch,
						(event) => this.receive(id, event),
						(ok) => this.exited(id, ok),
					);
					this.workers.set(id, handle);
					this.timers.set(
						id,
						setTimeout(() => {
							void this.stop(id, "Agent timed out. Work is incomplete.", "failed").catch(() => {});
						}, run.role.timeoutSeconds * 1000),
					);
				} catch {
					this.exited(id, false);
				}
			}
		} finally {
			this.pumping = false;
		}
		if (this.pending.size && !this.queueTimer)
			this.queueTimer = setTimeout(() => {
				this.queueTimer = undefined;
				this.pump();
			}, 500);
	}
	private receive(id: string, event: WorkerEvent): void {
		const run = this.runs.get(id);
		if (!run || !isActiveRun(run)) return;
		try {
			if (event.type === "ready") {
				run.status = "running";
				run.sessionFile = event.sessionFile;
				run.childSessionId = event.sessionId;
			}
			if (event.type === "activity") run.currentTool = event.tool;
			if (event.type === "usage") {
				for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const)
					run.usage[field] += Math.max(0, event[field] || 0);
				if (event.cost === null) {
					run.usage.costComplete = false;
					run.usage.cost = null;
				} else if (run.usage.costComplete) run.usage.cost = (run.usage.cost ?? 0) + event.cost;
			}
			if (event.type === "result") this.results.set(id, event);
			this.event(run, event);
			this.persist(run);
			this.changed();
		} catch {
			void this.stop(id, "Storage failed while recording this agent. Work is incomplete.", "failed").catch(() => {});
		}
	}
	private exited(id: string, success: boolean): void {
		const run = this.runs.get(id);
		if (!run || (!this.workers.has(id) && !isActiveRun(run))) return;
		clearTimeout(this.timers.get(id));
		this.timers.delete(id);
		this.workers.delete(id);
		this.releases.get(id)?.();
		this.releases.delete(id);
		const result = this.results.get(id);
		this.results.delete(id);
		if (isActiveRun(run)) {
			run.status = success && result ? result.status : "failed";
			run.result =
				success && result
					? result.text
					: "Agent exited before a complete result was recorded. Inspect its output before retrying.";
		}
		if (run.review) {
			const after = captureReviewCandidate(run.cwd);
			run.review.status =
				!after.identity || !run.review.candidate.identity
					? "unverified"
					: after.identity === run.review.candidate.identity
						? "unchanged"
						: "changed";
			if (run.review.status !== "unchanged")
				run.result = `Review candidate ${run.review.status}; this result does not establish the final workspace state.\n${run.result ?? ""}`;
		}
		run.currentTool = undefined;
		try {
			this.persist(run);
			this.event(run, { type: "terminal", status: run.status });
		} catch {
			this.storageError = "Storage failed while saving an agent result.";
		}
		this.changed();
		if (!this.disposed) this.onComplete?.(structuredClone(run));
		this.pump();
	}
	steer(id: string, text: string): string {
		this.acquireOwner();
		this.get(id);
		if (!text.trim() || text.length > 16_000) throw new Error("Message: enter 1–16000 characters.");
		const worker = this.workers.get(id);
		if (!worker) throw new Error("This agent is not running. Use Resume for a follow-up.");
		const receipt = randomUUID();
		this.event(this.runs.get(id)!, { type: "steer", id: receipt, status: "accepted", text });
		worker.send({ type: "steer", id: receipt, text });
		return receipt;
	}
	async stop(
		id: string,
		reason = "Agent cancelled. Inspect its changes before continuing.",
		status: "cancelled" | "failed" = "cancelled",
	): Promise<void> {
		if (!this.releaseOwner) this.acquireOwner();
		const run = this.runs.get(id);
		if (!run) throw new Error("Agent run not found.");
		if (!isActiveRun(run)) return;
		run.status = status;
		run.result = reason;
		this.pending.delete(id);
		const worker = this.workers.get(id);
		if (worker) {
			await worker.stop();
		} else {
			this.persist(run);
			this.changed();
			this.pump();
		}
	}
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		clearTimeout(this.queueTimer);
		for (const id of this.pending.keys()) {
			const run = this.runs.get(id)!;
			run.status = "interrupted";
			run.result = "Parent session closed before this agent started.";
			try {
				this.persist(run);
			} catch {}
		}
		this.pending.clear();
		for (const id of this.workers.keys()) {
			const run = this.runs.get(id)!;
			run.status = "interrupted";
			run.result = "Parent session closed. Inspect changes before resuming.";
		}
		await Promise.allSettled([...this.workers.values()].map((worker) => worker.stop()));
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.releaseOwner?.();
		this.releaseOwner = undefined;
		this.listeners.clear();
	}
}
