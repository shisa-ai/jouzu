import {
	type FlowAdmissionChoice,
	type FlowAdmissionState,
	initialFlowAdmission,
	validateFlowAdmission,
	validateFlowChoice,
} from "./admission.js";
import {
	emptyRetiredAttempts,
	type FlowRetiredAttempts,
	foldRetiredAttempts,
	retirableAttempts,
	validateRetiredAttempts,
} from "./attempt-retention.js";

export interface FlowScope {
	sessionId: string;
	branchId: string;
}

export interface FlowMember {
	id: string;
	revision: string;
	kind: "work" | "result" | "wait" | "user" | "alert";
	required: boolean;
	contentHash: string;
	sourceSubmission?: { id: string; revision: number };
	inputFrame?: { id: string; revision: string; parts: number; intact?: boolean };
}

export interface FlowInclusion {
	id: string;
	revision: string;
	disposition: "included" | "replaced" | "omitted" | "rejected";
	contentHash?: string;
}

export type FlowAttemptPhase =
	| "selected"
	| "queued"
	| "claimed"
	| "prepared"
	| "handed-off"
	| "running"
	| "settled"
	| "cancelled"
	| "withheld"
	| "uncertain";

export type FlowOutcome = "success" | "transient-failure" | "failure" | "aborted";

export interface FlowPayloadReceipt {
	api: string;
	hash: string;
	bytes: number;
	inclusion: FlowInclusion[];
}

export interface FlowRequest {
	id: string;
	inclusion: FlowInclusion[];
	containsUserInput: boolean;
	handedOff: boolean;
	payload?: FlowPayloadReceipt;
	outcome?: FlowOutcome;
}

export interface FlowAttempt {
	id: string;
	generation: number;
	phase: FlowAttemptPhase;
	consumed?: boolean;
	admission?: { choice: FlowAdmissionChoice; charged: boolean };
	members: FlowMember[];
	queue?: { id: string; revision: number };
	history: { id: string; revision: string; entryId: string; entryHash?: string }[];
	requests: FlowRequest[];
	outcome?: FlowOutcome;
	reason?: string;
}

export interface FlowLedgerState {
	schemaVersion: 1;
	scope: FlowScope;
	generation: number;
	revision: number;
	activeAttemptId?: string;
	admission?: FlowAdmissionState;
	attempts: FlowAttempt[];
	/** Carried forward for attempts no longer stored; absent until the first retirement. */
	retiredAttempts?: FlowRetiredAttempts;
}

/** Transactions must serialize read/modify/write and commit before resolving. */
export interface FlowLedgerStore {
	read(): Promise<FlowLedgerState | undefined>;
	transact<T>(update: (state: FlowLedgerState | undefined) => { state: FlowLedgerState; result: T }): Promise<T>;
}

export class FlowLedgerError extends Error {
	constructor(
		readonly code: "scope" | "schema" | "stale" | "busy" | "identity" | "transition" | "capacity",
		message: string,
	) {
		super(message);
		this.name = "FlowLedgerError";
	}
}

const terminal = new Set<FlowAttemptPhase>(["settled", "cancelled", "withheld", "uncertain"]);
const sameScope = (a: FlowScope, b: FlowScope) => a.sessionId === b.sessionId && a.branchId === b.branchId;
const memberKey = (member: { id: string; revision: string }) => JSON.stringify([member.id, member.revision]);

function requireIdentity(value: string): void {
	if (typeof value !== "string" || value.length === 0 || value.length > 512)
		throw new FlowLedgerError("identity", "Flow identities must contain 1–512 characters.");
}

