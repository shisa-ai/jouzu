import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Session, setValue, value, type Write } from "@earendil-works/pi-agent-core";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { FlowOwnership } from "./ownership.js";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";

type Submission = Parameters<NonNullable<CreateAgentSessionOptions["flowIngress"]>["submit"]>[0];
// Tagged containers preserve undefined positional arguments through Pi's JSONL codec.
type Encoded =
	| null
	| boolean
	| number
	| string
	| ["undefined"]
	| ["array", Encoded[]]
	| ["object", [string, Encoded][]];
export interface FlowAdmissionHold {
	phase: "submission" | "queue";
	reason: string;
	queue?: { id: string; revision: number };
}
interface RecordData {
	id: string;
	revision: number;
	status: "retained" | "cancelled";
	acceptedAt: number;
	holds?: FlowAdmissionHold[];
	digest: string;
	payload: Encoded;
	dispatch?: Omit<FlowSubmissionDispatch, "inputs"> & { inputs?: { payload: Encoded; digest: string }[] };
}
export interface FlowNativeInput {
	kind: "prompt" | "context" | "steer" | "followUp";
	args: unknown[];
	queue?: { id: string; revision: number };
}
export interface FlowNativeObserver {
	observe(input: FlowNativeInput): Promise<number>;
}
export interface FlowSubmissionDispatch {
	operationId: string;
	ownerId: string;
	phase: "started" | "returned" | "failed";
	inputs?: FlowNativeInput[];
	queueCancellations?: { id: string; revision: number }[];
	queueClaims?: { id: string; revision: number; consumed: boolean }[];
	queueHistory?: FlowNativeQueueHistory[];
	promptHistory?: FlowNativePromptHistory[];
	promptClaims?: { inputIndex: number; messageIndex: number }[];
}
export interface FlowNativePromptHistory {
	inputIndex: number;
	messageIndex: number;
	entryId: string;
	entryHash: string;
}
export interface FlowNativeQueueHistory {
	id: string;
	revision: number;
	entryId: string;
	entryHash: string;
}
interface State {
	version: 1;
	scope: FlowScope;
	revision: number;
	records: RecordData[];
}
export interface RetainedSubmission {
	id: string;
	revision: number;
	status: "retained" | "cancelled";
	acceptedAt: number;
	holds?: FlowAdmissionHold[];
	submission: Submission;
	dispatch?: FlowSubmissionDispatch;
}
type Header = Omit<State, "records"> & { recordIds: string[] };
const address = value<Header>("jouzu.flow.submissions", "v1");
const recordAddress = (id: string) => value<RecordData>("jouzu.flow.submission", id);
const digest = (payload: Encoded) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");
const identity = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 512;
function validateHold(hold: FlowAdmissionHold): void {
	if (
		!hold ||
		!["submission", "queue"].includes(hold.phase) ||
		typeof hold.reason !== "string" ||
		!hold.reason.trim() ||
		Buffer.byteLength(hold.reason) > 1024 ||
		(hold.phase === "submission"
			? hold.queue !== undefined
			: !hold.queue ||
				!identity(hold.queue.id) ||
				!Number.isSafeInteger(hold.queue.revision) ||
				hold.queue.revision < 1)
	)
		throw new FlowLedgerError("schema", "Invalid native admission hold.");
}
const holdKey = (hold: Pick<FlowAdmissionHold, "phase" | "queue">) =>
	JSON.stringify([hold.phase, hold.queue?.id, hold.queue?.revision]);

function validateNativeInput(input: FlowNativeInput): void {
	if (
		!input ||
		!["prompt", "context", "steer", "followUp"].includes(input.kind) ||
		!Array.isArray(input.args) ||
		(["prompt", "context"].includes(input.kind)
			? input.queue !== undefined
			: !input.queue ||
				!identity(input.queue.id) ||
				!Number.isSafeInteger(input.queue.revision) ||
				input.queue.revision < 1)
	)
		throw new FlowLedgerError("schema", "Invalid native input observation.");
}

