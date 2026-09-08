import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT, type Session, type SessionReader, setValue, value } from "@earendil-works/pi-agent-core";
import type { FlowOwnership } from "./ownership.js";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";
import { type FlowWaitClock, FlowWaitDeadlines, systemWaitClock } from "./wait-deadlines.js";
import {
	cancelFlowWait,
	createFlowWait,
	expireFlowWait,
	type FlowWaitObservation,
	type FlowWaitState,
	reconcileFlowWait,
} from "./wait-state.js";

type Declaration = Parameters<typeof createFlowWait>[0];
interface State {
	version: 1;
	scope: FlowScope;
	waits: FlowWaitState[];
}
const address = value<State>("jouzu.flow.waits", "v1");

function validateWait(wait: FlowWaitState): void {
	const { token, scope, workId, reason, mode, on, expiresAt, createdAt } = wait;
	const pending = wait.observations.map((item) => ({ ...item, state: "pending" as const }));
	const initial = createFlowWait(
		{ token, scope, workId, reason, mode, on, expiresAt },
		pending,
		createdAt,
		Number.MAX_SAFE_INTEGER,
	);
	let expected: FlowWaitState;
	if (wait.state === "cancelled") {
		const observed = reconcileFlowWait(initial, wait.observations, createdAt);
		expected = cancelFlowWait(observed, wait.cancellationReason ?? "", wait.endedAt ?? -1);
	} else {
		expected = reconcileFlowWait(
			initial,
			wait.observations,
			wait.state === "waiting" ? createdAt : (wait.endedAt ?? -1),
		);
	}
	if (!isDeepStrictEqual(wait, expected)) throw new FlowLedgerError("schema", "Invalid retained wait state.");
}

/** Atomic wait transitions under the existing branch writer lease; no producer callbacks run in a transaction. */
export class FlowWaitStore {
	private initialized = false;
	private deadlines?: FlowWaitDeadlines;
	private schedulingClosed = false;

	async startDeadlines(onError: (error: unknown) => void, clock: FlowWaitClock = systemWaitClock): Promise<void> {
		this.ownership.assertActive();
		if (this.schedulingClosed) throw new FlowLedgerError("transition", "Wait deadline scheduling is closed.");
		if (this.deadlines) throw new FlowLedgerError("transition", "Wait deadlines are already scheduled.");
		const deadlines = new FlowWaitDeadlines(this, clock, onError);
		this.deadlines = deadlines;
		try {
			await deadlines.refresh();
		} catch (error) {
			await deadlines.stop().catch(() => undefined);
			if (this.deadlines === deadlines) this.deadlines = undefined;
			throw error;
		}
	}

	async stopDeadlines(): Promise<void> {
		this.schedulingClosed = true;
		const deadlines = this.deadlines;
		this.deadlines = undefined;
		await deadlines?.stop();
	}
	private constructor(
		private readonly session: Session,
		private readonly ownership: FlowOwnership,
	) {}
	static async attach(session: Session, ownership: FlowOwnership): Promise<FlowWaitStore> {
		const store = new FlowWaitStore(session, ownership);
		await store.update(() => undefined);
		store.initialized = true;
		return store;
	}
	private validate(state: State): void {
		if (
			state.version !== 1 ||
			!isDeepStrictEqual(state.scope, this.ownership.scope) ||
			!Array.isArray(state.waits) ||
			state.waits.length > 128 ||
			Buffer.byteLength(JSON.stringify(state)) > 4 * 1024 * 1024
		)
			throw new FlowLedgerError("schema", "Invalid wait storage scope or capacity.");
		const tokens = new Set<string>(),
			work = new Set<string>();
		for (const wait of state.waits) {
			validateWait(wait);
			if (
				!isDeepStrictEqual(wait.scope, state.scope) ||
				tokens.has(wait.token) ||
				(wait.state === "waiting" && work.has(wait.workId))
			)
				throw new FlowLedgerError("identity", "Wait storage contains duplicate or foreign ownership.");
			tokens.add(wait.token);
			if (wait.state === "waiting") work.add(wait.workId);
		}
	}
	private async read(reader: SessionReader): Promise<State> {
		const saved = (await reader.getValue(address, BACKGROUND_CONTEXT))?.value;
		if (!saved && this.initialized) throw new FlowLedgerError("schema", "Wait storage is missing.");
		const state = saved ?? { version: 1, scope: this.ownership.scope, waits: [] };
		this.validate(state);
		return structuredClone(state);
	}
	private async update<T>(change: (state: State) => T): Promise<T> {
		let changed = false;
		const result = await this.ownership.run(() =>
			this.session.mutate(async (mutation, context) => {
				const state = await this.read(mutation);
				const before = structuredClone(state);
				const result = change(state);
				changed = !isDeepStrictEqual(before, state);
				this.validate(state);
				if (changed || !this.initialized) await mutation.commit([setValue(address, state)], context);
				return structuredClone(result);
			}, BACKGROUND_CONTEXT),
		);
		if (changed) this.deadlines?.changed();
		return result;
	}
	snapshot(): Promise<FlowWaitState[]> {
		return this.ownership.run(() =>
			this.session.mutate(async (reader) => (await this.read(reader)).waits, BACKGROUND_CONTEXT),
		);
	}
	declare(
		request: Declaration,
		observations: FlowWaitObservation[],
		now: number,
		maxDurationMs: number,
		replaceToken?: string,
	): Promise<FlowWaitState> {
		const captured = structuredClone({ request, observations });
		return this.update((state) => {
			const next = createFlowWait(captured.request, captured.observations, now, maxDurationMs);
			if (state.waits.some((wait) => wait.token === next.token))
				throw new FlowLedgerError("identity", "Wait token is already registered.");
			const active = state.waits.find((wait) => wait.workId === next.workId && wait.state === "waiting");
			if (replaceToken !== undefined && (!active || active.token !== replaceToken))
				throw new FlowLedgerError("stale", "Wait replacement requires the active token.");
			if (active && replaceToken === undefined)
				throw new FlowLedgerError("transition", "Work already has a live wait.");
			if (active) state.waits[state.waits.indexOf(active)] = cancelFlowWait(active, "Replaced by a new wait.", now);
			state.waits.push(next);
			return next;
		});
	}
	/** Atomically retain every newly detected expiry, including deadlines elapsed while offline. */
	expireDue(now: number): Promise<FlowWaitState[]> {
		if (!Number.isSafeInteger(now) || now < 0)
			return Promise.reject(new FlowLedgerError("schema", "Invalid wait expiry time."));
		return this.update((state) => {
			const expired: FlowWaitState[] = [];
			state.waits = state.waits.map((wait) => {
				if (wait.state !== "waiting" || now < wait.expiresAt) return wait;
				const next = expireFlowWait(wait, now);
				expired.push(next);
				return next;
			});
			return expired;
		});
	}

	reconcile(token: string, observations: FlowWaitObservation[], now: number): Promise<FlowWaitState> {
		const captured = structuredClone(observations);
		return this.transition(token, (wait) => reconcileFlowWait(wait, captured, now));
	}
	cancel(token: string, reason: string, now: number): Promise<FlowWaitState> {
		return this.transition(token, (wait) => cancelFlowWait(wait, reason, now));
	}
	private transition(token: string, change: (wait: FlowWaitState) => FlowWaitState): Promise<FlowWaitState> {
		return this.update((state) => {
			const index = state.waits.findIndex((wait) => wait.token === token);
			if (index < 0) throw new FlowLedgerError("stale", "Wait token is not registered.");
			state.waits[index] = change(state.waits[index]);
			return state.waits[index];
		});
	}
}