function validateMembers(members: FlowMember[]): void {
	if (!Array.isArray(members) || members.length === 0 || members.length > 1024)
		throw new FlowLedgerError("capacity", "Flow attempts require 1–1024 members.");
	const keys = new Set<string>();
	for (const member of members) {
		if (!member || typeof member !== "object") throw new FlowLedgerError("schema", "Invalid flow member.");
		requireIdentity(member.id);
		requireIdentity(member.revision);
		if (member.sourceSubmission !== undefined) {
			requireIdentity(member.sourceSubmission?.id);
			if (!Number.isSafeInteger(member.sourceSubmission.revision) || member.sourceSubmission.revision < 1)
				throw new FlowLedgerError("identity", "Invalid source submission revision.");
		}
		if (member.inputFrame !== undefined) {
			requireIdentity(member.inputFrame?.id);
			requireIdentity(member.inputFrame.revision);
			if (
				!Number.isSafeInteger(member.inputFrame.parts) ||
				member.inputFrame.parts < 1 ||
				(member.inputFrame.intact !== undefined && typeof member.inputFrame.intact !== "boolean")
			)
				throw new FlowLedgerError("identity", "Invalid persisted input frame.");
		}
		if (!/^[a-f0-9]{64}$/.test(member.contentHash))
			throw new FlowLedgerError("identity", "Flow members require a SHA-256 content identity.");
		if (!["work", "result", "wait", "user", "alert"].includes(member.kind) || typeof member.required !== "boolean")
			throw new FlowLedgerError("identity", "Invalid flow member classification.");
		if (member.kind !== "result" && !member.required)
			throw new FlowLedgerError("identity", "Instructions and decisions must be required input.");
		if (keys.has(memberKey(member))) throw new FlowLedgerError("identity", "Duplicate flow attempt member.");
		keys.add(memberKey(member));
	}
}

function appendHistory(attempt: FlowAttempt, captured: FlowAttempt["history"]): void {
	for (const receipt of captured) {
		requireIdentity(receipt.entryId);
		if (receipt.entryHash !== undefined && !/^[a-f0-9]{64}$/.test(receipt.entryHash))
			throw new FlowLedgerError("identity", "Invalid history content hash.");
		if (!attempt.members.some((member) => memberKey(member) === memberKey(receipt)))
			throw new FlowLedgerError("identity", "History receipt has unknown membership.");
		const previous = attempt.history.find((item) => memberKey(item) === memberKey(receipt));
		if (
			previous &&
			(previous.entryId !== receipt.entryId ||
				(previous.entryHash !== undefined &&
					receipt.entryHash !== undefined &&
					previous.entryHash !== receipt.entryHash))
		)
			throw new FlowLedgerError("identity", "History receipt identity changed.");
		if (!previous) attempt.history.push(receipt);
		else if (receipt.entryHash !== undefined) previous.entryHash = receipt.entryHash;
	}
}

/** Durable handoff facts; admission policy and transport execution belong to the controller and host. */
export class FlowReceiptLedger {
	private constructor(
		private readonly store: FlowLedgerStore,
		readonly scope: FlowScope,
		readonly generation: number,
		private readonly limits: { maxAttempts: number; maxBytes: number },
	) {}

	static async attach(
		store: FlowLedgerStore,
		scope: FlowScope,
		limits = { maxAttempts: 1024, maxBytes: 1024 * 1024 },
	): Promise<FlowReceiptLedger> {
		requireIdentity(scope.sessionId);
		requireIdentity(scope.branchId);
		for (const limit of Object.values(limits))
			if (!Number.isSafeInteger(limit) || limit < 1)
				throw new FlowLedgerError("capacity", "Invalid flow ledger limit.");
		const captured = structuredClone(scope);
		const generation = await store.transact((previous) => {
			const state: FlowLedgerState = previous ?? {
				schemaVersion: 1,
				scope: captured,
				generation: 0,
				revision: 0,
				attempts: [],
			};
			FlowReceiptLedger.validate(state, captured, limits);
			state.admission ??= initialFlowAdmission();
			state.generation++;
			state.revision++;
			for (const attempt of state.attempts) {
				if (terminal.has(attempt.phase)) continue;
				attempt.phase = attempt.requests.some((request) => request.handedOff) ? "uncertain" : "cancelled";
				attempt.reason =
					attempt.phase === "uncertain"
						? "Request outcome unknown after attachment loss."
						: "Unsent handoff cancelled on reattachment.";
			}
			delete state.activeAttemptId;
			FlowReceiptLedger.validate(state, captured, limits);
			return { state, result: state.generation };
		});
		return new FlowReceiptLedger(store, captured, generation, { ...limits });
	}

