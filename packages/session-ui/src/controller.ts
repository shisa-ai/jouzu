import type { SessionUiClock } from "./contracts.js";
import { SYSTEM_SESSION_UI_CLOCK } from "./contracts.js";
import {
	createSessionStatusSnapshot,
	type SessionSnapshotContext,
	type SessionStatusSnapshot,
	type SessionUiFact,
} from "./snapshot.js";
import type { SessionUiCommandRunner } from "./sources/command.js";
import { type GitStatusSnapshot, readGitStatus } from "./sources/git.js";
import { type RuntimeSnapshot, readRuntimeSnapshot } from "./sources/runtime.js";

export interface SessionStatusControllerOptions {
	run: SessionUiCommandRunner;
	clock?: SessionUiClock;
	readGit?: typeof readGitStatus;
	readRuntime?: typeof readRuntimeSnapshot;
}

interface PendingProjectRefresh {
	ctx: SessionSnapshotContext;
	git: boolean;
	runtime: boolean;
}

export class SessionStatusController {
	private readonly run: SessionUiCommandRunner;
	private readonly clock: SessionUiClock;
	private readonly readGit: typeof readGitStatus;
	private readonly readRuntime: typeof readRuntimeSnapshot;
	private readonly listeners = new Set<(snapshot: SessionStatusSnapshot) => void>();
	private readonly abortController = new AbortController();
	private current?: SessionStatusSnapshot;
	private git?: SessionUiFact<GitStatusSnapshot>;
	private runtime?: SessionUiFact<RuntimeSnapshot>;
	private idleSince?: number;
	private pendingRefresh?: PendingProjectRefresh;
	private refreshPromise?: Promise<void>;
	private disposed = false;

	constructor(options: SessionStatusControllerOptions) {
		this.run = options.run;
		this.clock = options.clock ?? SYSTEM_SESSION_UI_CLOCK;
		this.readGit = options.readGit ?? readGitStatus;
		this.readRuntime = options.readRuntime ?? readRuntimeSnapshot;
	}

	getSnapshot(): SessionStatusSnapshot | undefined {
		return this.current;
	}

	subscribe(listener: (snapshot: SessionStatusSnapshot) => void): () => void {
		this.listeners.add(listener);
		if (this.current) listener(this.current);
		return () => this.listeners.delete(listener);
	}

	sync(ctx: SessionSnapshotContext): SessionStatusSnapshot {
		if (ctx.isIdle()) this.idleSince ??= this.clock.now();
		else this.idleSince = undefined;
		const snapshot = createSessionStatusSnapshot(ctx, {
			clock: this.clock,
			...(this.idleSince === undefined ? {} : { idleSince: this.idleSince }),
			...(this.git ? { git: this.git } : {}),
			...(this.runtime ? { runtime: this.runtime } : {}),
		});
		this.current = snapshot;
		if (!this.disposed) {
			for (const listener of this.listeners) listener(snapshot);
		}
		return snapshot;
	}

	refreshProject(ctx: SessionSnapshotContext): Promise<void> {
		return this.queueRefresh(ctx, true, true);
	}

	refreshGit(ctx: SessionSnapshotContext): Promise<void> {
		return this.queueRefresh(ctx, true, false);
	}

	private queueRefresh(ctx: SessionSnapshotContext, git: boolean, runtime: boolean): Promise<void> {
		if (this.disposed) return Promise.resolve();
		this.pendingRefresh = this.pendingRefresh
			? {
					ctx,
					git: this.pendingRefresh.git || git,
					runtime: this.pendingRefresh.runtime || runtime,
				}
			: { ctx, git, runtime };
		if (!this.refreshPromise) {
			this.refreshPromise = this.runRefreshLoop().finally(() => {
				this.refreshPromise = undefined;
			});
		}
		return this.refreshPromise;
	}

	private async runRefreshLoop(): Promise<void> {
		while (!this.disposed && this.pendingRefresh) {
			const request = this.pendingRefresh;
			this.pendingRefresh = undefined;
			const [git, runtime] = await Promise.allSettled([
				request.git ? this.readGit(request.ctx.cwd, this.run, this.abortController.signal) : Promise.resolve(undefined),
				request.runtime
					? this.readRuntime(request.ctx.cwd, this.run, this.abortController.signal)
					: Promise.resolve(undefined),
			]);
			if (this.disposed) return;
			const observedAt = this.clock.now();
			if (request.git) {
				this.git =
					git.status === "fulfilled"
						? { status: git.value ? "known" : "unknown", observedAt, ...(git.value ? { value: git.value } : {}) }
						: { status: "error", observedAt };
			}
			if (request.runtime) {
				this.runtime =
					runtime.status === "fulfilled"
						? {
								status: runtime.value ? "known" : "unknown",
								observedAt,
								...(runtime.value ? { value: runtime.value } : {}),
							}
						: { status: "error", observedAt };
			}
			this.sync(request.ctx);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.pendingRefresh = undefined;
		this.abortController.abort();
		this.listeners.clear();
	}
}