function encode(input: unknown, ancestors = new Set<object>(), depth = 0): Encoded {
	if (depth > 64) throw new FlowLedgerError("capacity", "Flow submission nesting exceeds 64 levels.");
	if (input === undefined) return ["undefined"];
	if (input === null || typeof input === "string" || typeof input === "boolean") return input;
	if (typeof input === "number" && Number.isFinite(input) && !Object.is(input, -0)) return input;
	if (typeof input !== "object" || input === null || ancestors.has(input))
		throw new FlowLedgerError("schema", "Flow submission contains unsupported persistent data.");
	if (
		!Array.isArray(input) &&
		Object.getPrototypeOf(input) !== Object.prototype &&
		Object.getPrototypeOf(input) !== null
	)
		throw new FlowLedgerError("schema", "Flow submission requires plain persistent objects.");
	if (Object.getOwnPropertySymbols(input).length)
		throw new FlowLedgerError("schema", "Flow submission cannot persist symbol properties.");
	ancestors.add(input);
	try {
		if (Array.isArray(input)) return ["array", Array.from(input, (item) => encode(item, ancestors, depth + 1))];
		return [
			"object",
			Object.keys(input)
				.sort()
				.map((key) => [key, encode((input as Record<string, unknown>)[key], ancestors, depth + 1)]),
		];
	} finally {
		ancestors.delete(input);
	}
}
function decode(input: Encoded, depth = 0): unknown {
	if (depth > 64) throw new FlowLedgerError("schema", "Invalid stored submission nesting.");
	if (!Array.isArray(input)) {
		if (
			input === null ||
			typeof input === "string" ||
			typeof input === "boolean" ||
			(typeof input === "number" && Number.isFinite(input))
		)
			return input;
		throw new FlowLedgerError("schema", "Invalid stored submission value.");
	}
	if (input[0] === "undefined" && input.length === 1) return undefined;
	if (input.length !== 2 || !Array.isArray(input[1]))
		throw new FlowLedgerError("schema", "Invalid stored submission container.");
	if (input[0] === "array") return input[1].map((item) => decode(item, depth + 1));
	if (input[0] === "object") {
		const keys = new Set();
		return Object.fromEntries(
			input[1].map((pair) => {
				if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || keys.has(pair[0]))
					throw new FlowLedgerError("schema", "Invalid stored submission object.");
				keys.add(pair[0]);
				return [pair[0], decode(pair[1], depth + 1)];
			}),
		);
	}
	throw new FlowLedgerError("schema", "Unknown stored submission container.");
}
function validateSubmission(input: Submission, scope: FlowScope): void {
	if (
		input?.version !== 1 ||
		!identity(input.id) ||
		!["prompt", "steer", "followUp", "sendCustomMessage", "sendUserMessage"].includes(input.api) ||
		!Array.isArray(input.args) ||
		!input.origin ||
		!["host", "sdk", "extension"].includes(input.origin.kind) ||
		!identity(input.origin.id) ||
		(input.hostState !== undefined && (!input.hostState || typeof input.hostState.streaming !== "boolean")) ||
		!input.scope ||
		input.scope.sessionId !== scope.sessionId ||
		!identity(input.scope.attachmentId) ||
		(input.scope.leafId !== null && !identity(input.scope.leafId))
	)
		throw new FlowLedgerError("schema", "Invalid submission identity or session scope.");
	if (
		input.userCommand &&
		(!identity(input.userCommand.id) || !identity(input.userCommand.name) || !identity(input.userCommand.submissionId))
	)
		throw new FlowLedgerError("schema", "Invalid submission command identity.");
}