	private static validate(state: FlowLedgerState, scope: FlowScope, limits: { maxAttempts: number; maxBytes: number }) {
		if (state.admission !== undefined) validateFlowAdmission(state.admission);
		if (state.schemaVersion !== 1) throw new FlowLedgerError("schema", "Unsupported flow ledger schema.");
		if (!state.scope || !sameScope(state.scope, scope))
			throw new FlowLedgerError("scope", "Flow ledger belongs to another session or branch.");
		if (
			!Number.isSafeInteger(state.generation) ||
			state.generation < 0 ||
			!Number.isSafeInteger(state.revision) ||
			state.revision < 0 ||
			!Array.isArray(state.attempts)
		)
			throw new FlowLedgerError("schema", "Invalid flow ledger state.");
		const identities = new Set<string>();
		const requestIds = new Set<string>();
		const active = state.attempts.filter((attempt) => attempt && !terminal.has(attempt.phase));
		if (active.length > 1 || active[0]?.id !== state.activeAttemptId)
			throw new FlowLedgerError("schema", "Invalid active flow reservation.");
		for (const attempt of state.attempts) {
			if (!attempt || typeof attempt !== "object") throw new FlowLedgerError("schema", "Invalid flow attempt.");
			requireIdentity(attempt.id);
			if (identities.has(attempt.id)) throw new FlowLedgerError("schema", "Duplicate flow attempt identity.");
			identities.add(attempt.id);
			if (
				!Number.isSafeInteger(attempt.generation) ||
				attempt.generation < 1 ||
				attempt.generation > state.generation ||
				![
					"selected",
					"queued",
					"claimed",
					"prepared",
					"handed-off",
					"running",
					"settled",
					"cancelled",
					"withheld",
					"uncertain",
				].includes(attempt.phase)
			)
				throw new FlowLedgerError("schema", "Invalid flow attempt state.");
			validateMembers(attempt.members);
			if (!Array.isArray(attempt.history) || !Array.isArray(attempt.requests))
				throw new FlowLedgerError("schema", "Invalid flow receipts.");
			if (attempt.queue) {
				requireIdentity(attempt.queue.id);
				if (!Number.isSafeInteger(attempt.queue.revision) || attempt.queue.revision < 0)
					throw new FlowLedgerError("schema", "Invalid persisted queue revision.");
			}
			const histories = new Set<string>();
			for (const receipt of attempt.history) {
				if (
					!receipt ||
					!attempt.members.some((item) => memberKey(item) === memberKey(receipt)) ||
					histories.has(memberKey(receipt))
				)
					throw new FlowLedgerError("schema", "Invalid persisted history membership.");
				requireIdentity(receipt.entryId);
				if (receipt.entryHash !== undefined && !/^[a-f0-9]{64}$/.test(receipt.entryHash))
					throw new FlowLedgerError("identity", "Invalid history content hash.");
				histories.add(memberKey(receipt));
			}
			for (const request of attempt.requests) {
				if (!request || typeof request !== "object") throw new FlowLedgerError("schema", "Invalid persisted request.");
				requireIdentity(request.id);
				if (requestIds.has(request.id)) throw new FlowLedgerError("schema", "Duplicate request identity.");
				requestIds.add(request.id);
				if (
					typeof request.handedOff !== "boolean" ||
					typeof request.containsUserInput !== "boolean" ||
					!Array.isArray(request.inclusion)
				)
					throw new FlowLedgerError("schema", "Invalid persisted request state.");
				if (request.payload !== undefined) {
					if (!request.payload || typeof request.payload !== "object")
						throw new FlowLedgerError("schema", "Invalid persisted payload receipt.");
					requireIdentity(request.payload.api);
					if (
						!/^[a-f0-9]{64}$/.test(request.payload.hash) ||
						!Number.isSafeInteger(request.payload.bytes) ||
						request.payload.bytes < 1 ||
						!Array.isArray(request.payload.inclusion)
					)
						throw new FlowLedgerError("schema", "Invalid persisted payload receipt.");
				}
				for (const inclusion of [request.inclusion, ...(request.payload ? [request.payload.inclusion] : [])]) {
					const members = new Set<string>();
					for (const receipt of inclusion) {
						const original = receipt && attempt.members.find((item) => memberKey(item) === memberKey(receipt));
						if (
							!original ||
							members.has(memberKey(receipt)) ||
							!["included", "replaced", "omitted", "rejected"].includes(receipt.disposition) ||
							(receipt.disposition === "included" && receipt.contentHash !== original.contentHash)
						)
							throw new FlowLedgerError("schema", "Invalid persisted inclusion.");
						members.add(memberKey(receipt));
					}
					if (members.size !== attempt.members.length)
						throw new FlowLedgerError("schema", "Incomplete persisted inclusion.");
				}
				if (
					request.outcome !== undefined &&
					(!["success", "transient-failure", "failure", "aborted"].includes(request.outcome) || !request.handedOff)
				)
					throw new FlowLedgerError("schema", "Invalid persisted request outcome.");
			}
			if (
				attempt.outcome !== undefined &&
				!["success", "transient-failure", "failure", "aborted"].includes(attempt.outcome)
			)
				throw new FlowLedgerError("schema", "Invalid run outcome.");
			if (attempt.admission !== undefined) {
				validateFlowChoice(attempt.admission.choice);
				if (typeof attempt.admission.charged !== "boolean")
					throw new FlowLedgerError("schema", "Invalid admission charge receipt.");
			}
			if (attempt.consumed !== undefined && typeof attempt.consumed !== "boolean")
				throw new FlowLedgerError("schema", "Invalid native consumption fact.");
			if (
				attempt.consumed === false &&
				(attempt.history.length ||
					attempt.requests.length ||
					["claimed", "prepared", "handed-off", "running", "settled"].includes(attempt.phase))
			)
				throw new FlowLedgerError("schema", "Native consumption fact contradicts request receipts.");
			const last = attempt.requests.at(-1);
			if (
				(attempt.phase === "handed-off" && (!last?.handedOff || last.outcome !== undefined)) ||
				(attempt.phase === "prepared" && (!last || last.handedOff)) ||
				(attempt.phase === "settled" && attempt.outcome === undefined)
			)
				throw new FlowLedgerError("schema", "Inconsistent persisted request phase.");
		}
		if (state.retiredAttempts !== undefined)
			try {
				validateRetiredAttempts(state.retiredAttempts);
			} catch (error) {
				throw new FlowLedgerError("schema", error instanceof Error ? error.message : "Invalid retired attempts.");
			}
		if (
			state.attempts.length > limits.maxAttempts ||
			new TextEncoder().encode(JSON.stringify(state)).length > limits.maxBytes
		)
			throw new FlowLedgerError("capacity", "Flow receipt retention limit reached; work remains held.");
	}

