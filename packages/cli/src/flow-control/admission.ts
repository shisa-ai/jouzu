import { MAX_RETIRED_FLOW_IDENTITIES, retiredIdentityHash, validRetiredIdentityHash } from "./retired-identities.js";
export type FlowRank = 2 | 3 | 4 | 5 | 6;
export interface FlowAdmissionState {
	version: 1;
	revision: number;
	cadenceDebt: number;
	rounds: Record<FlowRank, string[]>;
}
export interface FlowIntent {
	id: string;
	revision: string;
	producer: string;
	sequence: number;
	rank: FlowRank;
	workId?: string;
	workRevision?: string;
	independent: boolean;
	runnable: boolean;
}
export interface FlowAdmissionGates {
	hostReady: boolean;
	userPending: boolean;
	/** Reconciliation is incomplete, so no submission of any origin may be admitted. */
	recoveryBlocked: boolean;
	/**
	 * A turn was interrupted between transmission and its outcome. Automated admission waits for the
	 * user's decision, but the user's own input proceeds: the controls that resolve it arrive that way.
	 */
	outcomeUnresolved?: boolean;
	waitingWorkIds: string[];
	/** Explicitly paused, stopped, or completed work cannot request another turn. */
	inactiveWorkIds?: string[];
	retiredWorkHashes?: string[];
}
export interface FlowAdmissionChoice {
	revision: number;
	intent: FlowIntent;
	coalescedIds: string[];
	/** Results considered at this boundary; deferred members do not authorize pagination wakes. */
	resultSnapshot?: { id: string; revision: string; producer?: string }[];
	resultSamples?: { id: string; revision: string }[];
	next: FlowAdmissionState;
}
export class FlowAdmissionError extends Error {
	constructor(
		readonly code: "schema" | "identity" | "stale",
		message: string,
	) {
		super(message);
	}
}
const ranks: FlowRank[] = [2, 3, 4, 5, 6];
const identity = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 512;
export function initialFlowAdmission(): FlowAdmissionState {
	return { version: 1, revision: 0, cadenceDebt: 0, rounds: { 2: [], 3: [], 4: [], 5: [], 6: [] } };
}
export function validateFlowAdmission(state: FlowAdmissionState): void {
	if (
		state?.version !== 1 ||
		!Number.isSafeInteger(state.revision) ||
		state.revision < 0 ||
		!Number.isSafeInteger(state.cadenceDebt) ||
		state.cadenceDebt < 0 ||
		state.cadenceDebt > 4 ||
		!state.rounds
	)
		throw new FlowAdmissionError("schema", "Invalid admission policy state.");
	for (const rank of ranks) {
		const round = state.rounds[rank];
		if (
			!Array.isArray(round) ||
			round.length > 1024 ||
			round.some((id) => !identity(id)) ||
			new Set(round).size !== round.length
		)
			throw new FlowAdmissionError("schema", "Invalid admission producer round.");
	}
}
function validateIntent(intent: FlowIntent): void {
	if (
		!intent ||
		!identity(intent.id) ||
		!identity(intent.revision) ||
		!identity(intent.producer) ||
		!Number.isSafeInteger(intent.sequence) ||
		intent.sequence < 0 ||
		!ranks.includes(intent.rank) ||
		typeof intent.independent !== "boolean" ||
		typeof intent.runnable !== "boolean" ||
		(intent.workId !== undefined && !identity(intent.workId)) ||
		(intent.workRevision !== undefined && !identity(intent.workRevision)) ||
		(intent.workId === undefined) !== (intent.workRevision === undefined)
	)
		throw new FlowAdmissionError("identity", "Invalid admission intent.");
}
export function validateFlowChoice(choice: FlowAdmissionChoice): void {
	validateIntent(choice.intent);
	validateFlowAdmission(choice.next);
	if (
		choice.resultSnapshot !== undefined &&
		(!Array.isArray(choice.resultSnapshot) ||
			choice.resultSnapshot.length > 1024 ||
			choice.resultSnapshot.some(
				(item) =>
					!item ||
					!identity(item.id) ||
					!identity(item.revision) ||
					(item.producer !== undefined && !identity(item.producer)),
			) ||
			new Set(choice.resultSnapshot.map((item) => item.id)).size !== choice.resultSnapshot.length)
	)
		throw new FlowAdmissionError("schema", "Invalid result boundary snapshot.");
	if (
		choice.resultSamples !== undefined &&
		(!Array.isArray(choice.resultSamples) ||
			choice.resultSamples.length > 1024 ||
			choice.resultSamples.some(
				(item) =>
					!item ||
					!identity(item.id) ||
					!identity(item.revision) ||
					!choice.resultSnapshot?.some((candidate) => candidate.id === item.id && candidate.revision === item.revision),
			) ||
			new Set(choice.resultSamples.map((item) => item.id)).size !== choice.resultSamples.length)
	)
		throw new FlowAdmissionError("schema", "Invalid aggregate sample membership.");
	if (
		!Number.isSafeInteger(choice.revision) ||
		choice.revision < 0 ||
		choice.next.revision !== choice.revision + 1 ||
		!Array.isArray(choice.coalescedIds) ||
		choice.coalescedIds.length > 1024 ||
		choice.coalescedIds.some((id) => !identity(id)) ||
		new Set(choice.coalescedIds).size !== choice.coalescedIds.length
	)
		throw new FlowAdmissionError("schema", "Invalid admission choice.");
}

