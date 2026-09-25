import { createHash, randomUUID } from "node:crypto";
import type { CustomEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import { verifyPiHistoryEntry } from "./pi-history-receipts.js";
import {
	type FlowBranchPosition,
	type FlowBranchRecord,
	type FlowBranchTransition,
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
function markerFrom(sessionId: string, entries: readonly unknown[]): Marker | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as {
			type?: unknown;
			customType?: unknown;
			data?: unknown;
			id?: unknown;
		};
		if (entry.type !== "custom" || entry.customType !== customType) continue;
		const data = entry.data as MarkerData;
		// Another session's marker is not this session's to validate. A copied or malformed foreign
		// marker must not make every binding on this transcript throw.
		if (!data || data.sessionId !== sessionId) continue;
		if (
			data.version !== 1 ||
			!identity(data.branchId) ||
			(data.transitionId !== undefined && !identity(data.transitionId))
		)
			throw new FlowLedgerError("schema", "Invalid flow branch marker.");
		if (!identity(entry.id)) throw new FlowLedgerError("schema", "Invalid flow branch marker.");
		return entry as unknown as Marker;
	}
	return undefined;
}
function latestMarker(manager: SessionManager): Marker | undefined {
	return markerFrom(manager.getSessionId(), manager.getBranch());
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
/** Position evidence is the full triple: the same entry in another transcript lifetime is not the same position. */
function samePosition(a: FlowBranchPosition | undefined, b: FlowBranchPosition): boolean {
	return !!a && a.entryId === b.entryId && a.entryHash === b.entryHash && a.memoryInstanceId === b.memoryInstanceId;
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
/** The retained branch whose own marker is the deepest one on this transcript path. */
function reactivationTarget(state: FlowSessionRegistryState, marker: Marker | undefined): FlowBranchRecord | undefined {
	if (!marker) return undefined;
	const record = state.branches.find((branch) => branch.id === marker.data.branchId);
	if (
		!record ||
		record.transitionId !== marker.data.transitionId ||
		!record.position ||
		record.position.entryId !== marker.id
	)
		return undefined;
	return record;
}

function navigationPosition(manager: SessionManager, pending: FlowBranchTransition) {
	const current = manager.getLeafId();
	const entries = manager.getEntries();
	const tipIndex =
		pending.previousTipId === null ? -1 : entries.findIndex((entry) => entry.id === pending.previousTipId);
	// Older journals lack the file-tip checkpoint. They can prove only an unchanged selected leaf.
	if (pending.previousTipId === undefined || (tipIndex < 0 && pending.previousTipId !== null))
		return { destination: current, untouched: current === pending.previousLeafId };
	const path = new Set(manager.getBranch().map((entry) => entry.id));
	const appended = entries.slice(tipIndex + 1).find((entry) => path.has(entry.id));
	return {
		// Pi appends its summary/label at the destination before calling branchChanged.
		destination: appended ? appended.parentId : current,
		untouched:
			!appended && (current === pending.previousLeafId || (manager.isPersisted() && current === pending.previousTipId)),
	};
}

function canResume(target: FlowBranchRecord | undefined, activeId: string, destination: string | null): boolean {
	// A legacy record without a saved departure can still bind on restart, but cannot prove a resume.
	return !!target && target.id !== activeId && target.departedAtLeafId === destination;
}

/** The flow branches a restart or reattachment can still land on, for retirement protection. */
export function piTranscriptBranchOwners(manager: SessionManager): Set<string> {
	const owners = new Set<string>();
	const leafOwner = latestMarker(manager)?.data.branchId;
	if (leafOwner) owners.add(leafOwner);
	// A restart reopens the transcript at its newest entry, which may sit on another branch.
	const tip = manager.getEntries().at(-1);
	if (tip && identity(tip.id)) {
		const tipOwner = markerFrom(manager.getSessionId(), manager.getBranch(tip.id))?.data.branchId;
		if (tipOwner) owners.add(tipOwner);
	}
	return owners;
}

/** Reconcile an owned registry with the active Pi transcript before attaching a controller. */
export async function bindPiFlowBranch(
	registry: PiFlowSessionRegistry,
	manager: SessionManager,
	onRebuiltRegistry?: (droppedStatePath?: string) => void,
): Promise<FlowScope> {
	return registry.run(async () => {
		const state = await registry.snapshot();
		assertSession(state, manager);
		let marker = latestMarker(manager);
		const pending = state.transition;
		if (pending) {
			if (marker && marker.data.branchId === pending.branchId && marker.data.transitionId === pending.id) {
				const leafId = manager.getLeafId();
				const position = await evidence(manager, marker);
				const scope = await registry.finishNavigation(
					pending.id,
					marker.id,
					piTranscriptBranchOwners(manager),
					position,
				);
				await assertRegistry(registry, scope, state.revision + 1);
				assertPosition(manager, state.sessionId, leafId);
				return scope;
			}
			// No attached work belongs to the unmarked fork. An untouched journal follows the
			// reopened file tip; a persisted navigation uses the same resume rule as live completion.
			const navigation = navigationPosition(manager, pending);
			const recovered = marker && reactivationTarget(state, marker);
			if (
				recovered &&
				marker &&
				(navigation.untouched || canResume(recovered, state.activeBranchId, navigation.destination))
			) {
				const leafId = manager.getLeafId();
				const position = await evidence(manager, marker);
				if (!samePosition(recovered.position, position))
					throw new FlowLedgerError("identity", "Recovered branch position differs from its marker.");
				const scope = await registry.reactivateNavigation(pending.id, recovered.id);
				await assertRegistry(registry, scope, state.revision + 1);
				assertPosition(manager, state.sessionId, leafId);
				return scope;
			}
			// A rewind or an unowned destination completes the recorded fork at the crash point.
			const forkMarker = appendMarker(manager, {
				version: 1,
				sessionId: state.sessionId,
				branchId: pending.branchId,
				transitionId: pending.id,
			});
			const position = await evidence(manager, forkMarker);
			const scope = await registry.finishNavigation(
				pending.id,
				forkMarker.id,
				piTranscriptBranchOwners(manager),
				position,
			);
			await assertRegistry(registry, scope, state.revision + 1);
			assertPosition(manager, state.sessionId, forkMarker.id);
			return scope;
		}
		const branch = state.branches.find((record) => record.id === state.activeBranchId);
		if (!branch) throw new FlowLedgerError("schema", "Active branch record is missing.");
		if (!marker && !branch.position && neverNavigated(state) && manager.getLeafId() === branch.enteredAtLeafId)
			marker = appendMarker(manager, { version: 1, sessionId: state.sessionId, branchId: branch.id });
		if (!marker) throw new FlowLedgerError("identity", "Active Pi branch has no flow marker.");
		// A restart reopens the transcript at its newest entry, which can belong to another retained
		// branch; verified position evidence decides ownership, so attachment follows the transcript.
		// Evidence is verified before the registry changes, so a rejected marker selects nothing.
		const leafId = manager.getLeafId();
		const position = await evidence(manager, marker);
		const target = reactivationTarget(state, marker);
		let active = branch;
		let revision = state.revision;
		if (target && target.id !== branch.id) {
			if (!samePosition(target.position, position))
				throw new FlowLedgerError("identity", "Verified branch position differs from its registry binding.");
			const rebound = await registry.rebindActiveBranch(target.id);
			revision++;
			await assertRegistry(registry, rebound, revision);
			active = target;
		} else if (!target && (marker.data.branchId !== branch.id || marker.data.transitionId !== branch.transitionId)) {
			// The registry cannot be reconciled with this transcript's verified marker: it holds no
			// record of the marker's branch, or its record disagrees with the marker. Binding always
			// writes the marker as its branch position, so this is what a registry from an earlier
			// version looks like. The marker is the durable evidence and the registry is derived, so
			// rebuild from the marker and report the dropped state rather than refusing to open.
			const rebuilt = await registry.rebuildFromMarker(marker.data.branchId, marker.parentId ?? null, position);
			onRebuiltRegistry?.(rebuilt.isolated);
			revision = state.revision + 1;
			active = (await registry.snapshot()).branches[0];
		}
		if (active.position && active.position.entryId !== marker.id)
			throw new FlowLedgerError("identity", "Verified branch position differs from its registry binding.");
		if (active.position) {
			if (
				active.position.entryId !== position.entryId ||
				active.position.entryHash !== position.entryHash ||
				active.position.memoryInstanceId !== position.memoryInstanceId
			)
				throw new FlowLedgerError("identity", "Verified branch position differs from its registry binding.");
		} else {
			if (!neverNavigated(state) || marker.parentId !== active.enteredAtLeafId)
				throw new FlowLedgerError("identity", "Unbound branch marker cannot establish initial ownership.");
			await registry.bindInitialPosition(state.revision, position);
		}
		const scope = { sessionId: state.sessionId, branchId: active.id };
		await assertRegistry(registry, scope, revision + (active.position ? 0 : 1));
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
		const marker = latestMarker(manager);
		// Only returning to a retained branch's saved departure resumes its work.
		const target = marker && reactivationTarget(state, marker);
		const navigation = navigationPosition(manager, pending);
		if (target && marker && canResume(target, state.activeBranchId, navigation.destination)) {
			const leafId = manager.getLeafId();
			const position = await evidence(manager, marker);
			if (!samePosition(target.position, position))
				throw new FlowLedgerError("identity", "Reactivated branch position differs from its marker.");
			const scope = await registry.reactivateNavigation(pending.id, target.id);
			await assertRegistry(registry, scope, state.revision + 1);
			assertPosition(manager, state.sessionId, leafId);
			return scope;
		}
		let forkMarker = marker;
		if (!forkMarker || forkMarker.data.branchId !== pending.branchId || forkMarker.data.transitionId !== pending.id)
			forkMarker = appendMarker(manager, {
				version: 1,
				sessionId: state.sessionId,
				branchId: pending.branchId,
				transitionId: pending.id,
			});
		const leafId = manager.getLeafId();
		const position = await evidence(manager, forkMarker);
		const scope = await registry.finishNavigation(
			pending.id,
			forkMarker.id,
			piTranscriptBranchOwners(manager),
			position,
		);
		await assertRegistry(registry, scope, state.revision + 1);
		assertPosition(manager, state.sessionId, leafId);
		return scope;
	});
}