	async snapshot(): Promise<FlowLedgerState> {
		const state = await this.store.read();
		if (!state) throw new FlowLedgerError("schema", "Flow ledger is missing.");
		FlowReceiptLedger.validate(state, this.scope, this.limits);
		return structuredClone(state);
	}

	private mutate<T>(update: (state: FlowLedgerState) => T): Promise<T> {
		return this.store.transact((state) => {
			if (!state) throw new FlowLedgerError("schema", "Flow ledger is missing.");
			FlowReceiptLedger.validate(state, this.scope, this.limits);
			if (state.generation !== this.generation)
				throw new FlowLedgerError("stale", "Flow attachment has been replaced.");
			const result = update(state);
			state.revision++;
			FlowReceiptLedger.validate(state, this.scope, this.limits);
			return { state, result };
		});
	}

	private attempt(state: FlowLedgerState, id: string, phases: FlowAttemptPhase[]): FlowAttempt {
		const attempt = state.attempts.find((item) => item.id === id);
		if (!attempt || attempt.generation !== this.generation)
			throw new FlowLedgerError("identity", "Unknown flow attempt for this attachment.");
		if (!phases.includes(attempt.phase)) throw new FlowLedgerError("transition", `Flow attempt is ${attempt.phase}.`);
		return attempt;
	}

