import { createHash, randomUUID } from "node:crypto";
import type { CustomEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { verifyPiHistoryEntry } from "./pi-history-receipts.js";
import {
	type FlowBranchPosition,
	type FlowSessionRegistryState,
	neverNavigated,
	type PiFlowSessionRegistry,
} from "./pi-session-registry.js";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";

const memoryInstances = new WeakMap<SessionManager, { sessionId: string; id: string }>();
function memoryInstance(manager: SessionManager): string {
	const sessionId = manager.getSessionId();
	let instance = memoryInstances.get(manager);
	if (!instance || instance.sessionId !== sessionId) {
		instance = { sessionId, id: randomUUID() };
		memoryInstances.set(manager, instance);
	}
	return instance.id;
}

const customType = "jouzu-flow-branch";
interface MarkerData {
	version: 1;
	sessionId: string;
	branchId: string;
	transitionId?: string;
}
type Marker = CustomEntry<MarkerData> & { data: MarkerData };
const identity = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 512;
function latestMarker(manager: SessionManager): Marker | undefined {
	for (const entry of manager.getBranch().reverse()) {
		if (entry.type !== "custom" || entry.customType !== customType) continue;
		const data = entry.data as MarkerData;
		if (
			data?.version !== 1 ||
			!identity(data.sessionId) ||
			!identity(data.branchId) ||
			(data.transitionId !== undefined && !identity(data.transitionId))
		)
			throw new FlowLedgerError("schema", "Invalid flow branch marker.");
		if (data.sessionId === manager.getSessionId()) return entry as Marker;
	}
	return undefined;
}
function assertSession(state: FlowSessionRegistryState, manager: SessionManager): void {
	if (state.sessionId !== manager.getSessionId())
		throw new FlowLedgerError("scope", "Branch registry belongs to another Pi session.");
	const position = state.branches.at(-1)?.position;
	if (position && position.memoryInstanceId !== (manager.isPersisted() ? undefined : memoryInstance(manager)))
		throw new FlowLedgerError("identity", "Branch binding belongs to another transcript lifetime.");
	if (!manager.isPersisted() && state.transition && !position?.memoryInstanceId)
		throw new FlowLedgerError("transition", "Memory navigation has no bound session lifetime.");
}
async function evidence(manager: SessionManager, marker: Marker): Promise<FlowBranchPosition> {
	const captured = JSON.stringify(marker);
	const result = await verifyPiHistoryEntry(manager, marker.id);
	if (JSON.stringify(manager.getEntry(marker.id)) !== captured)
		throw new FlowLedgerError("stale", "Branch marker changed during verification.");
	if (result.kind === "memory")
		return {
			entryId: marker.id,
			entryHash: createHash("sha256").update(captured).digest("hex"),
			memoryInstanceId: memoryInstance(manager),
		};
	if (result.kind !== "persisted")
		throw new FlowLedgerError("transition", "Branch marker is not durably recorded in the Pi transcript.");
	return { entryId: marker.id, entryHash: result.entryHash };
}
function appendMarker(manager: SessionManager, data: MarkerData): Marker {
	const id = manager.appendCustomEntry(customType, data);
	manager.flush();
	const entry = manager.getEntry(id);
	if (entry?.type !== "custom") throw new FlowLedgerError("identity", "Pi did not retain the branch marker.");
	return entry as Marker;
}
function assertPosition(manager: SessionManager, sessionId: string, leafId: string | null): void {
	if (manager.getSessionId() !== sessionId || manager.getLeafId() !== leafId)
		throw new FlowLedgerError("stale", "Pi transcript changed during branch binding.");
}
async function assertRegistry(registry: PiFlowSessionRegistry, scope: FlowScope, revision: number): Promise<void> {
	const current = await registry.snapshot();
	if (current.revision !== revision || current.transition || current.activeBranchId !== scope.branchId)
		throw new FlowLedgerError("stale", "Branch registry changed during transcript verification.");
}

/** Reconcile an owned registry with the active Pi transcript before attaching a controller. */
export async function bindPiFlowBranch(registry: PiFlowSessionRegistry, manager: SessionManager): Promise<FlowScope> {
	return registry.run(async () => {
		const state = await registry.snapshot();
		assertSession(state, manager);
		let marker = latestMarker(manager);
		const pending = state.transition;
		if (pending) {
			if (!marker || marker.data.branchId !== pending.branchId || marker.data.transitionId !== pending.id)
				throw new FlowLedgerError("transition", "Interrupted navigation has no matching branch marker.");
			const leafId = manager.getLeafId();
			const position = await evidence(manager, marker);
			const scope = await registry.finishNavigation(pending.id, marker.id, position);
			await assertRegistry(registry, scope, state.revision + 1);
			assertPosition(manager, state.sessionId, leafId);
			return scope;
		}
		const branch = state.branches.at(-1);
		if (!branch) throw new FlowLedgerError("schema", "Active branch record is missing.");
		if (!marker && !branch.position && neverNavigated(state) && manager.getLeafId() === branch.enteredAtLeafId)
			marker = appendMarker(manager, { version: 1, sessionId: state.sessionId, branchId: branch.id });
		if (!marker || marker.data.branchId !== branch.id || marker.data.transitionId !== branch.transitionId)
			throw new FlowLedgerError("identity", "Active Pi branch differs from its flow registry.");
		const leafId = manager.getLeafId();
		const position = await evidence(manager, marker);
		if (branch.position) {
			if (
				branch.position.entryId !== position.entryId ||
				branch.position.entryHash !== position.entryHash ||
				branch.position.memoryInstanceId !== position.memoryInstanceId
			)
				throw new FlowLedgerError("identity", "Verified branch position differs from its registry binding.");
		} else {
			if (!neverNavigated(state) || marker.parentId !== branch.enteredAtLeafId)
				throw new FlowLedgerError("identity", "Unbound branch marker cannot establish initial ownership.");
			await registry.bindInitialPosition(state.revision, position);
		}
		const scope = { sessionId: state.sessionId, branchId: branch.id };
		await assertRegistry(registry, scope, state.revision + (branch.position ? 0 : 1));
		assertPosition(manager, state.sessionId, leafId);
		return scope;
	});
}

/** Called only after authorized native navigation; persist its marker before committing the new registry branch. */
export async function completePiFlowNavigation(
	registry: PiFlowSessionRegistry,
	manager: SessionManager,
	transitionId: string,
): Promise<FlowScope> {
	return registry.run(async () => {
		const state = await registry.snapshot();
		assertSession(state, manager);
		const pending = state.transition;
		if (!pending || pending.id !== transitionId)
			throw new FlowLedgerError("stale", "Branch transition changed before binding.");
		let marker = latestMarker(manager);
		if (!marker || marker.data.branchId !== pending.branchId || marker.data.transitionId !== pending.id)
			marker = appendMarker(manager, {
				version: 1,
				sessionId: state.sessionId,
				branchId: pending.branchId,
				transitionId: pending.id,
			});
		const leafId = manager.getLeafId();
		const position = await evidence(manager, marker);
		const scope = await registry.finishNavigation(pending.id, marker.id, position);
		await assertRegistry(registry, scope, state.revision + 1);
		assertPosition(manager, state.sessionId, leafId);
		return scope;
	});
}
