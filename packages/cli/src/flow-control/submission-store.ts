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
interface RecordData {
	id: string;
	revision: number;
	status: "retained" | "cancelled";
	acceptedAt: number;
	digest: string;
	payload: Encoded;
	dispatch?: Omit<FlowSubmissionDispatch, "inputs"> & { inputs?: { payload: Encoded; digest: string }[] };
}
export interface FlowNativeInput {
	kind: "prompt" | "steer" | "followUp";
	args: unknown[];
	queue?: { id: string; revision: number };
}
export interface FlowNativeObserver {
	observe(input: FlowNativeInput): Promise<void>;
}
export interface FlowSubmissionDispatch {
	operationId: string;
	ownerId: string;
	phase: "started" | "returned" | "failed";
	inputs?: FlowNativeInput[];
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
	submission: Submission;
	dispatch?: FlowSubmissionDispatch;
}
type Header = Omit<State, "records"> & { recordIds: string[] };
const address = value<Header>("jouzu.flow.submissions", "v1");
const recordAddress = (id: string) => value<RecordData>("jouzu.flow.submission", id);
const digest = (payload: Encoded) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");
const identity = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 512;
function validateNativeInput(input: FlowNativeInput): void {
	if (
		!input ||
		!["prompt", "steer", "followUp"].includes(input.kind) ||
		!Array.isArray(input.args) ||
		(input.kind === "prompt"
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
	/** Persist native-operation intent before executing once. Return is not a delivery or completion receipt. */
	dispatch<T>(
		id: string,
		revision: number,
		operationId: string,
		run: (observer: FlowNativeObserver) => Promise<T>,
	): Promise<T> {
		if (!identity(operationId)) return Promise.reject(new FlowLedgerError("identity", "Invalid native operation ID."));
		return this.ownership.run(async () => {
			await this.transact((state) => {
				const record = state.records.find((item) => item.id === id);
				if (!record || record.revision !== revision || record.status !== "retained")
					throw new FlowLedgerError("stale", "Submission changed before native dispatch.");
				if (record.dispatch)
					throw new FlowLedgerError("transition", "Submission already has a native dispatch intent.");
				if (state.records.some((item) => item.dispatch?.operationId === operationId))
					throw new FlowLedgerError("identity", "Native operation ID is already assigned.");
				record.dispatch = { operationId, ownerId: this.ownership.token, phase: "started" };
				return { changed: true, result: undefined };
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
			const pending: Promise<void>[] = [];
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
						return { changed: true, result: undefined };
					});
					write.catch(() => {});
					pending.push(write);
					return write;
				},
			};
			let result: T;
			try {
				result = await run(observer);
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
	cancel(id: string, revision: number): Promise<{ kind: "cancelled" | "conflict" | "not-found"; revision?: number }> {
		return this.transact<{ kind: "cancelled" | "conflict" | "not-found"; revision?: number }>((state) => {
			const record = state.records.find((item) => item.id === id);
			if (!record) return { changed: false, result: { kind: "not-found" } };
			if (record.revision !== revision)
				return { changed: false, result: { kind: "conflict", revision: record.revision } };
			const changed = record.status !== "cancelled";
			if (changed) {
				record.status = "cancelled";
				record.revision++;
			}
			return { changed, result: { kind: "cancelled", revision: record.revision } };
		});
	}
}
