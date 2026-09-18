import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Session, setValue, value } from "@earendil-works/pi-agent-core";
import { openLocalFlowSession } from "./local-storage.js";
import { FlowOwnership } from "./ownership.js";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";

export interface FlowBranchPosition {
	entryId: string;
	entryHash: string;
	/** Present only for a live, non-persistent Pi session manager. This is not a history receipt. */
	memoryInstanceId?: string;
}
export interface FlowBranchRecord {
	id: string;
	enteredAtLeafId: string | null;
	fromBranchId?: string;
	transitionId?: string;
	position?: FlowBranchPosition;
	/** Last transcript position left by a completed navigation. Earlier positions must fork. */
	departedAtLeafId?: string | null;
}
export interface FlowBranchTransition {
	id: string;
	fromBranchId: string;
	branchId: string;
	previousLeafId: string | null;
	/** File tip before navigation, which may differ from the selected leaf. */
	previousTipId?: string | null;
}
export interface FlowSessionRegistryState {
	version: 1;
	sessionId: string;
	revision: number;
	activeBranchId: string;
	branches: FlowBranchRecord[];
	/** Ancestry dropped by retirement; `through` lists dropped parents retained records still cite. */
	retired?: { count: number; through: string[] };
	transition?: FlowBranchTransition;
}

/**
 * Whether this session still sits on its first branch. Retirement can leave one record behind, so
 * the record count alone stops proving it; a retired ancestor means navigation already happened.
 */
export const neverNavigated = (state: FlowSessionRegistryState): boolean =>
	state.branches.length === 1 && state.retired === undefined;
const address = value<FlowSessionRegistryState>("jouzu.flow.session", "v1");
/**
 * Bounds on one session's branch registry. The record count bounds the common case, and the byte
 * budget is the real limit: it is what the storage layer and the transcript reader pay. Both are
 * enforced by retirement, because a state over either is refused when it is read, which leaves the
 * session unable to attach.
 */
const maxBranches = 1024;
const maxStateBytes = 1024 * 1024;
const identity = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 512;
const leaf = (id: unknown) => id === null || identity(id);
const validPosition = (position: FlowBranchPosition) =>
	position &&
	identity(position.entryId) &&
	typeof position.entryHash === "string" &&
	/^[a-f0-9]{64}$/.test(position.entryHash) &&
	(position.memoryInstanceId === undefined || identity(position.memoryInstanceId));
const samePosition = (a?: FlowBranchPosition, b?: FlowBranchPosition) =>
	a?.entryId === b?.entryId && a?.entryHash === b?.entryHash && a?.memoryInstanceId === b?.memoryInstanceId;

