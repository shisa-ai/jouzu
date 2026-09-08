import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { NativeRequestSource } from "./native-request-store.js";
import { PiHostHooks } from "./pi-host-hooks.js";
import { PiNativeHistory } from "./pi-native-history.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type {
	FlowNativeInput,
	FlowNativeObserver,
	FlowSubmissionStore,
	RetainedSubmission,
} from "./submission-store.js";

interface Frame {
	active: boolean;
	operationId: string;
	observer: FlowNativeObserver;
	writes: Promise<unknown>[];
}
const attached = new WeakSet<AgentSession>();

/** Observe native input inside one retained dispatch, without rerunning prompt normalization. */
export class PiNativeDispatch {
	private readonly hooks = new PiHostHooks();
	private readonly frames = new AsyncLocalStorage<Frame>();
	private readonly queued = new Map<string, { operationId: string; revision: number; write: Promise<unknown> }>();
	private readonly held = new Map<string, { id: string; revision: number; reason: string }>();
	private readonly sessionId: string;
	private active = 0;
	private closed = false;
	private drained?: () => void;
	private closing?: Promise<void>;
	private readonly history: PiNativeHistory;
	constructor(
		private readonly session: AgentSession,
		private readonly store: FlowSubmissionStore,
		private readonly admitQueued?: (record: RetainedSubmission, input: FlowNativeInput) => Promise<boolean>,
	) {
		if (session.sessionId !== store.scope.sessionId)
			throw new FlowLedgerError("scope", "Native observation requires matching session storage.");
		if (attached.has(session))
			throw new FlowLedgerError("identity", "Pi session already has native dispatch observation.");
		attached.add(session);
		this.sessionId = session.sessionId;
		this.history = new PiNativeHistory(session, store);
		const agent = session.agent;
		const prompt = agent.prompt.bind(agent);
		this.hooks.set(agent, "prompt", async (input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) => {
			const frame = this.frame();
			if (!frame) return typeof input === "string" ? prompt(input, images) : prompt(input);
			const [captured, capturedImages] = structuredClone([input, images] as const);
			const inputIndex = await frame.observer.observe({ kind: "prompt", args: [captured, capturedImages] });
			this.frame();
			// Let Pi reject concurrent execution without attaching input to the running prompt.
			if (agent.state.isStreaming)
				return typeof captured === "string" ? prompt(captured, capturedImages) : prompt(captured);
			const release = this.history.observePrompt(frame.operationId, inputIndex, captured, capturedImages);
			try {
				return await (typeof captured === "string" ? prompt(captured, capturedImages) : prompt(captured));
			} finally {
				release();
			}
		});
		for (const kind of ["steer", "followUp"] as const) {
			const enqueue = agent[kind].bind(agent);
			this.hooks.set(agent, kind, (message) => {
				const frame = this.frame();
				if (!frame) return enqueue(message);
				const args = structuredClone([message]);
				const queue = enqueue(structuredClone(message));
				let write: Promise<unknown>;
				try {
					write = frame.observer.observe({ kind, args, queue });
				} catch (error) {
					agent.cancelQueuedMessage(queue.id, queue.revision);
					throw error;
				}
				this.queued.set(queue.id, { operationId: frame.operationId, revision: queue.revision, write });
				write.catch(() => agent.cancelQueuedMessage(queue.id, queue.revision));
				frame.writes.push(write);
				return queue;
			});
		}
		const previous = agent.flowCheckpoints;
		this.hooks.set(agent, "flowCheckpoints", {
			...previous,
			beforeQueueClaim: async (items, signal) => {
				this.assertActive();
				let edited = false;
				await Promise.all(
					items.map((item) => {
						const observation = this.queued.get(item.id);
						if (observation && observation.revision !== item.revision) {
							edited = true;
							this.held.set(item.id, {
								id: item.id,
								revision: item.revision,
								reason: "Edited native input requires a new observation.",
							});
						}
						return observation?.write.catch(() => {
							edited = true;
							this.held.set(item.id, {
								id: item.id,
								revision: item.revision,
								reason: "Native input observation could not be retained.",
							});
						});
					}),
				);
				if (edited) return false;
				const accepted = previous?.beforeQueueClaim ? await previous.beforeQueueClaim(items, signal) : true;
				this.assertActive();
				if (!accepted) return false;
				const records = await this.store.snapshot();
				const selected = new Map<string, number>();
				for (const item of items) {
					const observed = this.queued.get(item.id);
					if (!observed) continue;
					const record = records.find((record) => record.dispatch?.operationId === observed.operationId);
					const input = record?.dispatch?.inputs?.find(
						(input) => input.queue?.id === item.id && input.queue.revision === item.revision,
					);
					if (record?.status !== "retained" || !input) return false;
					if (this.admitQueued) {
						let allowed: boolean;
						try {
							allowed = await this.admitQueued(structuredClone(record), structuredClone(input));
						} catch {
							this.assertActive();
							signal?.throwIfAborted();
							this.held.set(item.id, {
								id: item.id,
								revision: item.revision,
								reason: "Queue admission could not complete.",
							});
							return false;
						}
						if (!allowed) {
							this.held.set(item.id, {
								id: item.id,
								revision: item.revision,
								reason: "Queued input is held by session policy.",
							});
							return false;
						}
						this.held.delete(item.id);
					}
					selected.set(record.id, record.revision);
				}
				const current = await this.store.snapshot();
				this.assertActive();
				signal?.throwIfAborted();
				return [...selected].every(([id, revision]) =>
					current.some((record) => record.id === id && record.revision === revision && record.status === "retained"),
				);
			},
			afterQueueClaim: async (receipt, signal) => {
				this.assertActive();
				for (const item of receipt.candidates) {
					const observed = this.queued.get(item.id);
					if (!observed) continue;
					await observed.write;
					await this.store.recordQueueClaim(
						observed.operationId,
						{ id: item.id, revision: item.revision },
						receipt.claimed.some((claimed) => claimed.id === item.id && claimed.revision === item.revision),
					);
				}
				await previous?.afterQueueClaim?.(receipt, signal);
				const records = await this.store.snapshot();
				this.assertActive();
				for (const item of receipt.claimed) {
					const observed = this.queued.get(item.id);
					if (
						observed &&
						!records.some(
							(record) => record.dispatch?.operationId === observed.operationId && record.status === "retained",
						)
					)
						throw new FlowLedgerError("stale", "Native input was cancelled during queue consumption.");
				}
				this.history.accept(
					receipt.claimed.map((item) => ({
						...item,
						operationId: this.queued.get(item.id)?.operationId,
					})),
				);
				for (const item of receipt.candidates)
					if (!agent.inspectQueuedMessages().some((queued) => queued.id === item.id)) this.queued.delete(item.id);
			},
		});
	}
	private assertActive(): void {
		if (this.closed || this.session.sessionId !== this.sessionId)
			throw new FlowLedgerError("stale", "Native dispatch observation is closed or replaced.");
	}
	async consumedSources() {
		this.assertActive();
		const records = await this.store.snapshot();
		this.assertActive();
		return records.flatMap(({ dispatch }) =>
			dispatch
				? [
						...(dispatch.promptClaims ?? []).map((prompt) => ({ operationId: dispatch.operationId, prompt })),
						...(dispatch.queueClaims ?? [])
							.filter((claim) => claim.consumed)
							.map(({ id, revision }) => ({ operationId: dispatch.operationId, queue: { id, revision } })),
					]
				: [],
		);
	}
	async sources(messages: AgentMessage[]): Promise<NativeRequestSource[]> {
		this.assertActive();
		const members = this.history.identify(messages);
		await this.history.validateSources(members, this.store);
		this.assertActive();
		return members;
	}
	async recoverSources(): Promise<{ recovered: number; unresolved: number }> {
		this.assertActive();
		if (this.active) throw new FlowLedgerError("busy", "Native source recovery requires drained dispatch.");
		this.active++;
		try {
			return await this.history.recover(this.session, this.store, () => this.assertActive());
		} finally {
			this.active--;
			if (!this.active) this.drained?.();
		}
	}
	/** Re-observe the reviewed live revision without replacing Pi's queue entry or appending history. */
	async reconcileQueueEdit(id: string, revision: number): Promise<void> {
		this.assertActive();
		const item = this.session.agent
			.inspectQueuedMessages()
			.find((item) => item.id === id && item.revision === revision);
		const observed = this.queued.get(id);
		if (!item || !observed) throw new FlowLedgerError("stale", "Native edit has no matching live queue observation.");
		if (revision === observed.revision) return;
		this.active++;
		try {
			await observed.write;
			await this.store.recordQueueEdit(
				observed.operationId,
				{ id, revision: observed.revision },
				{
					kind: item.lane,
					args: [item.message],
					queue: { id, revision },
				},
			);
			this.assertActive();
			if (this.queued.get(id) !== observed)
				throw new FlowLedgerError("stale", "Native edit observation changed during reconciliation.");
			this.queued.set(id, { operationId: observed.operationId, revision, write: Promise.resolve() });
			if (
				!this.session.agent
					.inspectQueuedMessages()
					.some((current) => current.id === id && current.revision === revision)
			)
				throw new FlowLedgerError("stale", "Native queue changed while its edit was retained.");
			this.held.delete(id);
		} finally {
			this.active--;
			if (!this.active) this.drained?.();
		}
	}
	heldInputs(): { id: string; revision: number; reason: string }[] {
		const queued = this.session.agent.inspectQueuedMessages();
		for (const id of this.held.keys()) if (!queued.some((item) => item.id === id)) this.held.delete(id);
		return structuredClone([...this.held.values()]);
	}
	private frame(): Frame | undefined {
		this.assertActive();
		const frame = this.frames.getStore();
		if (frame && !frame.active) throw new FlowLedgerError("stale", "Native input outlived its dispatch.");
		return frame;
	}
	dispatch<T>(id: string, revision: number, operationId: string, run: () => Promise<T>): Promise<T> {
		this.assertActive();
		const pending = this.session.agent.inspectQueuedMessages();
		for (const id of this.queued.keys()) if (!pending.some((item) => item.id === id)) this.queued.delete(id);
		this.active++;
		return this.store
			.dispatch(id, revision, operationId, (observer) => {
				const frame: Frame = { active: true, operationId, observer, writes: [] };
				return this.frames.run(frame, async () => {
					try {
						const result = await run();
						frame.active = false;
						await Promise.all(frame.writes);
						return result;
					} finally {
						frame.active = false;
						await Promise.allSettled(frame.writes);
					}
				});
			})
			.finally(() => {
				this.active--;
				if (!this.active) this.drained?.();
			});
	}
	/** Call after native execution is aborted/joined; drain receipts before releasing owned hooks. */
	close(): Promise<void> {
		if (this.frames.getStore()?.active)
			return Promise.reject(new FlowLedgerError("busy", "Native dispatch cannot join its own close."));
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = (
			this.active
				? new Promise<void>((resolve) => {
						this.drained = resolve;
					})
				: Promise.resolve()
		).then(async () => {
			const pending = this.session.agent.inspectQueuedMessages().filter((item) => this.queued.has(item.id));
			for (const item of pending) {
				const observed = this.queued.get(item.id);
				if (!observed) throw new FlowLedgerError("stale", "Native queue observation changed during close.");
				if (item.revision !== observed.revision) {
					await observed.write;
					await this.store.recordQueueEdit(
						observed.operationId,
						{ id: item.id, revision: observed.revision },
						{
							kind: item.lane,
							args: [item.message],
							queue: { id: item.id, revision: item.revision },
						},
					);
				}
				const result = this.session.agent.cancelQueuedMessage(item.id, item.revision);
				if (result.kind !== "cancelled") throw new FlowLedgerError("stale", "Native queue changed during close.");
				await this.store.recordQueueClaim(observed.operationId, { id: item.id, revision: item.revision }, false);
			}
			this.hooks.close();
			this.history.close();
			this.queued.clear();
			this.held.clear();
			attached.delete(this.session);
		});
		return this.closing;
	}
}
