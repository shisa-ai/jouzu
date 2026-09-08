import { AsyncLocalStorage } from "node:async_hooks";
import type { Agent, AgentMessage, FlowQueueClaim, FlowQueuedMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { PiHostHooks } from "./pi-host-hooks.js";
import { FlowLedgerError, type FlowReceiptLedger } from "./receipt-ledger.js";

interface Dispatch {
	attemptId: string;
	active: boolean;
	item?: { id: string; revision: number };
	queued?: Promise<void>;
}

/** Joins controller-selected attempts to native queue removal; does not select or execute work. */
export class PiQueueReceipts {
	private readonly hooks = new PiHostHooks();
	private readonly dispatches = new AsyncLocalStorage<Dispatch>();
	private readonly items = new Map<string, Dispatch>();
	private closed = false;

	constructor(
		private readonly agent: Agent,
		private readonly ledger: FlowReceiptLedger,
	) {
		for (const method of ["steer", "followUp"] as const) {
			const native = agent[method].bind(agent);
			this.hooks.set(agent, method, (message) => {
				const dispatch = this.dispatches.getStore();
				if (!dispatch) return native(message);
				if (!dispatch.active) throw new FlowLedgerError("stale", "Native enqueue outlived its dispatch permit.");
				this.assertActive();
				if (dispatch.item) throw new FlowLedgerError("identity", "One flow attempt must enqueue one composed item.");
				const item = native(message);
				dispatch.item = item;
				this.items.set(item.id, dispatch);
				dispatch.queued = ledger.queued(dispatch.attemptId, item);
				dispatch.queued.catch(() => {
					agent.cancelQueuedMessage(item.id, item.revision);
				});
				return item;
			});
		}
		const prompt = agent.prompt.bind(agent);
		this.hooks.set(agent, "prompt", (input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) => {
			if (this.dispatches.getStore())
				throw new FlowLedgerError("identity", "Queue dispatch cannot start a direct native run.");
			return typeof input === "string" ? prompt(input, images) : prompt(input);
		});
		const continueRun = agent.continue.bind(agent);
		this.hooks.set(agent, "continue", (...args) => {
			if (this.dispatches.getStore())
				throw new FlowLedgerError("identity", "Queue dispatch cannot start a direct native run.");
			return continueRun(...args);
		});
		const continueQueued = agent.continueQueued.bind(agent);
		this.hooks.set(agent, "continueQueued", () => {
			if (this.dispatches.getStore())
				throw new FlowLedgerError("identity", "Queue dispatch cannot start a direct native run.");
			return continueQueued();
		});
		const previous = agent.flowCheckpoints;
		this.hooks.set(agent, "flowCheckpoints", {
			...previous,
			beforeQueueClaim: async (items, signal) => {
				this.assertActive();
				for (const item of items) {
					const dispatch = this.items.get(item.id);
					if (dispatch && item.revision !== dispatch.item?.revision)
						throw new FlowLedgerError("stale", "Edited automated input requires a new controller reservation.");
					await dispatch?.queued;
				}
				const accepted = previous?.beforeQueueClaim ? await previous.beforeQueueClaim(items, signal) : true;
				this.assertActive();
				return accepted;
			},
			afterQueueClaim: async (receipt, signal) => {
				this.assertActive();
				await this.recordClaim(receipt);
				await previous?.afterQueueClaim?.(receipt, signal);
				this.assertActive();
			},
		});
	}

	private assertActive(): void {
		if (this.closed) throw new FlowLedgerError("stale", "Queue receipt attachment is closed.");
	}

	/** The selected ledger attempt must exist before native enqueue. */
	async enqueue(attemptId: string, dispatch: () => void | Promise<void>): Promise<{ id: string; revision: number }> {
		this.assertActive();
		const state = await this.ledger.snapshot();
		const attempt = state.attempts.find((item) => item.id === attemptId);
		if (
			state.activeAttemptId !== attemptId ||
			attempt?.phase !== "selected" ||
			attempt.generation !== this.ledger.generation
		)
			throw new FlowLedgerError("transition", "Queue dispatch requires the selected attempt.");
		this.assertActive();
		const frame: Dispatch = { attemptId, active: true };
		try {
			await this.dispatches.run(frame, dispatch);
			await frame.queued;
			if (!frame.item) throw new FlowLedgerError("identity", "Dispatch did not enqueue a native item.");
			return { ...frame.item };
		} catch (error) {
			if (frame.item) this.agent.cancelQueuedMessage(frame.item.id, frame.item.revision);
			await frame.queued?.catch(() => {});
			throw error;
		} finally {
			frame.active = false;
		}
	}

	private async recordClaim({ candidates, claimed }: FlowQueueClaim): Promise<void> {
		for (const item of candidates) {
			const dispatch = this.items.get(item.id);
			if (!dispatch) continue;
			await dispatch.queued;
			if (claimed.some((actual: FlowQueuedMessage) => actual.id === item.id && actual.revision === item.revision)) {
				await this.ledger.claim(dispatch.attemptId, item);
			} else {
				await this.ledger.cancel(dispatch.attemptId, "Native queue item changed before consumption.");
			}
			if (!this.agent.inspectQueuedMessages().some((pending) => pending.id === item.id)) this.items.delete(item.id);
		}
	}

	close(): void {
		this.closed = true;
		this.hooks.close();
	}
}
