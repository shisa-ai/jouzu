import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT, type Session, type SessionReader, setValue, value } from "@earendil-works/pi-agent-core";
import type { FlowOwnership } from "./ownership.js";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";
import { MAX_RETIRED_FLOW_IDENTITIES, retiredIdentityHash, validRetiredIdentityHash } from "./retired-identities.js";
import {
	authorityObservations,
	captureWorkBinding,
	changeAuthorityWork,
	emptyWaitAuthority,
	type FlowAuthorityExecution,
	type FlowAuthorityWork,
	type FlowWaitAuthority,
	type FlowWorkBinding,
	type FlowWorkStatus,
	findLiveBoundWork,
	migrateWaitAuthority,
	observeAuthorityExecution,
	registerAuthorityExecution,
	registerAuthorityWork,
	requireAuthorityWork,
	requireOpenAuthorityWork,
	shareAuthorityWork,
	validateWaitAuthority,
} from "./wait-authority.js";
import { type FlowWaitClock, FlowWaitDeadlines, systemWaitClock } from "./wait-deadlines.js";
import {
	cancelFlowWait,
	createFlowWait,
	expireFlowWait,
	type FlowWaitObservation,
	type FlowWaitState,
	reconcileFlowWait,
} from "./wait-state.js";

import { type FlowWaitToolReceipt, waitToolContentHash, waitToolResponse } from "./wait-tool-response.js";

export interface FlowWaitRetirement {
	/** Exact terminal snapshots whose decision has been observed; cancellation needs no decision receipt. */
	waits: FlowWaitState[];
	/** Terminal executions whose producer output is safe to retire. */
	executions: FlowAuthorityExecution[];
	/** Completed/stopped work, after its executions and waits are retired. */
	work: FlowAuthorityWork[];
	/** User input proven handled by the idle host, with no remaining producer obligation. */
	finishedUserWork?: FlowAuthorityWork[];
}
interface RetiredIdentities {
	work: string[];
	executions: string[];
	waits: string[];
}

type Declaration = Parameters<typeof createFlowWait>[0];
interface State {
	version: 1;
	scope: FlowScope;
	waits: FlowWaitState[];
	authority?: FlowWaitAuthority;
	toolReceipts?: FlowWaitToolReceipt[];
	retired?: RetiredIdentities;
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
	private waitingWorkIds: string[] = [];
	private inactiveWorkIds: string[] = [];
	private retiredWorkHashes: string[] = [];
	private work: FlowAuthorityWork[] = [];
	private mutations = 0;
	private readonly listeners = new Set<{ changed(): void; onError(error: unknown): void }>();