/** Durable opaque ingress only. Admission and executable queue ownership remain with the controller and Pi. */
export class FlowSubmissionStore {
	private initialized = false;
	get scope(): Readonly<FlowScope> {
		return this.ownership.scope;
	}
	static async attach(
		session: Session,
		ownership: FlowOwnership,
		limits = { maxRecords: 1024, maxBytes: 4 * 1024 * 1024 },
	): Promise<FlowSubmissionStore> {
		const store = new FlowSubmissionStore(session, ownership, { ...limits });
		await store.transact(() => ({ changed: true, result: undefined }));
		store.initialized = true;
		return store;
	}
	private constructor(
		private readonly session: Session,
		private readonly ownership: FlowOwnership,
		private readonly limits = { maxRecords: 1024, maxBytes: 4 * 1024 * 1024 },
	) {
		for (const limit of Object.values(limits))
			if (!Number.isSafeInteger(limit) || limit < 1)
				throw new FlowLedgerError("capacity", "Invalid submission retention limit.");
	}
	private validate(state: State): void {
		if (
			state?.version !== 1 ||
			state.scope?.sessionId !== this.ownership.scope.sessionId ||
			state.scope?.branchId !== this.ownership.scope.branchId ||
			!Number.isSafeInteger(state.revision) ||
			state.revision < 0 ||
			!Array.isArray(state.records)
		)
			throw new FlowLedgerError("schema", "Invalid retained submission state.");
		if (
			state.records.length > this.limits.maxRecords ||
			Buffer.byteLength(JSON.stringify(state)) > this.limits.maxBytes
		)
			throw new FlowLedgerError("capacity", "Submission retention limit reached; admission is held.");
		const ids = new Set();
		const operationIds = new Set();
		for (const record of state.records) {
			if (
				!record ||
				!identity(record.id) ||
				ids.has(record.id) ||
				!Number.isSafeInteger(record.revision) ||
				record.revision < 1 ||
				!["retained", "cancelled"].includes(record.status) ||
				!Number.isSafeInteger(record.acceptedAt) ||
				record.acceptedAt < 0 ||
				record.digest !== digest(record.payload)
			)
				throw new FlowLedgerError("schema", "Invalid retained submission record.");
			ids.add(record.id);
			if (
				record.dispatch !== undefined &&
				(!record.dispatch ||
					!identity(record.dispatch.operationId) ||
					!identity(record.dispatch.ownerId) ||
					operationIds.has(record.dispatch.operationId) ||
					!["started", "returned", "failed"].includes(record.dispatch.phase))
			)
				throw new FlowLedgerError("schema", "Invalid retained dispatch state.");
			if (record.dispatch) operationIds.add(record.dispatch.operationId);
			const inputs = record.dispatch?.inputs;
			if (inputs !== undefined) {
				if (!Array.isArray(inputs) || inputs.length > 64)
					throw new FlowLedgerError("capacity", "Native input observation limit exceeded.");
				for (const input of inputs) {
					if (!input || input.digest !== digest(input.payload))
						throw new FlowLedgerError("identity", "Native input observation changed.");
					validateNativeInput(decode(input.payload) as FlowNativeInput);
				}
			}
			const submission = decode(record.payload) as Submission;
			const claims = record.dispatch?.queueClaims;
			if (claims !== undefined) {
				if (!Array.isArray(claims) || claims.length > 64)
					throw new FlowLedgerError("schema", "Invalid native queue claim receipts.");
				const claimed = new Set<string>();
				const consumedIds = new Set<string>();
				for (const claim of claims) {
					if (
						!claim ||
						!identity(claim.id) ||
						!Number.isSafeInteger(claim.revision) ||
						claim.revision < 1 ||
						typeof claim.consumed !== "boolean" ||
						claimed.has(JSON.stringify([claim.id, claim.revision])) ||
						(claim.consumed && consumedIds.has(claim.id)) ||
						(inputs ?? []).filter((input) => {
							const queue = (decode(input.payload) as FlowNativeInput).queue;
							return queue?.id === claim.id && queue.revision === claim.revision;
						}).length !== 1
					)
						throw new FlowLedgerError("identity", "Native queue receipt does not identify one observed input.");
					claimed.add(JSON.stringify([claim.id, claim.revision]));
					if (claim.consumed) consumedIds.add(claim.id);
				}
			}
			const cancellations = record.dispatch?.queueCancellations;
			if (cancellations !== undefined) {
				if (
					!Array.isArray(cancellations) ||
					cancellations.length > 64 ||
					new Set(cancellations.map((item) => item?.id)).size !== cancellations.length
				)
					throw new FlowLedgerError("schema", "Invalid native queue cancellations.");
				for (const item of cancellations) {
					if (
						!item ||
						!identity(item.id) ||
						!Number.isSafeInteger(item.revision) ||
						item.revision < 1 ||
						!(inputs ?? []).some((entry) => {
							const input = decode(entry.payload) as FlowNativeInput;
							return input.queue?.id === item.id && input.queue.revision === item.revision;
						})
					)
						throw new FlowLedgerError("identity", "Queue cancellation does not identify retained input.");
				}
			}

			const history = record.dispatch?.queueHistory;
			if (history !== undefined) {
				if (!Array.isArray(history) || history.length > 64)
					throw new FlowLedgerError("schema", "Invalid native queue history receipts.");
				const queues = new Set<string>();
				const entries = new Set<string>();
				for (const receipt of history) {
					if (
						!receipt ||
						!identity(receipt.entryId) ||
						typeof receipt.entryHash !== "string" ||
						!/^[a-f0-9]{64}$/.test(receipt.entryHash) ||
						queues.has(receipt.id) ||
						entries.has(receipt.entryId) ||
						!claims?.some((claim) => claim.id === receipt.id && claim.revision === receipt.revision && claim.consumed)
					)
						throw new FlowLedgerError("identity", "Native history does not identify one consumed queue input.");
					queues.add(receipt.id);
					entries.add(receipt.entryId);
				}
			}
			for (const [prompts, isHistory] of [
				[record.dispatch?.promptClaims, false],
				[record.dispatch?.promptHistory, true],
			] as const) {
				if (prompts === undefined) continue;
				if (!Array.isArray(prompts) || prompts.length > 1024)
					throw new FlowLedgerError("capacity", "Native prompt history limit exceeded.");
				const positions = new Set<string>();
				const entries = new Set<string>();
				for (const receipt of prompts) {
					const stored = inputs?.[receipt?.inputIndex];
					const input = stored ? (decode(stored.payload) as FlowNativeInput) : undefined;
					const count = Array.isArray(input?.args[0]) ? input.args[0].length : 1;
					const key = `${receipt?.inputIndex}:${receipt?.messageIndex}`;
					if (
						!receipt ||
						!Number.isSafeInteger(receipt.inputIndex) ||
						receipt.inputIndex < 0 ||
						!input ||
						!["prompt", "context"].includes(input.kind) ||
						!Number.isSafeInteger(receipt.messageIndex) ||
						receipt.messageIndex < 0 ||
						receipt.messageIndex >= count ||
						positions.has(key) ||
						(isHistory &&
							(!("entryId" in receipt) ||
								!identity(receipt.entryId) ||
								!("entryHash" in receipt) ||
								typeof receipt.entryHash !== "string" ||
								!/^[a-f0-9]{64}$/.test(receipt.entryHash) ||
								entries.has(receipt.entryId as string) ||
								!record.dispatch?.promptClaims?.some(
									(claim) => claim.inputIndex === receipt.inputIndex && claim.messageIndex === receipt.messageIndex,
								)))
					)
						throw new FlowLedgerError("identity", "Native prompt history does not identify one observed message.");
					positions.add(key);
					if ("entryId" in receipt) entries.add(receipt.entryId as string);
				}
			}
			if (record.holds !== undefined) {
				if (!Array.isArray(record.holds) || record.holds.length > 65)
					throw new FlowLedgerError("capacity", "Native admission hold limit exceeded.");
				const keys = new Set<string>();
				for (const hold of record.holds) {
					validateHold(hold);
					const key = holdKey(hold);
					if (
						keys.has(key) ||
						(hold.queue &&
							!(inputs ?? []).some((item) => {
								const input = decode(item.payload) as FlowNativeInput;
								return input.queue?.id === hold.queue?.id && input.queue?.revision === hold.queue?.revision;
							}))
					)
						throw new FlowLedgerError("identity", "Admission hold does not identify one retained input.");
					keys.add(key);
				}
			}

			validateSubmission(submission, this.ownership.scope);
			if (submission.id !== record.id) throw new FlowLedgerError("identity", "Stored submission identity changed.");
		}
	}
	private transact<T>(update: (state: State) => { result: T; changed: boolean }): Promise<T> {
		return this.ownership.run(() =>
			this.session.mutate(async (mutation, context) => {
				const header = (await mutation.getValue(address, context))?.value;
				if (!header && this.initialized) throw new FlowLedgerError("schema", "Retained submission state is missing.");
				if (
					header &&
					(!Array.isArray(header.recordIds) ||
						header.recordIds.length > this.limits.maxRecords ||
						header.recordIds.some((id) => !identity(id)) ||
						new Set(header.recordIds).size !== header.recordIds.length)
				)
					throw new FlowLedgerError("schema", "Invalid submission manifest.");
				const records = await Promise.all(
					(header?.recordIds ?? []).map(async (id) => {
						const record = (await mutation.getValue(recordAddress(id), context))?.value;
						if (!record || record.id !== id)
							throw new FlowLedgerError("schema", "Submission manifest has missing content.");
						return record;
					}),
				);
				const state: State = structuredClone(
					header
						? { version: header.version, scope: header.scope, revision: header.revision, records }
						: { version: 1, scope: this.ownership.scope, revision: 0, records: [] },
				);
				this.validate(state);
				const { result, changed } = update(state);
				if (changed) {
					state.revision++;
					this.validate(state);
					const { records: updated, ...metadata } = state;
					const writes: Write[] = [setValue(address, { ...metadata, recordIds: updated.map((record) => record.id) })];
					const previous = new Map(records.map((record) => [record.id, JSON.stringify(record)]));
					for (const record of updated)
						if (previous.get(record.id) !== JSON.stringify(record))
							writes.push(setValue(recordAddress(record.id), record));
					await mutation.commit(writes, context);
				}
				return result;
			}, BACKGROUND_CONTEXT),
		);
	}
	retain(
		submission: Submission,
	): Promise<{ id: string; revision: number; status: "retained" | "cancelled"; duplicate: boolean }> {
		validateSubmission(submission, this.ownership.scope);
		const id = submission.id;
		const payload = encode(submission);
		const hash = digest(payload);
		return this.transact((state) => {
			const previous = state.records.find((record) => record.id === id);
			if (previous && previous.digest !== hash)
				throw new FlowLedgerError("identity", "Submission identity was reused with different content.");
			const record = previous ?? {
				id,
				revision: 1,
				status: "retained" as const,
				acceptedAt: Date.now(),
				digest: hash,
				payload,
			};
			if (!previous) state.records.push(record);
			return {
				changed: !previous,
				result: { id: record.id, revision: record.revision, status: record.status, duplicate: !!previous },
			};
		});
	}
	/** Replace one bounded diagnostic. Clearing it never grants dispatch or replay permission. */
	recordAdmission(
		id: string,
		revision: number,
		target: Pick<FlowAdmissionHold, "phase" | "queue">,
		reason?: string,
	): Promise<boolean> {
		const captured = structuredClone({ ...target, reason: reason ?? "Admission revalidated." });
		validateHold(captured);
		return this.transact((state) => {
			const record = state.records.find((record) => record.id === id);
			if (!record || record.revision !== revision || record.status !== "retained")
				return { changed: false, result: false };
			if (captured.queue && (!record.dispatch || record.dispatch.ownerId !== this.ownership.token))
				throw new FlowLedgerError("stale", "Queue admission belongs to another attachment.");
			const holds = record.holds ?? [];
			const index = holds.findIndex((hold) => holdKey(hold) === holdKey(captured));
			if (reason === undefined) {
				if (index < 0) return { changed: false, result: true };
				holds.splice(index, 1);
			} else {
				if (index >= 0 && holds[index].reason === reason) return { changed: false, result: true };
				if (index < 0) holds.push(captured);
				else holds[index] = captured;
			}
			if (holds.length) record.holds = holds;
			else delete record.holds;
			return { changed: true, result: true };
		});
	}

