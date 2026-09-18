import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import type { PiFlowAttachment } from "./pi-attachment.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import { requireAuthorityWork } from "./wait-authority.js";
import { waitDecisionIntent } from "./wait-decisions.js";

export interface WorkIdentity {
	id: string;
	actor: string;
	revision: number;
}
interface Invocation {
	attachment: PiFlowAttachment;
	work?: WorkIdentity;
	active: boolean;
	operation: { active: boolean };
	parent?: Invocation;
}

/** A trusted host supplies work before invocation; tool arguments never establish ownership. */
export class FlowWorkContext {
	private active?: Invocation;
	private selected?: Invocation;
	private returnWork: WorkIdentity[] = [];
	private readonly invocations = new AsyncLocalStorage<Invocation | undefined>();
	constructor(
		private readonly attachment: () => PiFlowAttachment,
		/** Host-supplied authority for automated turns that no producer owns. */
		private readonly automaticWork?: () => Promise<WorkIdentity | undefined>,
	) {}

	get busy(): boolean {
		return this.active !== undefined;
	}

	async run<T>(work: WorkIdentity | undefined, invoke: () => Promise<T>): Promise<T> {
		if (this.active) throw new FlowLedgerError("busy", "Work invocation is already active.");
		const invocation = {
			work: work ? { ...work } : undefined,
			attachment: this.attachment(),
			active: true,
			operation: { active: true },
		};
		this.active = invocation;
		try {
			if (invocation.work) {
				const authority = await invocation.attachment.waits.authoritySnapshot();
				const registered = requireAuthorityWork(
					authority,
					invocation.work.id,
					invocation.work.actor,
					invocation.work.revision,
				);
				if ((registered.lifecycle?.state ?? "active") !== "active")
					throw new FlowLedgerError("transition", "Inactive work cannot start another invocation.");
			}
			this.checkLifetime(invocation);
			return await this.invocations.run(invocation, invoke);
		} finally {
			invocation.active = false;
			invocation.operation.active = false;
			this.selected = undefined;
			this.returnWork = [];
			this.active = undefined;
		}
	}

	/** Native execution without selected work still owns a lifetime for later consumed input. */
	withOperation<T>(invoke: () => Promise<T>): Promise<T> {
		const current = this.invocations.getStore();
		if (current && current === this.active && current.operation.active) return invoke();
		return this.run(undefined, invoke);
	}

	/** Bind a live controller attempt using its durable selection, never its rendered content. */
	async runSelected(attemptId: string, invoke: () => Promise<void>): Promise<void> {
		if (this.active) throw new FlowLedgerError("busy", "Work invocation is already active.");
		const attachment = this.attachment();
		const state = await attachment.ledger.snapshot();
		const attempt = state.attempts.find((item) => item.id === attemptId);
		if (state.activeAttemptId !== attemptId || !attempt || attempt.phase !== "queued")
			throw new FlowLedgerError("stale", "Work invocation requires the active queued attempt.");
		const intent = attempt.admission?.choice.intent;
		if (intent?.rank === 3 && intent.producer === "jouzu-wait-decisions") {
			const waits = await attachment.waits.snapshot();
			const wait = waits.find((item) => isDeepStrictEqual(waitDecisionIntent(item), intent));
			if (!wait) throw new FlowLedgerError("stale", "Selected wait decision no longer matches retained state.");
			const authority = await attachment.waits.authoritySnapshot();
			const work = authority.work.find((item) => item.id === wait.workId);
			if (this.attachment() !== attachment) throw new FlowLedgerError("stale", "Selected wait branch changed.");
			// Paused or finished work may receive a notification, but cannot restart tools.
			if (!work || (work.lifecycle?.state ?? "active") !== "active") return this.runAutomatic(invoke);
			return this.run({ id: work.id, actor: work.owner, revision: work.revision }, invoke);
		}
		// A delivered result names the work that owned its execution, so the turn answers on that work
		// while it is live. A finished or paused owner still delivers, because the completion already
		// happened, and the turn keeps its tools through host work.
		if (intent?.rank === 6) {
			if (!intent.workId) return this.runAutomatic(invoke);
			const authority = await attachment.waits.authoritySnapshot();
			const work = authority.work.find((item) => item.id === intent.workId);
			if (this.attachment() !== attachment) throw new FlowLedgerError("stale", "Selected result branch changed.");
			if (!work || (work.lifecycle?.state ?? "active") !== "active" || !work.participants.includes(intent.producer))
				return this.runAutomatic(invoke);
			return this.run({ id: work.id, actor: work.owner, revision: work.revision }, invoke);
		}
		// Ranks 4 and 5 are producer-bound: their own work is the only authority, so an inactive one is
		// never replaced. Alert and wait-decision turns are scheduled by the host instead, so they fall
		// back to host work rather than running with no authority at all.
		if (!intent || ![4, 5].includes(intent.rank)) return this.runAutomatic(invoke);
		if (!intent.workId) return this.run(undefined, invoke);
		const authority = await attachment.waits.authoritySnapshot();
		const work = authority.work.find((item) => item.id === intent.workId);
		// Unclassified work retains ordinary admission but gains no execution authority.
		if (!work) return this.run(undefined, invoke);
		if (!work.participants.includes(intent.producer))
			throw new FlowLedgerError("identity", "Selected producer does not own the requested work.");
		if (this.attachment() !== attachment) throw new FlowLedgerError("stale", "Selected work branch changed.");
		return this.run({ id: work.id, actor: intent.producer, revision: work.revision }, invoke);
	}