/** Select one eligible trigger. Producer state and host gates are authoritative inputs, not inferred from prose. */
export function chooseFlowIntent(
	state: FlowAdmissionState,
	intents: FlowIntent[],
	gates: FlowAdmissionGates,
): FlowAdmissionChoice | undefined {
	validateFlowAdmission(state);
	if (!Array.isArray(intents) || intents.length > 1024)
		throw new FlowAdmissionError("schema", "Admission exceeds 1024 retained intents.");
	const ids = new Set<string>();
	for (const intent of intents) {
		validateIntent(intent);
		if (ids.has(intent.id)) throw new FlowAdmissionError("identity", "Duplicate admission event identity.");
		ids.add(intent.id);
	}
	if (
		!gates ||
		typeof gates.hostReady !== "boolean" ||
		typeof gates.userPending !== "boolean" ||
		typeof gates.recoveryBlocked !== "boolean" ||
		!Array.isArray(gates.waitingWorkIds) ||
		gates.waitingWorkIds.some((id) => !identity(id)) ||
		(gates.retiredWorkHashes !== undefined &&
			(!Array.isArray(gates.retiredWorkHashes) ||
				gates.retiredWorkHashes.length > MAX_RETIRED_FLOW_IDENTITIES ||
				gates.retiredWorkHashes.some((hash) => !validRetiredIdentityHash(hash)))) ||
		(gates.inactiveWorkIds !== undefined &&
			(!Array.isArray(gates.inactiveWorkIds) || gates.inactiveWorkIds.some((id) => !identity(id))))
	)
		throw new FlowAdmissionError("schema", "Invalid admission gates.");
	if (!gates.hostReady || gates.userPending || gates.recoveryBlocked) return undefined;
	const waits = new Set(gates.waitingWorkIds);
	const inactive = new Set(gates.inactiveWorkIds);
	const retired = new Set(gates.retiredWorkHashes);
	const eligible = intents
		.filter((intent) => {
			if (!intent.runnable) return false;
			if (intent.rank <= 3) return true;
			if (intent.rank === 6) return waits.size === 0;
			return (
				!inactive.has(intent.workId ?? "") &&
				!retired.has(retiredIdentityHash(intent.workId ?? "")) &&
				!waits.has(intent.workId ?? "") &&
				(waits.size === 0 || intent.independent)
			);
		})
		.sort((a, b) => a.rank - b.rank || a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const unique: FlowIntent[] = [];
	const work = new Map<string, FlowIntent>();
	const duplicates = new Map<string, string[]>();
	for (const intent of eligible) {
		const key =
			(intent.rank === 4 || intent.rank === 5) && intent.workId
				? JSON.stringify([intent.workId, intent.workRevision])
				: undefined;
		const prior = key ? work.get(key) : undefined;
		if (prior) {
			const list = duplicates.get(prior.id) ?? [];
			list.push(intent.id);
			duplicates.set(prior.id, list);
			continue;
		}
		if (key) work.set(key, intent);
		unique.push(intent);
	}
	const next = structuredClone(state);
	for (const rank of ranks) {
		const candidates = unique.filter((intent) => intent.rank === rank);
		const producers = new Set(candidates.map((intent) => intent.producer));
		next.rounds[rank] = state.rounds[rank].filter((producer) => producers.has(producer));
		if (next.rounds[rank].length === 0) next.rounds[rank] = [...producers];
	}
	let rank: FlowRank | undefined;
	if (next.rounds[2].length) rank = 2;
	else if (next.rounds[3].length) rank = 3;
	else if (next.rounds[5].length && (state.cadenceDebt >= 4 || !next.rounds[4].length)) rank = 5;
	else if (next.rounds[4].length) rank = 4;
	else if (next.rounds[6].length) rank = 6;
	if (rank === undefined) return undefined;
	const producer = next.rounds[rank].shift();
	const intent = unique.find((item) => item.rank === rank && item.producer === producer);
	if (!intent) throw new FlowAdmissionError("schema", "Admission round lost its eligible intent.");
	if (rank === 5) next.cadenceDebt = 0;
	else if (rank === 4 && next.rounds[5].length) next.cadenceDebt++;
	next.revision++;
	return structuredClone({ revision: state.revision, intent, coalescedIds: duplicates.get(intent.id) ?? [], next });
}
