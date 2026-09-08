import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { decideNativeAdmission } from "./native-admission.js";
import { type PiFlowBranchResources, type PiFlowSessionOptions, PiFlowSessionService } from "./pi-session-service.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowNativeInput } from "./submission-store.js";
import { activeAdmissionHolds } from "./submission-view.js";

type Ingress = NonNullable<CreateAgentSessionOptions["flowIngress"]>;
type Submission = Parameters<Ingress["submit"]>[0];
export interface PiFlowIngressOptions extends Omit<PiFlowSessionOptions, "admitNativeQueue"> {
	/** Semantic admission override; omission uses conservative unadapted-send admission. */
	admit?(
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
	private session?: AgentSession;
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
		this.session = session;
		this.opening = (async () => {
			const service = await PiFlowSessionService.open(session, {
				...this.options,
				admitNativeQueue: (record, input) =>
					this.track(async () => {
						const branch = this.branch();
						const allowed = await this.admit(
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
	/** Read persisted admission reasons; inspection cannot reconstruct an executable send. */
	async heldInputs(): Promise<{ id: string; reason: string }[]> {
		const records = await this.branch().attachment.submissions.snapshot();
		return records.flatMap((record) =>
			activeAdmissionHolds(record).map((hold) => ({ id: record.id, reason: hold.reason })),
		);
	}

	/** Versioned read-only management snapshot; neither inspection nor receipt presence authorizes replay. */
	inspect() {
		return this.track(async () => {
			const branch = this.branch();
			const submissions = await branch.attachment.submissionViews();
			if (this.branch() !== branch) throw new FlowLedgerError("stale", "Flow inspection branch changed.");
			return { version: 1 as const, scope: { ...branch.scope }, submissions };
		});
	}
	private manage<T>(run: (service: PiFlowSessionService) => Promise<T>): Promise<T> {
		this.branch();
		const service = this.service;
		if (!service) return Promise.reject(new FlowLedgerError("stale", "Flow management has no attached session."));
		return this.track(() => run(service));
	}
	cancelNativeQueue(id: string, revision: number): Promise<void> {
		return this.manage((service) => service.cancelNativeQueue(id, revision));
	}
	reconcileNativeQueueEdit(id: string, revision: number): Promise<void> {
		return this.manage((service) => service.reconcileNativeQueueEdit(id, revision));
	}
	retryNativeRequest(id: string, expectedHash: string): Promise<void> {
		return this.manage((service) => service.retryNativeRequest(id, expectedHash));
	}
	cancelNativeSources(id: string, expectedHash: string, indices: number[]): Promise<void> {
		return this.manage((service) => service.cancelNativeSources(id, expectedHash, indices));
	}

	private async admit(
		submission: Submission,
		branch: PiFlowBranchResources,
		phase: "submission" | "queue",
		input?: FlowNativeInput,
	): Promise<boolean> {
		if (!this.session) throw new FlowLedgerError("stale", "Flow ingress has no host session.");
		const records = await branch.attachment.submissions.snapshot();
		const state = await branch.attachment.ledger.snapshot();
		const policy = this.options.policy();
		const recoveryBlocked =
			policy.recoveryBlocked ||
			branch.attachment.nativeRequests.recoveryBlocked ||
			branch.recovery.unresolved > 0 ||
			branch.sourceRecovery.unresolved > 0 ||
			state.attempts.some((attempt) => attempt.phase === "uncertain");
		let decision = decideNativeAdmission(
			submission,
			records,
			{
				...policy,
				recoveryBlocked,
			},
			this.session,
			phase,
			input,
		);
		if (this.options.admit && !recoveryBlocked) {
			try {
				decision = (await this.options.admit(
					structuredClone(submission),
					branch,
					phase,
					input ? structuredClone(input) : undefined,
				))
					? { allowed: true }
					: { allowed: false, reason: "Input is held by host admission policy." };
			} catch (error) {
				await branch.attachment.submissions.recordAdmission(
					submission.id,
					records.find((record) => record.id === submission.id)?.revision ?? 0,
					{ phase, ...(input?.queue ? { queue: input.queue } : {}) },
					"Host admission policy failed; review input before retry.",
				);
				throw error;
			}
		}
		if (branch.attachment.nativeRequests.recoveryBlocked)
			decision = { allowed: false, reason: "Input is waiting for recovery reconciliation." };
		const current = records.find((record) => record.id === submission.id);
		if (!current) return false;
		const saved = await branch.attachment.submissions.recordAdmission(
			submission.id,
			current.revision,
			{ phase, ...(input?.queue ? { queue: input.queue } : {}) },
			decision.allowed ? undefined : decision.reason,
		);
		if (!saved && phase === "submission")
			throw new FlowLedgerError("stale", "Retained input changed during admission.");
		return saved && decision.allowed;
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
			if (!(await this.admit(structuredClone(pending.submission), branch, "submission"))) return false;
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
	/** Retire an undispatched instruction and its live callback without starting host work. */
	cancelRetained(id: string, revision: number) {
		const branch = this.branch();
		return this.track(async () => {
			const result = await branch.attachment.submissions.cancelPending(id, revision);
			if (result.kind === "cancelled") {
				const pending = this.pending.get(id);
				if (pending?.branch === branch) this.pending.delete(id);
			}
			return result;
		});
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