	select(id: string, members: FlowMember[], choice?: FlowAdmissionChoice): Promise<void> {
		requireIdentity(id);
		const captured = structuredClone(members);
		validateMembers(captured);
		const admission = choice === undefined ? undefined : structuredClone(choice);
		if (admission) validateFlowChoice(admission);
		return this.mutate((state) => {
			if (state.activeAttemptId) throw new FlowLedgerError("busy", "A flow handoff is already active.");
			if (state.attempts.some((item) => item.id === id))
				throw new FlowLedgerError("identity", "Flow attempt ID was already used.");
			if (
				admission &&
				((state.admission ?? initialFlowAdmission()).revision !== admission.revision ||
					!captured.some(
						(member) => member.id === admission.intent.id && member.revision === admission.intent.revision,
					))
			)
				throw new FlowLedgerError("stale", "Admission choice no longer matches policy or selected membership.");
			state.attempts.push({
				id,
				generation: this.generation,
				phase: "selected",
				consumed: false,
				...(admission ? { admission: { choice: admission, charged: false } } : {}),
				members: captured,
				history: [],
				requests: [],
			});
			state.activeAttemptId = id;
		});
	}

	queued(id: string, queue: { id: string; revision: number }): Promise<void> {
		requireIdentity(queue.id);
		if (!Number.isSafeInteger(queue.revision) || queue.revision < 0)
			throw new FlowLedgerError("identity", "Invalid queue revision.");
		const captured = { ...queue };
		return this.mutate((state) => {
			const attempt = this.attempt(state, id, ["selected"]);
			attempt.queue = captured;
			attempt.phase = "queued";
		});
	}

	claim(id: string, queue: { id: string; revision: number }): Promise<void> {
		const captured = { ...queue };
		return this.mutate((state) => {
			const attempt = this.attempt(state, id, ["queued"]);
			if (attempt.queue?.id !== captured.id || attempt.queue.revision !== captured.revision)
				throw new FlowLedgerError("stale", "Queue item changed before claim.");
			attempt.phase = "claimed";
			attempt.consumed = true;
		});
	}

	history(id: string, receipts: FlowAttempt["history"]): Promise<void> {
		const captured = structuredClone(receipts);
		return this.mutate((state) => {
			const attempt = this.attempt(state, id, ["claimed", "prepared", "handed-off", "running", "settled", "withheld"]);
			appendHistory(attempt, captured);
		});
	}

	/** Add verified historical facts after reattachment without reopening dispatch ownership. */
	recoverHistory(id: string, receipts: FlowAttempt["history"]): Promise<void> {
		const captured = structuredClone(receipts);
		return this.mutate((state) => {
			if (state.activeAttemptId) throw new FlowLedgerError("busy", "History recovery requires an idle ledger.");
			const attempt = state.attempts.find((item) => item.id === id);
			if (!attempt || !terminal.has(attempt.phase) || attempt.consumed !== true)
				throw new FlowLedgerError("transition", "History recovery requires an inactive consumed attempt.");
			if (captured.some((receipt) => !receipt.entryHash))
				throw new FlowLedgerError("identity", "Recovered history requires verified content hashes.");
			appendHistory(attempt, captured);
		});
	}