	snapshot(): Promise<RetainedSubmission[]> {
		return this.transact((state) => ({
			changed: false,
			result: state.records.map(({ payload, digest: _digest, dispatch, ...record }) => ({
				...record,
				...(dispatch
					? {
							dispatch: {
								operationId: dispatch.operationId,
								ownerId: dispatch.ownerId,
								phase: dispatch.phase,
								...(dispatch.queueClaims ? { queueClaims: dispatch.queueClaims } : {}),
								...(dispatch.queueCancellations ? { queueCancellations: dispatch.queueCancellations } : {}),
								...(dispatch.queueHistory ? { queueHistory: dispatch.queueHistory } : {}),
								...(dispatch.promptHistory ? { promptHistory: dispatch.promptHistory } : {}),
								...(dispatch.promptClaims ? { promptClaims: dispatch.promptClaims } : {}),
								...(dispatch.inputs
									? { inputs: dispatch.inputs.map((input) => decode(input.payload) as FlowNativeInput) }
									: {}),
							},
						}
					: {}),
				submission: decode(payload) as Submission,
			})),
		}));
	}
	/** Persist cancellation intent before removing the native queue item. */
	cancelQueue(operationId: string, queue: { id: string; revision: number }): Promise<void> {
		const captured = { ...queue };
		return this.transact((state) => {
			const dispatch = state.records.find((record) => record.dispatch?.operationId === operationId)?.dispatch;
			if (!dispatch || dispatch.ownerId !== this.ownership.token)
				throw new FlowLedgerError("stale", "Queue cancellation belongs to another attachment.");
			if (dispatch.queueClaims?.some((claim) => claim.id === captured.id && claim.consumed))
				throw new FlowLedgerError("transition", "Consumed queue input requires request cancellation.");
			const previous = dispatch.queueCancellations?.find((item) => item.id === captured.id);
			if (previous) {
				if (previous.revision !== captured.revision)
					throw new FlowLedgerError("stale", "Queue cancellation revision changed.");
				return { changed: false, result: undefined };
			}
			dispatch.queueCancellations ??= [];
			dispatch.queueCancellations.push(captured);
			return { changed: true, result: undefined };
		});
	}