/** Session-wide writer reservation and branch identities in Pi storage. Reads grant no dispatch authority. */
export class PiFlowSessionRegistry {
	private initialized = false;
	private constructor(
		private readonly ownership: FlowOwnership,
		private readonly session: Session,
	) {}
	static async open(
		root: string,
		sessionId: string,
		initialLeafId: string | null,
		openSession: (directory: string) => Promise<Session> = openLocalFlowSession,
	): Promise<PiFlowSessionRegistry> {
		if (!leaf(initialLeafId)) throw new FlowLedgerError("identity", "Invalid initial transcript position.");
		const ownership = FlowOwnership.acquire(join(root, "session-registry-v1"), { sessionId, branchId: "registry" });
		let session: Session | undefined;
		try {
			session = await openSession(ownership.directory);
			const registry = new PiFlowSessionRegistry(ownership, session);
			await registry.transact((state) => ({ result: state, changed: false }), initialLeafId);
			registry.initialized = true;
			return registry;
		} catch (error) {
			try {
				await ownership.close(() => session?.close(BACKGROUND_CONTEXT));
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Session registry failed and storage did not close.");
			}
			throw error;
		}
	}
	private validate(state: FlowSessionRegistryState): void {
		if (
			state?.version !== 1 ||
			state.sessionId !== this.ownership.scope.sessionId ||
			!Number.isSafeInteger(state.revision) ||
			state.revision < 0 ||
			!Array.isArray(state.branches) ||
			!state.branches.length ||
			!identity(state.activeBranchId)
		)
			throw new FlowLedgerError("schema", "Invalid session branch registry.");
		if (state.branches.length > maxBranches || this.stateBytes(state) > maxStateBytes)
			throw new FlowLedgerError("capacity", "Session branch registry capacity reached.");
		const retired = state.retired;
		if (
			retired !== undefined &&
			(!retired ||
				!Number.isSafeInteger(retired.count) ||
				retired.count < 1 ||
				!Array.isArray(retired.through) ||
				retired.through.some((id) => !identity(id)) ||
				new Set(retired.through).size !== retired.through.length ||
				retired.through.length > retired.count)
		)
			throw new FlowLedgerError("schema", "Invalid retired branch ancestry.");
		const allIds = new Set<string>();
		for (const branch of state.branches) if (branch && identity(branch.id)) allIds.add(branch.id);
		const cited = new Set<string>();
		for (const branch of state.branches) if (branch && identity(branch.fromBranchId)) cited.add(branch.fromBranchId);
		if (retired && (retired.through.some((id) => allIds.has(id)) || retired.through.some((id) => !cited.has(id))))
			throw new FlowLedgerError("schema", "Retired branch ancestry does not follow its retained records.");
		const ids = new Set<string>(),
			transitions = new Set<string>(),
			positions = new Set<string>();
		for (const [index, branch] of state.branches.entries()) {
			if (
				!branch ||
				!identity(branch.id) ||
				ids.has(branch.id) ||
				!leaf(branch.enteredAtLeafId) ||
				(branch.departedAtLeafId !== undefined && !leaf(branch.departedAtLeafId)) ||
				(branch.position !== undefined && (!validPosition(branch.position) || positions.has(branch.position.entryId)))
			)
				throw new FlowLedgerError("schema", "Invalid session branch ancestry.");
			const parent = branch.fromBranchId;
			if (parent === undefined) {
				// Sparse retirement can retain the original root while dropping later records.
				if (index !== 0 || branch.transitionId !== undefined)
					throw new FlowLedgerError("schema", "Invalid session branch ancestry.");
			} else {
				// A parent is either an earlier retained record or a retired ancestor; a record
				// appearing later in the array can never be cited.
				const retainedParent = ids.has(parent);
				if (
					!identity(parent) ||
					(!retainedParent && allIds.has(parent)) ||
					(!retainedParent && !(retired && retired.through.includes(parent))) ||
					!identity(branch.transitionId) ||
					transitions.has(branch.transitionId)
				)
					throw new FlowLedgerError("schema", "Invalid session branch ancestry.");
				transitions.add(branch.transitionId);
			}
			ids.add(branch.id);
			if (branch.position) positions.add(branch.position.entryId);
		}
		if (!ids.has(state.activeBranchId))
			throw new FlowLedgerError("schema", "Session registry has an inconsistent active branch.");
		const pending = state.transition;
		if (
			pending !== undefined &&
			(!pending ||
				!identity(pending.id) ||
				transitions.has(pending.id) ||
				!identity(pending.branchId) ||
				ids.has(pending.branchId) ||
				pending.fromBranchId !== state.activeBranchId ||
				!leaf(pending.previousLeafId) ||
				(pending.previousTipId !== undefined && !leaf(pending.previousTipId)))
		)
			throw new FlowLedgerError("schema", "Invalid pending branch transition.");
	}
	private transact<T>(
		update: (state: FlowSessionRegistryState) => { result: T; changed: boolean },
		initialLeafId: string | null = null,
	): Promise<T> {
		return this.ownership.run(() =>
			this.session.mutate(async (mutation, context) => {
				const stored = (await mutation.getValue(address, context))?.value;
				if (stored !== undefined && !stored) throw new FlowLedgerError("schema", "Invalid session branch registry.");
				if (!stored && this.initialized) throw new FlowLedgerError("schema", "Session branch registry is missing.");
				const initialId = stored?.activeBranchId ?? randomUUID();
				const state: FlowSessionRegistryState = structuredClone(
					stored ?? {
						version: 1,
						sessionId: this.ownership.scope.sessionId,
						revision: 0,
						activeBranchId: initialId,
						branches: [{ id: initialId, enteredAtLeafId: initialLeafId }],
					},
				);
				// Earlier revisions recorded one retired parent; normalize before validation.
				if (state.retired && !Array.isArray(state.retired.through))
					state.retired = {
						count: state.retired.count,
						through: [state.retired.through as unknown as string],
					};
				this.validate(state);
				const { result, changed } = update(state);
				if (changed) state.revision++;
				this.validate(state);
				if (!stored || changed) await mutation.commit([setValue(address, state)], context);
				return structuredClone(result);
			}, BACKGROUND_CONTEXT),
		);
	}
	snapshot(): Promise<FlowSessionRegistryState> {
		return this.transact((state) => ({ result: state, changed: false }));
	}
	/** Keep session ownership through host transcript operations and their registry receipts. */
	run<T>(operation: () => Promise<T>): Promise<T> {
		return this.ownership.run(operation);
	}
	/** Host transcript identity must be reconciled separately before opening or dispatching this branch. */
	currentScope(): Promise<FlowScope> {
		return this.transact((state) => {
			if (state.transition)
				throw new FlowLedgerError("transition", "Unfinished branch navigation requires reconciliation.");
			return { result: { sessionId: state.sessionId, branchId: state.activeBranchId }, changed: false };
		});
	}
	/** Bind the initial branch to verified transcript metadata once. */
	bindInitialPosition(expectedRevision: number, position: FlowBranchPosition): Promise<void> {
		if (!validPosition(position))
			return Promise.reject(new FlowLedgerError("identity", "Invalid branch position evidence."));
		return this.transact((state) => {
			if (state.revision !== expectedRevision || state.transition || !neverNavigated(state))
				throw new FlowLedgerError("stale", "Initial branch binding changed.");
			const branch = state.branches[0];
			if (branch.position && !samePosition(branch.position, position))
				throw new FlowLedgerError("identity", "Initial branch position is already bound.");
			const changed = !branch.position;
			branch.position = structuredClone(position);
			return { result: undefined, changed };
		});
	}
	/**
	 * Retire oldest unprotected records, preserving the active branch and the branches named in
	 * `protectedIds`. The caller must name every branch a later attach could bind to — the
	 * transcript owners — because a record dropped here can leave the session unable to attach:
	 * binding a verified marker whose record is gone rejects with `identity`. The parameter is
	 * required so no caller can retire without making that decision.
	 */
	retireBranchHistory(keep: number, protectedIds: ReadonlySet<string>): Promise<number> {
		if (!Number.isSafeInteger(keep) || keep < 1)
			return Promise.reject(new FlowLedgerError("capacity", "Invalid branch retention size."));
		if (!(protectedIds instanceof Set))
			return Promise.reject(new FlowLedgerError("capacity", "Branch retirement requires the protected branches."));
		return this.transact((state) => {
			if (state.transition) throw new FlowLedgerError("busy", "Branch retirement requires a settled navigation.");
			const dropped = this.retireRecords(state, keep, protectedIds);
			return { result: dropped, changed: dropped > 0 };
		});
	}