	prepare(id: string, requestId: string, inclusion: FlowInclusion[], containsUserInput: boolean): Promise<boolean> {
		requireIdentity(requestId);
		const captured = structuredClone(inclusion);
		return this.mutate((state) => {
			const attempt = this.attempt(state, id, ["claimed", "running"]);
			if (attempt.reason) throw new FlowLedgerError("transition", "Filtered run must settle before correction.");
			if (state.attempts.some((other) => other.requests.some((request) => request.id === requestId)))
				throw new FlowLedgerError("identity", "Request ID was already used.");
			const keys = new Set(captured.map(memberKey));
			if (
				keys.size !== captured.length ||
				captured.length !== attempt.members.length ||
				attempt.members.some((member) => !keys.has(memberKey(member)))
			)
				throw new FlowLedgerError("identity", "Final inclusion must describe every member exactly once.");
			for (const receipt of captured) {
				if (!["included", "replaced", "omitted", "rejected"].includes(receipt.disposition))
					throw new FlowLedgerError("identity", "Invalid inclusion disposition.");
				const member = attempt.members.find((item) => memberKey(item) === memberKey(receipt));
				if (receipt.disposition === "included" && receipt.contentHash !== member?.contentHash)
					throw new FlowLedgerError("identity", "Included content does not match its membership identity.");
			}
			attempt.requests.push({ id: requestId, inclusion: captured, containsUserInput, handedOff: false });
			const rejected = attempt.members.some(
				(member) =>
					(member.required &&
						captured.find((item) => memberKey(item) === memberKey(member))?.disposition !== "included") ||
					(member.inputFrame?.intact &&
						captured.some(
							(item) => memberKey(item) === memberKey(member) && ["replaced", "rejected"].includes(item.disposition),
						)),
			);
			const empty = !captured.some((item) => item.disposition === "included");
			attempt.phase = rejected || empty ? "withheld" : "prepared";
			if (attempt.phase === "withheld") {
				attempt.reason = rejected
					? "Required input or intact aggregate metadata was filtered."
					: "No composed input survived filtering.";
				if (attempt.requests.some((request) => request.handedOff)) attempt.phase = "running";
				else delete state.activeAttemptId;
			}
			return attempt.phase === "prepared";
		});
	}

	/** Final provider conversion evidence, separate from the earlier model-message snapshot. */
	payload(id: string, requestId: string, receipt: FlowPayloadReceipt): Promise<boolean> {
		const captured = structuredClone(receipt);
		return this.mutate((state) => {
			const attempt = this.attempt(state, id, ["prepared"]);
			const request = attempt.requests.at(-1);
			if (!request || request.id !== requestId || request.payload)
				throw new FlowLedgerError("identity", "Payload request is unknown or already recorded.");
			request.payload = captured;
			const admitted =
				captured.inclusion.some((item) => item.disposition === "included") &&
				attempt.members.every(
					(member) =>
						(!member.required ||
							captured.inclusion.some(
								(item) => memberKey(item) === memberKey(member) && item.disposition === "included",
							)) &&
						(!member.inputFrame?.intact ||
							!captured.inclusion.some(
								(item) => memberKey(item) === memberKey(member) && ["replaced", "rejected"].includes(item.disposition),
							)),
				);
			if (admitted && attempt.admission && !attempt.admission.charged) {
				const { choice } = attempt.admission;
				if ((state.admission ?? initialFlowAdmission()).revision !== choice.revision)
					throw new FlowLedgerError("stale", "Admission policy changed before final inclusion.");
				if (
					captured.inclusion.some(
						(item) =>
							item.id === choice.intent.id &&
							item.revision === choice.intent.revision &&
							item.disposition === "included",
					)
				) {
					state.admission = structuredClone(choice.next);
					attempt.admission.charged = true;
				}
			}
			if (!admitted) {
				attempt.reason = "Provider payload filtered composed input.";
				attempt.phase = attempt.requests.some((item) => item.handedOff) ? "running" : "withheld";
				if (attempt.phase === "withheld") delete state.activeAttemptId;
			}
			return admitted;
		});
	}

