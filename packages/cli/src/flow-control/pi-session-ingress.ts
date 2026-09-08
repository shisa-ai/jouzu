import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { type PiFlowBranchResources, type PiFlowSessionOptions, PiFlowSessionService } from "./pi-session-service.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowNativeInput } from "./submission-store.js";

type Ingress = NonNullable<CreateAgentSessionOptions["flowIngress"]>;
type Submission = Parameters<Ingress["submit"]>[0];
export interface PiFlowIngressOptions extends Omit<PiFlowSessionOptions, "admitNativeQueue"> {
	/** Host policy must establish source authority, lane order, wait gates, and independence. */
	admit(
		submission: Submission,
		branch: PiFlowBranchResources,
		phase: "submission" | "queue",
		input?: FlowNativeInput,
	): Promise<boolean>;
}
interface Pending {
	branch: PiFlowBranchResources;
	submission: Submission;
	revision: number;
	dispatch: () => Promise<void>;
	running?: Promise<boolean>;
}

/** Own Pi's ingress lifecycle and retained one-use callbacks. Persistence never reconstructs a send. */
export class PiSessionFlowIngress implements Ingress {
	readonly version = 1 as const;
	private service?: PiFlowSessionService;
	private opening?: Promise<void>;
	private closing?: Promise<void>;
	private disposed = false;
	private fenced = false;
	private readonly pending = new Map<string, Pending>();
	private readonly frames = new AsyncLocalStorage<{ active: boolean; id?: string }>();
	private readonly active = new Set<Promise<unknown>>();
	constructor(private readonly options: PiFlowIngressOptions) {}

	attach(session: AgentSession): Promise<void> {
		if (this.disposed || this.opening || this.service)
			return Promise.reject(new FlowLedgerError("stale", "Flow ingress is already attached or closed."));
		this.opening = (async () => {
			const service = await PiFlowSessionService.open(session, {
				...this.options,
				admitNativeQueue: (record, input) =>
					this.track(async () => {
						const branch = this.branch();
						if (branch.attachment.nativeRequests.recoveryBlocked) return false;
						const allowed = await this.options.admit(
							structuredClone(record.submission),
							branch,
							"queue",
							structuredClone(input),
						);
						if (this.branch() !== branch)
							throw new FlowLedgerError("stale", "Queued input branch changed during admission.");
						return allowed && !branch.attachment.nativeRequests.recoveryBlocked;
					}, record.id),
			});
			this.service = service;
		})();
		return this.opening;
	}
	branch(): PiFlowBranchResources {
		if (this.disposed || this.fenced || !this.service)
			throw new FlowLedgerError("stale", "Flow ingress is not attached to an active branch.");
		return this.service.branch();
	}
	private track<T>(run: () => Promise<T>, id?: string): Promise<T> {
		const frame = { active: true, id };
		const operation = this.frames.run(frame, run);
		this.active.add(operation);
		void operation
			.finally(() => {
				frame.active = false;
				this.active.delete(operation);
			})
			.catch(() => {});
		return operation;
	}
	submit(submission: Submission, dispatch: () => Promise<void>): Promise<void> {
		const captured = structuredClone(submission);
		return this.track(async () => {
			const branch = this.branch();
			const saved = await branch.attachment.submissions.retain(captured);
			if (this.branch() !== branch) throw new FlowLedgerError("stale", "Flow submission branch changed.");
			if (saved.duplicate || saved.status === "cancelled") return;
			this.pending.set(saved.id, { branch, submission: captured, revision: saved.revision, dispatch });
			try {
				await this.release(saved.id, saved.revision);
			} catch (error) {
				// Pi revokes a callback when its submission handler throws.
				this.pending.delete(saved.id);
				throw error;
			}
		});
	}
	/** Release only a live retained callback after the host's ordinary admission policy succeeds. */
	release(id: string, revision: number): Promise<boolean> {
		const branch = this.branch();
		const pending = this.pending.get(id);
		if (!pending || pending.revision !== revision || pending.branch !== branch)
			return Promise.reject(new FlowLedgerError("stale", "Retained send has no matching live dispatch callback."));
		if (this.frames.getStore()?.active && this.frames.getStore()?.id === id)
			return Promise.reject(new FlowLedgerError("busy", "Flow admission cannot release its own pending send."));
		if (pending.running) return pending.running;
		const run = this.track(async () => {
			if (branch.attachment.nativeRequests.recoveryBlocked) return false;
			if (!(await this.options.admit(structuredClone(pending.submission), branch, "submission"))) return false;
			if (this.branch() !== branch || this.pending.get(id) !== pending)
				throw new FlowLedgerError("stale", "Retained send changed during admission.");
			if (branch.attachment.nativeRequests.recoveryBlocked) return false;
			// Remove before dispatch so a reentrant release cannot consume the callback twice.
			this.pending.delete(id);
			await branch.native.dispatch(id, revision, pending.submission.id, pending.dispatch);
			return true;
		}, id);
		pending.running = run;
		void run
			.finally(() => {
				pending.running = undefined;
			})
			.catch(() => {});
		return run;
	}
	async beforeBranchChange(): Promise<void> {
		if (this.frames.getStore()?.active)
			throw new FlowLedgerError("busy", "Flow ingress cannot navigate from its own admission or dispatch.");
		const service = this.service;
		this.branch();
		this.fenced = true;
		await Promise.allSettled([...this.active]);
		this.pending.clear();
		await service?.beforeBranchChange();
	}
	async branchChanged(): Promise<void> {
		if (this.disposed || !this.fenced || !this.service)
			throw new FlowLedgerError("stale", "Flow branch change is not prepared.");
		await this.service.branchChanged();
		if (!this.disposed) this.fenced = false;
	}
	dispose(): Promise<void> {
		if (this.frames.getStore()?.active)
			return Promise.reject(
				new FlowLedgerError("busy", "Flow ingress cannot close from its own admission or dispatch."),
			);
		this.disposed = true;
		this.fenced = true;
		this.closing ??= (async () => {
			await this.opening?.catch(() => {});
			await Promise.allSettled([...this.active]);
			this.pending.clear();
			await this.service?.close();
		})();
		return this.closing;
	}
}
