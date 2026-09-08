import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, type Session, setValue, value } from "@earendil-works/pi-agent-core";
import { openLocalFlowSession } from "./local-storage.js";
import { FlowOwnership } from "./ownership.js";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";

export interface FlowBranchPosition {
	entryId: string;
	entryHash: string;
}
export interface FlowBranchRecord {
	id: string;
	enteredAtLeafId: string | null;
	fromBranchId?: string;
	transitionId?: string;
	position?: FlowBranchPosition;
}
export interface FlowBranchTransition {
	id: string;
	fromBranchId: string;
	branchId: string;
	previousLeafId: string | null;
}
export interface FlowSessionRegistryState {
	version: 1;
	sessionId: string;
	revision: number;
	activeBranchId: string;
	branches: FlowBranchRecord[];
	transition?: FlowBranchTransition;
}
const address = value<FlowSessionRegistryState>("jouzu.flow.session", "v1");
const identity = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 512;
const leaf = (id: unknown) => id === null || identity(id);
const validPosition = (position: FlowBranchPosition) =>
	position &&
	identity(position.entryId) &&
	typeof position.entryHash === "string" &&
	/^[a-f0-9]{64}$/.test(position.entryHash);
const samePosition = (a?: FlowBranchPosition, b?: FlowBranchPosition) =>
	a?.entryId === b?.entryId && a?.entryHash === b?.entryHash;

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
		if (state.branches.length > 1024 || Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024)
			throw new FlowLedgerError("capacity", "Session branch registry capacity reached.");
		const ids = new Set<string>(),
			transitions = new Set<string>();
		for (const [index, branch] of state.branches.entries()) {
			if (
				!branch ||
				!identity(branch.id) ||
				ids.has(branch.id) ||
				!leaf(branch.enteredAtLeafId) ||
				(branch.position !== undefined && !validPosition(branch.position)) ||
				(index === 0
					? branch.fromBranchId !== undefined || branch.transitionId !== undefined
					: branch.fromBranchId !== state.branches[index - 1].id ||
						!identity(branch.transitionId) ||
						transitions.has(branch.transitionId))
			)
				throw new FlowLedgerError("schema", "Invalid session branch ancestry.");
			ids.add(branch.id);
			if (branch.transitionId) transitions.add(branch.transitionId);
		}
		if (state.activeBranchId !== state.branches.at(-1)?.id)
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
				!leaf(pending.previousLeafId))
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
	/** Bind the initial branch to verified durable transcript metadata once. */
	bindInitialPosition(expectedRevision: number, position: FlowBranchPosition): Promise<void> {
		if (!validPosition(position))
			return Promise.reject(new FlowLedgerError("identity", "Invalid branch position evidence."));
		return this.transact((state) => {
			if (state.revision !== expectedRevision || state.transition || state.branches.length !== 1)
				throw new FlowLedgerError("stale", "Initial branch binding changed.");
			const branch = state.branches[0];
			if (branch.position && !samePosition(branch.position, position))
				throw new FlowLedgerError("identity", "Initial branch position is already bound.");
			const changed = !branch.position;
			branch.position = structuredClone(position);
			return { result: undefined, changed };
		});
	}
	/** Persist before detaching the old controller or mutating the host transcript. */
	beginNavigation(expectedRevision: number, previousLeafId: string | null): Promise<FlowBranchTransition> {
		if (!leaf(previousLeafId))
			return Promise.reject(new FlowLedgerError("identity", "Invalid previous transcript position."));
		return this.transact((state) => {
			if (state.revision !== expectedRevision) throw new FlowLedgerError("stale", "Session branch revision changed.");
			if (state.transition) throw new FlowLedgerError("transition", "A branch navigation is already unresolved.");
			if (state.branches.length >= 1024)
				throw new FlowLedgerError("capacity", "Session branch registry capacity reached.");
			state.transition = {
				id: randomUUID(),
				fromBranchId: state.activeBranchId,
				branchId: randomUUID(),
				previousLeafId,
			};
			return { result: state.transition, changed: true };
		});
	}
	/** Call after native branch mutation and durable transcript-position evidence. This creates no delivery permission. */
	finishNavigation(
		transitionId: string,
		enteredAtLeafId: string | null,
		position?: FlowBranchPosition,
	): Promise<FlowScope> {
		if (!identity(transitionId) || !leaf(enteredAtLeafId) || (position !== undefined && !validPosition(position)))
			return Promise.reject(new FlowLedgerError("identity", "Invalid branch transition identity."));
		return this.transact((state) => {
			const last = state.branches.at(-1);
			if (
				!state.transition &&
				last?.transitionId === transitionId &&
				last.enteredAtLeafId === enteredAtLeafId &&
				samePosition(last.position, position)
			)
				return { result: { sessionId: state.sessionId, branchId: state.activeBranchId }, changed: false };
			if (state.transition?.id !== transitionId) throw new FlowLedgerError("stale", "Branch transition changed.");
			const { branchId, fromBranchId } = state.transition;
			state.branches.push({
				id: branchId,
				fromBranchId,
				transitionId,
				enteredAtLeafId,
				...(position ? { position: structuredClone(position) } : {}),
			});
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