	private stateBytes(state: FlowSessionRegistryState): number {
		return Buffer.byteLength(JSON.stringify(state));
	}

	/** Drop at most `count` of the oldest records that are neither active nor protected. */
	private dropOldest(
		state: FlowSessionRegistryState,
		count: number,
		protectedIds: ReadonlySet<string>,
		dropped: Set<string>,
	): number {
		let excess = Math.max(0, count);
		state.branches = state.branches.filter((record) => {
			if (!excess || record.id === state.activeBranchId || protectedIds.has(record.id)) return true;
			dropped.add(record.id);
			excess--;
			return false;
		});
		return Math.max(0, count) - excess;
	}

	/**
	 * Retire oldest unprotected records down to `keep`, then further while the state is over the
	 * byte budget. The byte budget is a load-time limit, so it has to bound growth here: a state
	 * committed over it cannot be read back, which leaves the session unopenable. `reserve` is the
	 * size of a record the caller is about to add, so the budget it has to fit is smaller by that
	 * much. The second loop drops proportionally so a large excess converges in a few passes, and
	 * stops as soon as a pass cannot shrink the state or has nothing left to drop.
	 */
	private retireRecords(
		state: FlowSessionRegistryState,
		keep: number,
		protectedIds: ReadonlySet<string>,
		reserve = 0,
	): number {
		const dropped = new Set<string>();
		const retiredBefore = state.retired?.count ?? 0;
		const refresh = () => {
			const retained = new Set(state.branches.map((record) => record.id));
			state.retired = {
				count: retiredBefore + dropped.size,
				through: [
					...new Set(
						state.branches.flatMap((record) =>
							record.fromBranchId && !retained.has(record.fromBranchId) ? [record.fromBranchId] : [],
						),
					),
				],
			};
		};
		this.dropOldest(state, state.branches.length - keep, protectedIds, dropped);
		if (dropped.size) refresh();
		const budget = maxStateBytes - Math.max(0, reserve);
		let bytes = this.stateBytes(state);
		while (bytes > budget) {
			const perRecord = Math.max(1, Math.ceil(bytes / state.branches.length));
			const wanted = Math.max(1, Math.ceil((bytes - budget) / perRecord));
			if (this.dropOldest(state, wanted, protectedIds, dropped) === 0) break;
			refresh();
			const next = this.stateBytes(state);
			if (next >= bytes) break;
			bytes = next;
		}
		return dropped.size;
	}

	private recordDeparture(state: FlowSessionRegistryState): void {
		const pending = state.transition;
		const from = state.branches.find((record) => record.id === pending?.fromBranchId);
		if (!pending || !from) throw new FlowLedgerError("schema", "Navigation departure branch is missing.");
		from.departedAtLeafId = pending.previousLeafId;
	}