	/** Notifications follow committed changes; unsubscribe suppresses callbacks already queued. */
	onChanged(changed: () => void, onError: (error: unknown) => void): () => void {
		this.ownership.assertActive();
		const listener = { changed, onError };
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private notifyChanged(): void {
		for (const listener of this.listeners)
			queueMicrotask(() => {
				if (!this.listeners.has(listener)) return;
				try {
					listener.changed();
				} catch (error) {
					listener.onError(error);
				}
			});
	}

	/** Synchronous admission view, published only after a successful durable commit. */
	gate(): { waitingWorkIds: string[]; inactiveWorkIds: string[]; retiredWorkHashes?: string[]; updating: boolean } {
		this.ownership.assertActive();
		return {
			waitingWorkIds: [...this.waitingWorkIds],
			inactiveWorkIds: [...this.inactiveWorkIds],
			...(this.retiredWorkHashes.length ? { retiredWorkHashes: [...this.retiredWorkHashes] } : {}),
			updating: !this.initialized || this.mutations > 0,
		};
	}
	/** Capture ownership synchronously immediately before a producer starts an execution. */
	captureExecutionWork(id: string, revision: number, producer: string): { id: string; revision: number } {
		this.ownership.assertActive();
		if (!this.initialized || this.mutations > 0) throw new FlowLedgerError("busy", "Work ownership is changing.");
		const work = requireAuthorityWork(
			{ version: 1, work: this.work, executions: [], waitTokens: [] },
			id,
			producer,
			revision,
		);
		if ((work.lifecycle?.state ?? "active") !== "active")
			throw new FlowLedgerError("transition", "Inactive work cannot start another execution.");
		return { id: work.id, revision: work.revision };
	}
	private deadlines?: FlowWaitDeadlines;
	private schedulingClosed = false;
	/** Set when a read migrated persisted lane records; the next update commits the rewrite. */
	private legacyBindings = false;

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
		this.listeners.clear();
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
		if (state.retired !== undefined) {
			const retired = state.retired;
			if (!retired || typeof retired !== "object")
				throw new FlowLedgerError("schema", "Invalid retired identity index.");
			const groups = [retired.work, retired.executions, retired.waits];
			if (
				groups.some(
					(group) =>
						!Array.isArray(group) ||
						group.some((id) => !validRetiredIdentityHash(id)) ||
						new Set(group).size !== group.length,
				) ||
				groups.reduce((count, group) => count + group.length, 0) > MAX_RETIRED_FLOW_IDENTITIES
			)
				throw new FlowLedgerError("capacity", "Invalid retired identity index or capacity.");
			if (
				state.waits.some((wait) => retired.waits.includes(retiredIdentityHash(wait.token))) ||
				state.authority?.work.some((work) => retired.work.includes(retiredIdentityHash(work.id))) ||
				state.authority?.executions.some((execution) =>
					retired.executions.includes(retiredIdentityHash(execution.producer, execution.execution)),
				)
			)
				throw new FlowLedgerError("identity", "Retired identity is still registered.");
		}
		if (state.toolReceipts !== undefined) {
			if (!Array.isArray(state.toolReceipts) || state.toolReceipts.length > 256)
				throw new FlowLedgerError("capacity", "Invalid wait tool receipt count.");
			const keys = new Set<string>();
			for (const receipt of state.toolReceipts) {
				const wait = state.waits.find((wait) => wait.token === receipt?.token);
				const key = JSON.stringify([receipt?.token, receipt?.toolCallId, receipt?.toolName]);
				if (
					!wait ||
					!state.authority?.waitTokens.includes(wait.token) ||
					["waiting", "cancelled"].includes(wait.state) ||
					typeof receipt.toolCallId !== "string" ||
					!receipt.toolCallId ||
					receipt.toolCallId.length > 512 ||
					!["agent_wait", "agent_wait_cancel"].includes(receipt.toolName) ||
					keys.has(key) ||
					receipt.contentHash !== waitToolContentHash(waitToolResponse(wait).content)
				)
					throw new FlowLedgerError("identity", "Invalid wait tool response receipt.");
				keys.add(key);
			}
		}
		if (state.authority !== undefined) {
			validateWaitAuthority(state.authority);
			if (
				state.authority.waitTokens.some(
					(token) =>
						!state.waits.some(
							(wait) => wait.token === token && state.authority?.work.some((work) => work.id === wait.workId),
						),
				)
			)
				throw new FlowLedgerError("identity", "Owned wait has no registered work.");
		}
		const tokens = new Set<string>(),
			work = new Set<string>();
		for (const wait of state.waits) {
			validateWait(wait);
			if (wait.state === "waiting" && state.authority?.waitTokens.includes(wait.token)) {
				const work = state.authority.work.find((work) => work.id === wait.workId);
				if (work) requireOpenAuthorityWork(work);
				const observations = authorityObservations(state.authority, state.scope, wait.workId, wait.on);
				if (!isDeepStrictEqual(wait, reconcileFlowWait(wait, observations, wait.createdAt)))
					throw new FlowLedgerError("identity", "Live wait does not match registered execution evidence.");
			}
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
		const state: State = saved ?? { version: 1, scope: this.ownership.scope, waits: [] };
		if (state.authority && migrateWaitAuthority(state.authority)) this.legacyBindings = true;
		this.validate(state);
		return structuredClone(state);
	}
	private async update<T>(change: (state: State) => T): Promise<T> {
		this.mutations++;
		try {
			let changed = false;
			const result = await this.ownership.run(() =>
				this.session.mutate(async (mutation, context) => {
					const state = await this.read(mutation);
					const migrated = this.legacyBindings;
					this.legacyBindings = false;
					const before = structuredClone(state);
					const result = change(state);
					changed = migrated || !isDeepStrictEqual(before, state);
					this.validate(state);
					if (changed || !this.initialized) await mutation.commit([setValue(address, state)], context);
					this.work = structuredClone(state.authority?.work ?? []);
					this.retiredWorkHashes = [...(state.retired?.work ?? [])];
					this.inactiveWorkIds = this.work
						.filter((work) => (work.lifecycle?.state ?? "active") !== "active")
						.map((work) => work.id);
					this.waitingWorkIds = state.waits.filter((wait) => wait.state === "waiting").map((wait) => wait.workId);
					return structuredClone(result);
				}, BACKGROUND_CONTEXT),
			);
			if (changed) {
				this.deadlines?.changed();
				this.notifyChanged();
			}
			return result;
		} finally {
			this.mutations--;
		}
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
			if (state.authority?.work.some((work) => work.id === captured.request.workId))
				throw new FlowLedgerError("identity", "Registered work requires an owned wait declaration.");
			return this.declareInState(state, captured.request, captured.observations, now, maxDurationMs, replaceToken);
		});
	}
	private declareInState(
		state: State,
		request: Declaration,
		observations: FlowWaitObservation[],
		now: number,
		maxDurationMs: number,
		replaceToken?: string,
	): FlowWaitState {
		if (state.retired?.work.includes(retiredIdentityHash(request.workId)))
			throw new FlowLedgerError("stale", "Work identity has been retired.");
		if (state.retired?.waits.includes(retiredIdentityHash(request.token)))
			throw new FlowLedgerError("stale", "Wait token has been retired.");
		const next = createFlowWait(request, observations, now, maxDurationMs);
		if (state.waits.some((wait) => wait.token === next.token))
			throw new FlowLedgerError("identity", "Wait token is already registered.");
		const active = state.waits.find((wait) => wait.workId === next.workId && wait.state === "waiting");
		if (replaceToken !== undefined && (!active || active.token !== replaceToken))
			throw new FlowLedgerError("stale", "Wait replacement requires the active token.");
		if (active && replaceToken === undefined) throw new FlowLedgerError("transition", "Work already has a live wait.");
		if (active) state.waits[state.waits.indexOf(active)] = cancelFlowWait(active, "Replaced by a new wait.", now);
		state.waits.push(next);
		return next;
	}
	private authorityChange<T>(now: number, change: (authority: FlowWaitAuthority, state: State) => T): Promise<T> {
		if (!Number.isSafeInteger(now) || now < 0)
			return Promise.reject(new FlowLedgerError("schema", "Invalid ownership update time."));
		return this.update((state) => {
			state.authority ??= emptyWaitAuthority();
			const authority = state.authority;
			const result = change(authority, state);
			validateWaitAuthority(authority);
			state.waits = state.waits.map((wait) =>
				wait.state === "waiting" && authority.waitTokens.includes(wait.token)
					? reconcileFlowWait(wait, authorityObservations(authority, state.scope, wait.workId, wait.on), now)
					: wait,
			);
			return result;
		});
	}
	registerWork(id: string, owner: string, now: number, userInputs?: FlowAuthorityWork["userInputs"]) {
		const inputs = userInputs ? structuredClone(userInputs) : userInputs;
		return this.authorityChange(now, (authority, state) => {
			if (state.retired?.work.includes(retiredIdentityHash(id)))
				throw new FlowLedgerError("stale", "Work identity has been retired.");
			if (!authority.work.some((work) => work.id === id) && state.waits.some((wait) => wait.workId === id))
				throw new FlowLedgerError(
					"identity",
					"Existing waits require ownership reconciliation before registering work.",
				);
			return registerAuthorityWork(authority, id, owner, now, inputs);
		});
	}
	changeWork(id: string, owner: string, workRevision: number, status: FlowWorkStatus, reason: string, now: number) {
		return this.authorityChange(now, (authority, state) => {
			const work = changeAuthorityWork(authority, id, owner, workRevision, status, reason, now);
			if (status === "stopped" || status === "completed")
				state.waits = state.waits.map((wait) =>
					wait.workId === id && wait.state === "waiting" ? cancelFlowWait(wait, reason, now) : wait,
				);
			return work;
		});
	}
	/** Owner-scoped activation: a binding holds one live generation, and a new one starts only after the previous campaign ends. */
	activateWorkBinding(binding: FlowWorkBinding, now: number, participants: readonly string[] = []) {
		const shared = [...participants];
		return this.authorityChange(now, (authority) => {
			const captured = captureWorkBinding(binding);
			let work = findLiveBoundWork(authority, captured);
			if (!work) {
				work = registerAuthorityWork(authority, `${captured.producer}-work:${randomUUID()}`, captured.producer, now);
				work.binding = structuredClone(captured);
				for (const participant of shared)
					if (!work.participants.includes(participant)) work.participants.push(participant);
			} else if (work.lifecycle?.state === "paused") {
				work = changeAuthorityWork(authority, work.id, work.owner, work.revision, "active", "Binding resumed", now);
			}
			return work;
		});
	}
	/** Read the committed live work bound to a producer key without gaining or renewing work authority. */
	boundWork(binding: FlowWorkBinding): FlowAuthorityWork | undefined {
		this.ownership.assertActive();
		if (!this.initialized) throw new FlowLedgerError("busy", "Work ownership is not initialized.");
		return structuredClone(findLiveBoundWork({ version: 1, work: this.work, executions: [], waitTokens: [] }, binding));
	}
	shareWork(id: string, owner: string, workRevision: number, participant: string, now: number) {
		return this.authorityChange(now, (authority) =>
			shareAuthorityWork(authority, id, owner, workRevision, participant),
		);
	}
	registerExecution(input: Omit<FlowAuthorityExecution, "observedAt">, workRevision: number, now: number) {
		const captured = structuredClone(input);
		return this.authorityChange(now, (authority, state) => {
			this.requireUnretiredExecution(state, captured);
			return registerAuthorityExecution(authority, captured, workRevision, now);
		});
	}
	/** Reattachment snapshots may advance an existing exact execution, never replace its identity. */
	synchronizeExecution(input: Omit<FlowAuthorityExecution, "observedAt">, workRevision: number, now: number) {
		const captured = structuredClone(input);
		return this.authorityChange(now, (authority, state) => {
			this.requireUnretiredExecution(state, captured);
			requireAuthorityWork(authority, captured.workId, captured.producer, workRevision);
			const existing = authority.executions.find(
				(execution) => execution.producer === captured.producer && execution.execution === captured.execution,
			);
			if (!existing) return registerAuthorityExecution(authority, captured, workRevision, now);
			if (existing.workId !== captured.workId || existing.handle !== captured.handle)
				throw new FlowLedgerError("identity", "Execution snapshot changed registered ownership.");
			return observeAuthorityExecution(authority, captured, captured.revision, captured.predicates, now);
		});
	}
	observeExecution(
		handle: Omit<Declaration["on"][number], "until">,
		revision: number,
		predicates: FlowAuthorityExecution["predicates"],
		now: number,
	) {
		const captured = structuredClone({ handle, predicates });
		return this.authorityChange(now, (authority) =>
			observeAuthorityExecution(authority, captured.handle, revision, captured.predicates, now),
		);
	}
	declareOwned(
		producer: string,
		workRevision: number,
		request: Declaration,
		now: number,
		maxDurationMs: number,
		replaceToken?: string,
		assertActive?: () => void,
		toolResponse?: Pick<FlowWaitToolReceipt, "toolCallId" | "toolName">,
	): Promise<FlowWaitState> {
		const captured = structuredClone(request);
		const response = toolResponse ? { ...toolResponse } : undefined;
		return this.update((state) => {
			assertActive?.();
			const authority = state.authority ?? emptyWaitAuthority();
			requireOpenAuthorityWork(requireAuthorityWork(authority, captured.workId, producer, workRevision));
			const observations = authorityObservations(authority, state.scope, captured.workId, captured.on);
			const next = this.declareInState(state, captured, observations, now, maxDurationMs, replaceToken);
			authority.waitTokens.push(next.token);
			this.recordToolResponse(state, next, response);
			return next;
		});
	}
	cancelOwned(
		producer: string,
		workRevision: number,
		token: string,
		reason: string,
		now: number,
		assertActive?: () => void,
		toolResponse?: Pick<FlowWaitToolReceipt, "toolCallId" | "toolName">,
	): Promise<FlowWaitState> {
		const response = toolResponse ? { ...toolResponse } : undefined;
		return this.update((state) => {
			assertActive?.();
			const authority = state.authority ?? emptyWaitAuthority();
			const index = state.waits.findIndex((wait) => wait.token === token && authority.waitTokens.includes(token));
			if (index < 0) throw new FlowLedgerError("identity", "Owned wait token is not registered.");
			requireAuthorityWork(authority, state.waits[index].workId, producer, workRevision);
			state.waits[index] = cancelFlowWait(state.waits[index], reason, now);
			this.recordToolResponse(state, state.waits[index], response);
			return state.waits[index];
		});
	}
	private recordToolResponse(
		state: State,
		wait: FlowWaitState,
		source?: Pick<FlowWaitToolReceipt, "toolCallId" | "toolName">,
	): void {
		if (!source || ["waiting", "cancelled"].includes(wait.state)) return;
		const receipt = { token: wait.token, ...source, contentHash: waitToolContentHash(waitToolResponse(wait).content) };
		state.toolReceipts ??= [];
		if (!state.toolReceipts.some((prior) => isDeepStrictEqual(prior, receipt))) state.toolReceipts.push(receipt);
	}
	toolReceipts(): Promise<FlowWaitToolReceipt[]> {
		return this.ownership.run(() =>
			this.session.mutate(
				async (reader) => structuredClone((await this.read(reader)).toolReceipts ?? []),
				BACKGROUND_CONTEXT,
			),
		);
	}
	async authoritySnapshot(): Promise<FlowWaitAuthority> {
		return this.ownership.run(() =>
			this.session.mutate(
				async (reader) => (await this.read(reader)).authority ?? emptyWaitAuthority(),
				BACKGROUND_CONTEXT,
			),
		);
	}

	private requireUnretiredExecution(state: State, execution: { producer: string; execution: string }): void {
		if (state.retired?.executions.includes(retiredIdentityHash(execution.producer, execution.execution)))
			throw new FlowLedgerError("stale", "Execution identity has been retired.");
	}

	/** Host retention coordinator supplies exact, observed snapshots under its idle reservation. */
	retire(
		request: FlowWaitRetirement,
		assertCurrent?: () => void,
	): Promise<{ work: number; executions: number; waits: number }> {
		const captured = structuredClone(request);
		return this.update((state) => {
			assertCurrent?.();
			if (
				!captured ||
				!Array.isArray(captured.work) ||
				!Array.isArray(captured.executions) ||
				!Array.isArray(captured.waits) ||
				(captured.finishedUserWork !== undefined &&
					(!Array.isArray(captured.finishedUserWork) || captured.finishedUserWork.length > 256)) ||
				captured.work.length > 256 ||
				captured.executions.length > 1024 ||
				captured.waits.length > 128
			)
				throw new FlowLedgerError("schema", "Invalid wait retirement selection.");
			state.retired ??= { work: [], executions: [], waits: [] };
			const retired = state.retired;
			const select = <T>(
				requested: T[],
				records: T[],
				category: keyof RetiredIdentities,
				key: (item: T) => string,
			): T[] => {
				const selected: T[] = [];
				const seen = new Set<string>();
				for (const item of requested) {
					const id = key(item);
					if (seen.has(id)) throw new FlowLedgerError("identity", "Retirement repeats an identity.");
					seen.add(id);
					const stored = records.find((record) => key(record) === id);
					if (!stored && retired[category].includes(id)) continue;
					if (!stored || !isDeepStrictEqual(stored, item))
						throw new FlowLedgerError("stale", "Retirement snapshot changed.");
					selected.push(stored);
				}
				return selected;
			};
			const waits = select(captured.waits, state.waits, "waits", (wait) => retiredIdentityHash(wait.token));
			if (waits.some((wait) => wait.state === "waiting"))
				throw new FlowLedgerError("busy", "Live waits cannot be retired.");
			const remainingWaits = state.waits.filter((wait) => !waits.includes(wait));
			const authority = state.authority;
			const executions = select(captured.executions, authority?.executions ?? [], "executions", (execution) =>
				retiredIdentityHash(execution.producer, execution.execution),
			);
			if (
				executions.some(
					(execution) =>
						execution.predicates.some((predicate) => predicate.state === "pending") ||
						remainingWaits.some((wait) =>
							wait.on.some(
								(handle) => handle.producer === execution.producer && handle.execution === execution.execution,
							),
						),
				)
			)
				throw new FlowLedgerError("busy", "Referenced or pending executions cannot be retired.");
			const remainingExecutions = (authority?.executions ?? []).filter((execution) => !executions.includes(execution));
			const finished = captured.finishedUserWork ?? [];
			if (
				finished.some(
					(work) => work?.owner !== "host-user" || !work.userInputs?.length || work.lifecycle?.state === "paused",
				)
			)
				throw new FlowLedgerError(
					"identity",
					"Finished user work requires source membership and an unpaused lifecycle.",
				);
			const work = select([...captured.work, ...finished], authority?.work ?? [], "work", (work) =>
				retiredIdentityHash(work.id),
			);
			const finishedIds = new Set(finished.map((work) => work.id));
			if (
				work.some(
					(work) =>
						(!finishedIds.has(work.id) && !["stopped", "completed"].includes(work.lifecycle?.state ?? "active")) ||
						remainingWaits.some((wait) => wait.workId === work.id) ||
						remainingExecutions.some((execution) => execution.workId === work.id),
				)
			)
				throw new FlowLedgerError("busy", "Active or referenced work cannot be retired.");
			if (
				retired.work.length +
					retired.executions.length +
					retired.waits.length +
					work.length +
					executions.length +
					waits.length >
				MAX_RETIRED_FLOW_IDENTITIES
			)
				throw new FlowLedgerError("capacity", "Retired identity history is full; no records were removed.");
			retired.work.push(...work.map((work) => retiredIdentityHash(work.id)));
			retired.executions.push(
				...executions.map((execution) => retiredIdentityHash(execution.producer, execution.execution)),
			);
			retired.waits.push(...waits.map((wait) => retiredIdentityHash(wait.token)));
			state.waits = remainingWaits;
			if (state.toolReceipts)
				state.toolReceipts = state.toolReceipts.filter(
					(receipt) => !waits.some((wait) => wait.token === receipt.token),
				);
			if (authority) {
				authority.waitTokens = authority.waitTokens.filter((token) => !waits.some((wait) => wait.token === token));
				authority.executions = remainingExecutions;
				authority.work = authority.work.filter((item) => !work.includes(item));
			}
			return { work: work.length, executions: executions.length, waits: waits.length };
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
			if (state.authority?.waitTokens.includes(token))
				throw new FlowLedgerError("identity", "Owned waits require registered evidence or owner cancellation.");
			const index = state.waits.findIndex((wait) => wait.token === token);
			if (index < 0) throw new FlowLedgerError("stale", "Wait token is not registered.");
			state.waits[index] = change(state.waits[index]);
			return state.waits[index];
		});
	}
}