	/** Record a host's exact post-removal queue receipt; absence or return alone is never consumption proof. */
	recordQueueClaim(operationId: string, queue: { id: string; revision: number }, consumed: boolean): Promise<void> {
		const receipt = { ...queue, consumed };
		return this.transact((state) => {
			const dispatch = state.records.find((record) => record.dispatch?.operationId === operationId)?.dispatch;
			if (!dispatch || dispatch.ownerId !== this.ownership.token)
				throw new FlowLedgerError("stale", "Native queue receipt belongs to another attachment.");
			const previous = dispatch.queueClaims?.find(
				(claim) => claim.id === receipt.id && claim.revision === receipt.revision,
			);
			if (previous) {
				if (previous.revision !== receipt.revision || previous.consumed !== receipt.consumed)
					throw new FlowLedgerError("identity", "Native queue consumption receipt conflicts with retained evidence.");
				return { changed: false, result: undefined };
			}
			dispatch.queueClaims ??= [];
			dispatch.queueClaims.push(receipt);
			return { changed: true, result: undefined };
		});
	}
	/** Bind a newer live queue revision; the superseded revision remains explicitly unconsumed. */
	recordQueueEdit(
		operationId: string,
		previous: { id: string; revision: number },
		input: FlowNativeInput,
	): Promise<void> {
		const prior = { ...previous };
		validateNativeInput(input);
		const captured = structuredClone(input);
		const queue = captured.queue;
		if (
			!Number.isSafeInteger(prior.revision) ||
			prior.revision < 1 ||
			!queue ||
			queue.id !== prior.id ||
			queue.revision <= prior.revision
		)
			return Promise.reject(new FlowLedgerError("identity", "Native edit must advance the same queue identity."));
		const payload = encode(captured),
			hash = digest(payload);
		return this.transact((state) => {
			const record = state.records.find((record) => record.dispatch?.operationId === operationId);
			const dispatch = record?.dispatch;
			if (record?.status !== "retained" || !dispatch || dispatch.ownerId !== this.ownership.token)
				throw new FlowLedgerError("stale", "Native edit belongs to another or cancelled dispatch.");
			if (dispatch.queueCancellations?.some((item) => item.id === queue.id))
				throw new FlowLedgerError("transition", "Cancelled queue input cannot be edited.");
			const inputs = dispatch.inputs ?? [];
			const revisions = inputs
				.map((item) => ({ item, input: decode(item.payload) as FlowNativeInput }))
				.filter(({ input }) => input.queue?.id === queue.id);
			if (dispatch.queueClaims?.some((claim) => claim.id === queue.id && claim.consumed))
				throw new FlowLedgerError("transition", "Consumed native input cannot be edited.");
			const existing = revisions.find(({ input }) => input.queue?.revision === queue.revision);
			if (existing) {
				if (existing.item.digest !== hash)
					throw new FlowLedgerError("identity", "Native edit revision has different content.");
				return { changed: false, result: undefined };
			}
			const old = revisions.find(({ input }) => input.queue?.revision === prior.revision);
			if (
				!old ||
				old.input.kind !== captured.kind ||
				revisions.some(({ input }) => (input.queue?.revision ?? 0) > prior.revision)
			)
				throw new FlowLedgerError("stale", "Native edit does not follow the retained queue revision.");
			dispatch.queueClaims ??= [];
			if (!dispatch.queueClaims.some((claim) => claim.id === prior.id && claim.revision === prior.revision))
				dispatch.queueClaims.push({ ...prior, consumed: false });
			dispatch.inputs ??= [];
			dispatch.inputs.push({ payload, digest: hash });
			return { changed: true, result: undefined };
		});
	}
	/** Retain a verified native transcript entry separately from final provider inclusion. */
	recordQueueHistory(operationId: string, input: FlowNativeQueueHistory): Promise<void> {
		const receipt = { ...input };
		return this.transact((state) => {
			const dispatch = state.records.find((record) => record.dispatch?.operationId === operationId)?.dispatch;
			if (!dispatch || dispatch.ownerId !== this.ownership.token)
				throw new FlowLedgerError("stale", "Native history receipt belongs to another attachment.");
			const previous = dispatch.queueHistory?.find((item) => item.id === receipt.id);
			if (previous) {
				if (
					previous.revision !== receipt.revision ||
					previous.entryId !== receipt.entryId ||
					previous.entryHash !== receipt.entryHash
				)
					throw new FlowLedgerError("identity", "Native history receipt conflicts with retained evidence.");
				return { changed: false, result: undefined };
			}
			dispatch.queueHistory ??= [];
			dispatch.queueHistory.push(receipt);
			return { changed: true, result: undefined };
		});
	}
	recordPromptClaim(operationId: string, input: { inputIndex: number; messageIndex: number }): Promise<void> {
		const receipt = { inputIndex: input.inputIndex, messageIndex: input.messageIndex };
		return this.transact((state) => {
			const dispatch = state.records.find((record) => record.dispatch?.operationId === operationId)?.dispatch;
			if (!dispatch || dispatch.ownerId !== this.ownership.token)
				throw new FlowLedgerError("stale", "Native prompt claim belongs to another attachment.");
			if (
				dispatch.promptClaims?.some(
					(item) => item.inputIndex === receipt.inputIndex && item.messageIndex === receipt.messageIndex,
				)
			)
				return { changed: false, result: undefined };
			dispatch.promptClaims ??= [];
			dispatch.promptClaims.push(receipt);
			return { changed: true, result: undefined };
		});
	}
	recordPromptHistory(operationId: string, input: FlowNativePromptHistory): Promise<void> {
		const receipt = { ...input };
		return this.transact((state) => {
			const dispatch = state.records.find((record) => record.dispatch?.operationId === operationId)?.dispatch;
			if (!dispatch || dispatch.ownerId !== this.ownership.token)
				throw new FlowLedgerError("stale", "Native prompt history belongs to another attachment.");
			const previous = dispatch.promptHistory?.find(
				(item) => item.inputIndex === receipt.inputIndex && item.messageIndex === receipt.messageIndex,
			);
			if (previous) {
				if (previous.entryId !== receipt.entryId || previous.entryHash !== receipt.entryHash)
					throw new FlowLedgerError("identity", "Native prompt history conflicts with retained evidence.");
				return { changed: false, result: undefined };
			}
			dispatch.promptHistory ??= [];
			dispatch.promptHistory.push(receipt);
			return { changed: true, result: undefined };
		});
	}
	/** Persist native-operation intent before executing once. Return is not a delivery or completion receipt. */
	dispatch<T>(
		id: string,
		revision: number,
		operationId: string,
		run: (observer: FlowNativeObserver, submission: Submission) => Promise<T>,
	): Promise<T> {
		if (!identity(operationId)) return Promise.reject(new FlowLedgerError("identity", "Invalid native operation ID."));
		return this.ownership.run(async () => {
			const submission = await this.transact((state) => {
				const record = state.records.find((item) => item.id === id);
				if (!record || record.revision !== revision || record.status !== "retained")
					throw new FlowLedgerError("stale", "Submission changed before native dispatch.");
				if (record.dispatch)
					throw new FlowLedgerError("transition", "Submission already has a native dispatch intent.");
				if (state.records.some((item) => item.dispatch?.operationId === operationId))
					throw new FlowLedgerError("identity", "Native operation ID is already assigned.");
				record.dispatch = { operationId, ownerId: this.ownership.token, phase: "started" };
				return { changed: true, result: decode(record.payload) as Submission };
			});
			const finish = (phase: "returned" | "failed") =>
				this.transact((state) => {
					const dispatch = state.records.find((item) => item.id === id)?.dispatch;
					if (
						!dispatch ||
						dispatch.operationId !== operationId ||
						dispatch.ownerId !== this.ownership.token ||
						dispatch.phase !== "started"
					)
						throw new FlowLedgerError("stale", "Native dispatch ownership changed before its outcome.");
					dispatch.phase = phase;
					return { changed: true, result: undefined };
				});
			this.ownership.assertActive();
			let observing = true;
			const pending: Promise<number>[] = [];
			const observer: FlowNativeObserver = {
				observe: (input) => {
					if (!observing)
						return Promise.reject(new FlowLedgerError("stale", "Native observation outlived its dispatch."));
					validateNativeInput(input);
					if (pending.length >= 64) throw new FlowLedgerError("capacity", "Native input observation limit exceeded.");
					const payload = encode(input);
					const hash = digest(payload);
					const write = this.transact((state) => {
						const dispatch = state.records.find((item) => item.id === id)?.dispatch;
						if (
							dispatch?.operationId !== operationId ||
							dispatch.ownerId !== this.ownership.token ||
							dispatch.phase !== "started"
						)
							throw new FlowLedgerError("stale", "Native observation belongs to another dispatch.");
						dispatch.inputs ??= [];
						dispatch.inputs.push({ payload, digest: hash });
						return { changed: true, result: dispatch.inputs.length - 1 };
					});
					write.catch(() => {});
					pending.push(write);
					return write;
				},
			};
			let result: T;
			try {
				result = await run(observer, submission);
				observing = false;
				await Promise.all(pending);
			} catch (error) {
				observing = false;
				await Promise.allSettled(pending);
				try {
					await finish("failed");
				} catch (receiptError) {
					throw new AggregateError(
						[error, receiptError],
						"Native dispatch failed and its outcome could not be retained.",
					);
				}
				throw error;
			}
			await finish("returned");
			return result;
		});
	}
	/** Cancel only before native dispatch intent; the dispatch check and mutation share one transaction. */
	cancelPending(id: string, revision: number) {
		return this.cancelRecord(id, revision, true);
	}
	cancel(id: string, revision: number) {
		return this.cancelRecord(id, revision, false);
	}
	private cancelRecord(
		id: string,
		revision: number,
		pendingOnly: boolean,
	): Promise<{ kind: "cancelled" | "conflict" | "not-found"; revision?: number }> {
		return this.transact<{ kind: "cancelled" | "conflict" | "not-found"; revision?: number }>((state) => {
			const record = state.records.find((item) => item.id === id);
			if (!record) return { changed: false, result: { kind: "not-found" } };
			if (record.revision !== revision)
				return { changed: false, result: { kind: "conflict", revision: record.revision } };
			if (pendingOnly && record.dispatch)
				throw new FlowLedgerError("transition", "Dispatched input requires native queue or request cancellation.");
			const changed = record.status !== "cancelled";
			if (changed) {
				record.status = "cancelled";
				record.revision++;
			}
			return { changed, result: { kind: "cancelled", revision: record.revision } };
		});
	}
}