	/** A request failed before its external-effect intent; earlier requests still own the run. */
	withholdRequest(id: string, requestId: string, reason: string): Promise<void> {
		requireIdentity(reason);
		return this.mutate((state) => {
			const attempt = this.attempt(state, id, ["prepared"]);
			const request = attempt.requests.at(-1);
			if (!request || request.id !== requestId || request.handedOff)
				throw new FlowLedgerError("identity", "Unknown unsent request.");
			attempt.reason = reason;
			attempt.phase = attempt.requests.some((item) => item.handedOff) ? "running" : "withheld";
			if (attempt.phase === "withheld") delete state.activeAttemptId;
		});
	}

	handoff(id: string, requestId: string): Promise<void> {
		return this.mutate((state) => {
			const attempt = this.attempt(state, id, ["prepared"]);
			const request = attempt.requests.at(-1);
			if (!request || request.id !== requestId)
				throw new FlowLedgerError("identity", "Request identity changed before handoff.");
			request.handedOff = true;
			attempt.phase = "handed-off";
		});
	}

	requestOutcome(id: string, requestId: string, outcome: FlowOutcome): Promise<void> {
		return this.mutate((state) => {
			const attempt = this.attempt(state, id, ["handed-off"]);
			const request = attempt.requests.at(-1);
			if (!request || request.id !== requestId) throw new FlowLedgerError("identity", "Unknown request outcome.");
			request.outcome = outcome;
			attempt.phase = "running";
		});
	}

	/** Host abort-and-join proves inactivity, but not the missing external outcome. */
	uncertain(id: string, reason: string): Promise<void> {
		requireIdentity(reason);
		return this.mutate((state) => {
			const attempt = this.attempt(state, id, ["handed-off"]);
			attempt.phase = "uncertain";
			attempt.reason = reason;
			delete state.activeAttemptId;
		});
	}

	/** Called only after host run settlement or abort-and-join, including native retries and tools. */
	settle(id: string, outcome: FlowOutcome): Promise<void> {
		return this.mutate((state) => {
			const attempt = this.attempt(state, id, ["running"]);
			attempt.outcome = outcome;
			attempt.phase = "settled";
			delete state.activeAttemptId;
		});
	}

	/**
	 * Drop settled and cancelled attempts, folding their replay fences, iteration counts, and
	 * producer round into the carried summary. Keeps the most recent settled attempts addressable.
	 */
	retire(
		keep = 32,
		protectedMembers: ReadonlySet<string> = new Set(),
		assertCurrent: () => void = () => {},
	): Promise<number> {
		if (!Number.isSafeInteger(keep) || keep < 0) throw new FlowLedgerError("capacity", "Invalid retention window.");
		return this.mutate((state) => {
			const retiring = retirableAttempts(state, keep).filter(
				(attempt) => !attempt.members.some((member) => protectedMembers.has(member.id)),
			);
			assertCurrent();
			if (!retiring.length) return 0;
			const ids = new Set(retiring.map((attempt) => attempt.id));
			state.retiredAttempts = foldRetiredAttempts(state.retiredAttempts ?? emptyRetiredAttempts(), state, retiring);
			state.attempts = state.attempts.filter((attempt) => !ids.has(attempt.id));
			return retiring.length;
		});
	}

	cancel(id: string, reason: string): Promise<void> {
		requireIdentity(reason);
		return this.mutate((state) => {
			const attempt = this.attempt(state, id, ["selected", "queued", "claimed", "prepared", "cancelled"]);
			if (attempt.requests.some((request) => request.handedOff))
				throw new FlowLedgerError("transition", "Started runs require host settlement before cancellation.");
			attempt.phase = "cancelled";
			attempt.reason = reason;
			if (state.activeAttemptId === id) delete state.activeAttemptId;
		});
	}
}
