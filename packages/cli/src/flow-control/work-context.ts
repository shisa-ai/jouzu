import { AsyncLocalStorage } from "node:async_hooks";
import type { PiFlowAttachment } from "./pi-attachment.js";
import { FlowLedgerError } from "./receipt-ledger.js";

interface Invocation {
	attachment: PiFlowAttachment;
	id: string;
	actor: string;
	revision: number;
	active: boolean;
}

/** A trusted host supplies work before invocation; tool arguments never establish ownership. */
export class FlowWorkContext {
	private active?: Invocation;
	private readonly invocations = new AsyncLocalStorage<Invocation>();
	constructor(private readonly attachment: () => PiFlowAttachment) {}

	async run<T>(work: { id: string; actor: string; revision: number }, invoke: () => Promise<T>): Promise<T> {
		if (this.active) throw new FlowLedgerError("busy", "Work invocation is already active.");
		const invocation = { ...work, attachment: this.attachment(), active: true };
		this.check(invocation);
		this.active = invocation;
		return this.invocations.run(invocation, async () => {
			try {
				return await invoke();
			} finally {
				invocation.active = false;
				this.active = undefined;
			}
		});
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
		if (!intent || ![4, 5].includes(intent.rank)) return invoke();
		if (!intent.workId) return invoke();
		const authority = await attachment.waits.authoritySnapshot();
		const work = authority.work.find((item) => item.id === intent.workId);
		// Unclassified work retains ordinary admission but gains no execution authority.
		if (!work) return invoke();
		if (!work.participants.includes(intent.producer))
			throw new FlowLedgerError("identity", "Selected producer does not own the requested work.");
		if (this.attachment() !== attachment) throw new FlowLedgerError("stale", "Selected work branch changed.");
		return this.run({ id: work.id, actor: intent.producer, revision: work.revision }, invoke);
	}

	private checkLifetime(invocation: Invocation): void {
		if (!invocation.active || this.attachment() !== invocation.attachment)
			throw new FlowLedgerError("stale", "Work invocation is no longer active in this branch.");
	}

	private check(invocation: Invocation): void {
		this.checkLifetime(invocation);
		invocation.attachment.waits.captureExecutionWork(invocation.id, invocation.revision, invocation.actor);
	}

	current(): { id: string; revision: number } | undefined {
		const invocation = this.invocations.getStore();
		if (!invocation) return undefined;
		this.check(invocation);
		return { id: invocation.id, revision: invocation.revision };
	}

	authorize(workId: string): { actor: string; revision: number; assertActive(): void } {
		const invocation = this.invocations.getStore();
		if (!invocation || invocation.id !== workId)
			throw new FlowLedgerError("identity", "Requested work does not belong to this invocation.");
		this.check(invocation);
		return {
			actor: invocation.actor,
			revision: invocation.revision,
			// Wait mutations validate the captured actor/revision inside their transaction.
			assertActive: () => this.checkLifetime(invocation),
		};
	}
}
