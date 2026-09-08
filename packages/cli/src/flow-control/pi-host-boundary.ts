import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { FlowLedgerError, type FlowOutcome, type FlowReceiptLedger } from "./receipt-ledger.js";

interface Frame {
	kind: "operation" | "boundary";
	active: boolean;
}
export type PiBoundaryResult<T> = { kind: "busy" } | { kind: "idle"; value: T };
export type PiSettlement = { kind: "inactive" | "waiting" | "cancelled" | "uncertain" | "settled"; attemptId?: string };

/** Serialize idle reconciliation with supported Pi execution and context-changing entry points. */
export class PiHostBoundary {
	private readonly frames = new AsyncLocalStorage<Frame>();
	private active = 0;
	private closed = false;
	private navigated = false;
	private barrier?: Promise<void>;
	private readonly sessionId: string;
	constructor(private readonly session: AgentSession) {
		this.sessionId = session.sessionId;
		const agent = session.agent;
		const prompt = agent.prompt.bind(agent);
		agent.prompt = (input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) =>
			this.operation(() => (typeof input === "string" ? prompt(input, images) : prompt(input)));
		agent.continue = this.wrap(agent.continue.bind(agent));
		agent.continueQueued = this.wrap(agent.continueQueued.bind(agent));
		session.prompt = this.wrap(session.prompt.bind(session));
		session.continueQueued = this.wrap(session.continueQueued.bind(session));
		session.steer = this.wrap(session.steer.bind(session));
		session.followUp = this.wrap(session.followUp.bind(session));
		session.sendUserMessage = this.wrap(session.sendUserMessage.bind(session));
		session.sendCustomMessage = this.wrap(session.sendCustomMessage.bind(session));
		session.compact = this.wrap(session.compact.bind(session));
		const navigate = session.navigateTree.bind(session);
		session.navigateTree = this.wrap(async (...args: Parameters<AgentSession["navigateTree"]>) => {
			const leaf = session.sessionManager.getLeafId();
			try {
				return await navigate(...args);
			} finally {
				if (session.sessionManager.getLeafId() !== leaf) this.navigated = true;
			}
		});
		for (const name of ["steer", "followUp"] as const) {
			const enqueue = agent[name].bind(agent);
			agent[name] = (message) => {
				this.assertActive();
				if (this.barrier) throw new FlowLedgerError("busy", "Native queue mutation must wait for idle reconciliation.");
				return enqueue(message);
			};
		}
		session.setModel = this.wrap(session.setModel.bind(session));
		session.cycleModel = this.wrap(session.cycleModel.bind(session));
	}
	private wrap<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
		return (...args) => this.operation(() => fn(...args));
	}
	private assertActive(): void {
		if (this.closed || this.session.sessionId !== this.sessionId)
			throw new FlowLedgerError("stale", "Host boundary is closed or its session was replaced.");
	}
	private async operation<T>(run: () => Promise<T>): Promise<T> {
		this.assertActive();
		const parent = this.frames.getStore();
		if (parent?.kind === "boundary")
			throw new FlowLedgerError("busy", "Idle reconciliation cannot start a host operation.");
		if (parent?.active) {
			this.active++;
			try {
				return await run();
			} finally {
				this.active--;
			}
		}
		while (this.barrier) await this.barrier;
		this.assertActive();
		const frame: Frame = { kind: "operation", active: true };
		this.active++;
		try {
			return await this.frames.run(frame, run);
		} finally {
			frame.active = false;
			this.active--;
		}
	}
	private idle(): boolean {
		return (
			this.active === 0 &&
			this.session.isIdle &&
			!this.session.agent.state.isStreaming &&
			!this.session.isRetrying &&
			!this.session.isCompacting &&
			!this.session.agent.hasQueuedMessages() &&
			this.session.pendingMessageCount === 0
		);
	}
	/** The callback may mutate durable state, but must not start host operations or wait for new input. */
	async atIdle<T>(run: () => Promise<T>): Promise<PiBoundaryResult<T>> {
		this.assertActive();
		if (this.barrier || !this.idle()) return { kind: "busy" };
		let release!: () => void;
		this.barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const frame: Frame = { kind: "boundary", active: true };
		try {
			const value = await this.frames.run(frame, run);
			this.assertActive();
			return { kind: "idle", value };
		} finally {
			frame.active = false;
			this.barrier = undefined;
			release();
		}
	}
	/** Reconcile one expected attempt only after native execution and post-run work are inactive. */
	reconcile(ledger: FlowReceiptLedger, attemptId: string): Promise<PiBoundaryResult<PiSettlement>> {
		return this.atIdle(async () => {
			if (this.navigated) throw new FlowLedgerError("scope", "Branch navigation requires a new settlement attachment.");
			if (ledger.scope.sessionId !== this.sessionId)
				throw new FlowLedgerError("scope", "Settlement belongs to another session.");
			const state = await ledger.snapshot();
			if (state.generation !== ledger.generation)
				throw new FlowLedgerError("stale", "Settlement attachment was replaced.");
			if (state.activeAttemptId !== attemptId) return { kind: "inactive" };
			const attempt = state.attempts.find((item) => item.id === attemptId);
			if (!attempt) throw new FlowLedgerError("identity", "Settlement attempt is missing.");
			if (attempt.phase === "selected" || attempt.phase === "queued") return { kind: "waiting", attemptId };
			if (attempt.phase === "claimed" || attempt.phase === "prepared") {
				await ledger.cancel(attemptId, "Host became idle before transport handoff.");
				return { kind: "cancelled", attemptId };
			}
			if (attempt.phase === "handed-off") {
				await ledger.uncertain(attemptId, "Host is inactive but the provider outcome is unknown.");
				return { kind: "uncertain", attemptId };
			}
			if (attempt.phase !== "running")
				throw new FlowLedgerError("transition", "Attempt cannot settle at this boundary.");
			const last = this.session.messages
				.slice()
				.reverse()
				.find((message) => message.role === "assistant");
			if (!last || !["stop", "length", "toolUse", "error", "aborted"].includes(last.stopReason))
				throw new FlowLedgerError("transition", "Host has no terminal assistant outcome.");
			const outcome: FlowOutcome =
				last.stopReason === "aborted"
					? "aborted"
					: last.stopReason === "error" || attempt.reason
						? "failure"
						: "success";
			await ledger.settle(attemptId, outcome);
			return { kind: "settled", attemptId };
		});
	}
	close(): void {
		this.closed = true;
	}
}