	/** Automated turns run on their own work when no producer owns them, so their tools stay usable. */
	private async runAutomatic(invoke: () => Promise<void>): Promise<void> {
		const work = this.automaticWork ? await this.automaticWork() : undefined;
		return this.run(work, invoke);
	}

	/** Select fresh tool authority after exact native consumption; old scopes are never modified. */
	async selectToolWork(work: WorkIdentity, retainParent = false): Promise<boolean> {
		const root = this.active;
		const caller = this.invocations.getStore();
		if (!root || !caller || caller.operation !== root.operation || !root.operation.active) return false;
		if (caller !== root) this.checkLifetime(caller);
		const attachment = this.attachment();
		const authority = await attachment.waits.authoritySnapshot();
		const registered = requireAuthorityWork(authority, work.id, work.actor, work.revision);
		if ((registered.lifecycle?.state ?? "active") !== "active")
			throw new FlowLedgerError("transition", "Inactive work cannot authorize queued tools.");
		if (
			this.active !== root ||
			!root.operation.active ||
			(caller !== root && !caller.active) ||
			this.attachment() !== attachment
		)
			throw new FlowLedgerError("stale", "Queued work invocation changed.");
		if (caller !== root) this.checkLifetime(caller);
		if (retainParent && caller !== root) {
			const previous = this.selected ?? root;
			if (caller.parent !== previous)
				throw new FlowLedgerError("stale", "Task selection changed before selecting child work.");
			if (previous.work && previous.work.id !== work.id) this.returnWork.push({ ...previous.work });
		} else this.returnWork = [];
		if (this.selected) this.selected.active = false;
		this.selected = { work: { ...work }, attachment, active: true, operation: root.operation };
		return true;
	}

	/** Return only to authority retained when this invocation selected a child task. */
	async returnFromToolWork(): Promise<boolean> {
		const caller = this.invocations.getStore();
		const selected = this.selected ?? this.active;
		if (!caller || !selected || caller.parent !== selected) return false;
		this.checkLifetime(caller);
		const authority = await selected.attachment.waits.authoritySnapshot();
		this.checkLifetime(caller);
		if ((this.selected ?? this.active) !== selected)
			throw new FlowLedgerError("stale", "Task selection changed before returning from completed work.");
		const completed = authority.work.find((item) => item.id === selected.work?.id);
		if (completed?.lifecycle?.state !== "completed") return false;
		const parent = this.returnWork.at(-1);
		if (!parent) {
			// A task continuation has no caller to return to. Following tools may inspect
			// state, but receive no authority to start work under the completed task.
			if (this.selected) this.selected.active = false;
			this.selected = { attachment: selected.attachment, active: true, operation: selected.operation };
			return true;
		}
		const remaining = this.returnWork.slice(0, -1);
		// selectToolWork validates the exact retained revision and active lifecycle.
		const restored = await this.selectToolWork(parent);
		if (restored) this.returnWork = remaining;
		return restored;
	}

	captureInvocationCheck(): () => boolean {
		const invocation = this.invocations.getStore();
		return () => this.invocations.getStore() === invocation;
	}

	/** Parallel tools receive separate lifetimes while preserving the parent work identity. */
	async runTool<T>(invoke: () => Promise<T>): Promise<T> {
		const current = this.invocations.getStore();
		const parent = current === this.active && this.selected ? this.selected : current;
		if (!parent?.active || !parent.work) return this.invocations.run(undefined, invoke);
		this.checkLifetime(parent);
		const invocation = { ...parent, parent, active: true };
		try {
			return await this.invocations.run(invocation, invoke);
		} finally {
			invocation.active = false;
		}
	}

	/** A newly consumed input ends this work's authority without ending Pi's run. */
	revoke(): void {
		if (this.active) this.active.active = false;
		if (this.selected) this.selected.active = false;
	}

	private checkLifetime(invocation: Invocation): void {
		if (invocation.parent) this.checkLifetime(invocation.parent);
		if (!invocation.active || !invocation.operation.active || this.attachment() !== invocation.attachment)
			throw new FlowLedgerError("stale", "Work invocation is no longer active in this branch.");
	}

	private check(invocation: Invocation): void {
		this.checkLifetime(invocation);
		if (invocation.work)
			invocation.attachment.waits.captureExecutionWork(
				invocation.work.id,
				invocation.work.revision,
				invocation.work.actor,
			);
	}

	current(): { id: string; revision: number } | undefined {
		const invocation = this.invocations.getStore();
		if (!invocation) return undefined;
		this.check(invocation);
		return invocation.work ? { id: invocation.work.id, revision: invocation.work.revision } : undefined;
	}

	authorize(workId: string): { actor: string; revision: number; assertActive(): void } {
		const invocation = this.invocations.getStore();
		if (!invocation?.work || invocation.work.id !== workId)
			throw new FlowLedgerError("identity", "Requested work does not belong to this invocation.");
		this.check(invocation);
		return {
			actor: invocation.work.actor,
			revision: invocation.work.revision,
			// Wait mutations validate the captured actor/revision inside their transaction.
			assertActive: () => this.checkLifetime(invocation),
		};
	}
}
