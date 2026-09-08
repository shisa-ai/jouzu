import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PiHostHooks } from "./pi-host-hooks.js";
import { FlowLedgerError, type FlowOutcome, type FlowReceiptLedger } from "./receipt-ledger.js";

interface Frame {
	kind: "operation" | "navigation" | "boundary";
	active: boolean;
}
export type PiBoundaryResult<T> = { kind: "busy" } | { kind: "idle"; value: T };
export type PiSettlement = { kind: "inactive" | "waiting" | "cancelled" | "uncertain" | "settled"; attemptId?: string };

/** Serialize idle reconciliation with supported Pi execution and context-changing entry points. */
export class PiHostBoundary {
	private readonly hooks = new PiHostHooks();
	private readonly frames = new AsyncLocalStorage<Frame>();
	private active = 0;
	private closed = false;
	private stopping = false;
	private stoppingPromise?: Promise<void>;
	private drained?: () => void;
	private navigated = false;
	private navigationReleased = false;
	private barrier?: Promise<void>;
	private readonly sessionId: string;
	constructor(private readonly session: AgentSession) {
		this.sessionId = session.sessionId;
		const agent = session.agent;
		const prompt = agent.prompt.bind(agent);
		this.hooks.set(agent, "prompt", (input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) =>
			this.operation(() => (typeof input === "string" ? prompt(input, images) : prompt(input))),
		);
		this.hooks.set(agent, "continue", this.wrap(agent.continue.bind(agent)));
		this.hooks.set(agent, "continueQueued", this.wrap(agent.continueQueued.bind(agent)));
		this.hooks.set(session, "prompt", this.wrap(session.prompt.bind(session)));
		this.hooks.set(session, "continueQueued", this.wrap(session.continueQueued.bind(session)));
		this.hooks.set(session, "steer", this.wrap(session.steer.bind(session)));
		this.hooks.set(session, "followUp", this.wrap(session.followUp.bind(session)));
		this.hooks.set(session, "sendUserMessage", this.wrap(session.sendUserMessage.bind(session)));
		this.hooks.set(session, "sendCustomMessage", this.wrap(session.sendCustomMessage.bind(session)));
		this.hooks.set(session, "compact", this.wrap(session.compact.bind(session)));
		const navigate = session.navigateTree.bind(session);
		this.hooks.set(
			session,
			"navigateTree",
			this.wrap(async (...args: Parameters<AgentSession["navigateTree"]>) => {
				const leaf = session.sessionManager.getLeafId();
				try {
					return await navigate(...args);
				} finally {
					if (session.sessionManager.getLeafId() !== leaf) this.navigated = true;
				}
			}, "navigation"),
		);
		for (const name of ["steer", "followUp"] as const) {
			const enqueue = agent[name].bind(agent);
			this.hooks.set(agent, name, (message) => {
				this.assertWritable();
				if (this.barrier) throw new FlowLedgerError("busy", "Native queue mutation must wait for idle reconciliation.");
				return enqueue(message);
			});
		}
		for (const name of ["editQueuedMessage", "cancelQueuedMessage"] as const) {
			const change = agent[name].bind(agent);
			this.hooks.set(agent, name, ((...args: Parameters<typeof change>) => {
				if (name === "editQueuedMessage") this.assertWritable();
				else this.assertActive();
				if (this.barrier && !(this.frames.getStore()?.active && this.frames.getStore()?.kind === "boundary"))
					throw new FlowLedgerError("busy", "Native queue mutation must wait for reconciliation.");
				return (change as (...args: Parameters<typeof change>) => ReturnType<typeof change>)(...args);
			}) as (typeof agent)[typeof name]);
		}
		this.hooks.set(session, "setModel", this.wrap(session.setModel.bind(session)));
		this.hooks.set(session, "cycleModel", this.wrap(session.cycleModel.bind(session)));
	}
	private wrap<A extends unknown[], R>(
		fn: (...args: A) => Promise<R>,
		kind: "operation" | "navigation" = "operation",
	): (...args: A) => Promise<R> {
		return (...args) => this.operation(() => fn(...args), kind);
	}
	private assertActive(): void {
		if (this.closed || this.session.sessionId !== this.sessionId)
			throw new FlowLedgerError("stale", "Host boundary is closed or its session was replaced.");
	}
	private assertWritable(): void {
		this.assertActive();
		if (this.stopping) throw new FlowLedgerError("stale", "Host boundary is stopping.");
	}
	private notifyDrained(): void {
		if (this.active === 0 && !this.barrier) {
			if (this.closed) this.hooks.close();
			this.drained?.();
		}
	}
	/** Call only from ingress beforeBranchChange, after Pi has finished preparing navigation. */
	handoffNavigation(): void {
		this.assertWritable();
		const frame = this.frames.getStore();
		if (
			frame?.kind !== "navigation" ||
			!frame.active ||
			this.active !== 1 ||
			this.barrier ||
			!this.session.isIdle ||
			this.session.agent.state.isStreaming ||
			this.session.isRetrying ||
			this.session.isCompacting ||
			this.session.agent.hasQueuedMessages() ||
			this.session.pendingMessageCount
		)
			throw new FlowLedgerError(
				"busy",
				"Navigation handoff requires prepared navigation with no other active host work.",
			);
		this.stopping = true;
		this.navigationReleased = true;
		frame.active = false;
		this.active--;
		this.notifyDrained();
	}
	/** Fence new host writes, abort native execution, and join preflight and idle transactions. */
	abortAndJoin(): Promise<void> {
		if (this.frames.getStore()?.active)
			return Promise.reject(new FlowLedgerError("busy", "Host shutdown cannot join its own active callback."));
		this.stopping = true;
		this.stoppingPromise ??= (async () => {
			try {
				if (!this.navigationReleased) await this.session.abort();
			} finally {
				if (this.active || this.barrier)
					await new Promise<void>((resolve) => {
						this.drained = resolve;
					});
				this.drained = undefined;
			}
		})();
		return this.stoppingPromise;
	}
	private async operation<T>(run: () => Promise<T>, kind: "operation" | "navigation" = "operation"): Promise<T> {
		this.assertWritable();
		const parent = this.frames.getStore();
		if (parent?.kind === "boundary")
			throw new FlowLedgerError("busy", "Idle reconciliation cannot start a host operation.");
		if (parent?.active) {
			this.active++;
			try {
				return await run();
			} finally {
				this.active--;
				this.notifyDrained();
			}
		}
		while (this.barrier) await this.barrier;
		this.assertWritable();
		const frame: Frame = { kind, active: true };
		this.active++;
		try {
			return await this.frames.run(frame, run);
		} finally {
			if (frame.active) {
				frame.active = false;
				this.active--;
			}
			this.notifyDrained();
		}
	}
	private idle(allowQueued = false): boolean {
		return (
			this.active === 0 &&
			this.session.isIdle &&
			!this.session.agent.state.isStreaming &&
			!this.session.isRetrying &&
			!this.session.isCompacting &&
			(allowQueued || (!this.session.agent.hasQueuedMessages() && this.session.pendingMessageCount === 0))
		);
	}
	assertAttachedBranch(): void {
		this.assertActive();
		if (this.navigated) throw new FlowLedgerError("scope", "Branch navigation requires a new flow attachment.");
	}
	/** The callback may mutate durable state, but must not start host operations or wait for new input. */
	atIdle<T>(run: () => Promise<T>): Promise<PiBoundaryResult<T>> {
		return this.atRest(run, false);
	}
	/** Reconcile native queue records while host execution and queue mutation are fenced. */
	atQueueMaintenance<T>(run: () => Promise<T>): Promise<PiBoundaryResult<T>> {
		return this.atRest(run, true);
	}
	private async atRest<T>(run: () => Promise<T>, allowQueued: boolean): Promise<PiBoundaryResult<T>> {
		this.assertActive();
		if (this.barrier || !this.idle(allowQueued)) return { kind: "busy" };
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
			this.notifyDrained();
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
		this.notifyDrained();
	}
}