	/** Reattach an existing retained branch after verified transcript evidence. Creates no new branch. */
	reactivateNavigation(transitionId: string, branchId: string): Promise<FlowScope> {
		if (!identity(transitionId) || !identity(branchId))
			return Promise.reject(new FlowLedgerError("identity", "Invalid branch reactivation identity."));
		return this.transact((state) => {
			if (!state.transition || state.transition.id !== transitionId)
				throw new FlowLedgerError("stale", "Branch transition changed before reactivation.");
			if (!state.branches.some((record) => record.id === branchId))
				throw new FlowLedgerError("stale", "Branch reactivation target is not retained.");
			this.recordDeparture(state);
			state.activeBranchId = branchId;
			delete state.transition;
			return { result: { sessionId: state.sessionId, branchId }, changed: true };
		});
	}

	/** Follow the transcript's owning branch when attachment finds the active record elsewhere. */
	rebindActiveBranch(branchId: string): Promise<FlowScope> {
		if (!identity(branchId))
			return Promise.reject(new FlowLedgerError("identity", "Invalid branch rebinding identity."));
		return this.transact((state) => {
			if (state.transition) throw new FlowLedgerError("transition", "Branch rebinding requires a settled navigation.");
			if (!state.branches.some((record) => record.id === branchId))
				throw new FlowLedgerError("stale", "Branch rebinding target is not retained.");
			if (state.activeBranchId === branchId)
				return { result: { sessionId: state.sessionId, branchId }, changed: false };
			state.activeBranchId = branchId;
			return { result: { sessionId: state.sessionId, branchId }, changed: true };
		});
	}

	/** Persist before detaching the old controller or mutating the host transcript. */
	beginNavigation(
		expectedRevision: number,
		previousLeafId: string | null,
		previousTipId?: string | null,
	): Promise<FlowBranchTransition> {
		if (!leaf(previousLeafId) || (previousTipId !== undefined && !leaf(previousTipId)))
			return Promise.reject(new FlowLedgerError("identity", "Invalid previous transcript position."));
		return this.transact((state) => {
			if (state.revision !== expectedRevision) throw new FlowLedgerError("stale", "Session branch revision changed.");
			if (state.transition) throw new FlowLedgerError("transition", "A branch navigation is already unresolved.");
			state.transition = {
				id: randomUUID(),
				fromBranchId: state.activeBranchId,
				branchId: randomUUID(),
				previousLeafId,
				...(previousTipId !== undefined ? { previousTipId } : {}),
			};
			return { result: state.transition, changed: true };
		});
	}
	/**
	 * Call after native branch mutation and verified transcript-position evidence. This creates no
	 * delivery permission. `protectedIds` names the branches a later attach could bind to; the
	 * slot reservation below retires one record to make room for the fork, and it must not drop a
	 * record the transcript still needs.
	 */
	finishNavigation(
		transitionId: string,
		enteredAtLeafId: string | null,
		protectedIds: ReadonlySet<string>,
		position?: FlowBranchPosition,
	): Promise<FlowScope> {
		if (
			!identity(transitionId) ||
			!leaf(enteredAtLeafId) ||
			!(protectedIds instanceof Set) ||
			(position !== undefined && !validPosition(position))
		)
			return Promise.reject(new FlowLedgerError("identity", "Invalid branch transition identity."));
		return this.transact((state) => {
			const last = state.branches.at(-1);
			if (
				!state.transition &&
				// A retry is only a no-op while the record it completed still owns the session. After a
				// later navigation the caller's completion is stale, and reporting the now-active branch
				// as its result would name a branch that this transition never entered.
				last?.id === state.activeBranchId &&
				last?.transitionId === transitionId &&
				last.enteredAtLeafId === enteredAtLeafId &&
				samePosition(last.position, position)
			)
				return { result: { sessionId: state.sessionId, branchId: state.activeBranchId }, changed: false };
			if (state.transition?.id !== transitionId) throw new FlowLedgerError("stale", "Branch transition changed.");
			const { branchId, fromBranchId } = state.transition;
			this.recordDeparture(state);
			// A verified fork marker is already durable. Reserve its slot without dropping its parent
			// or any branch the transcript still owns, and keep room for the record being added: the
			// retirement has to leave the committed state inside the budget, not just the current one.
			const record: FlowBranchRecord = {
				id: branchId,
				fromBranchId,
				transitionId,
				enteredAtLeafId,
				...(position ? { position: structuredClone(position) } : {}),
			};
			this.retireRecords(state, 1023, protectedIds, Buffer.byteLength(JSON.stringify(record)) + 1);
			state.branches.push(record);
			state.activeBranchId = branchId;
			delete state.transition;
			return { result: { sessionId: state.sessionId, branchId }, changed: true };
		});
	}
	/** Keep the session lease until branch writers and registry storage have closed. */
	close(closeBranches?: () => void | Promise<void>): Promise<void> {
		return this.ownership.close(async () => {
			await closeBranches?.();
			await this.session.close(BACKGROUND_CONTEXT);
		});
	}
}
