import { BACKGROUND_CONTEXT, type Session, setValue, value } from "@earendil-works/pi-agent-core";
import type { FlowOwnership } from "./ownership.js";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";

export interface NativeRequest {
	id: string;
	ownerId: string;
	sourceHash: string;
	transformedHash: string;
	modelHash: string;
	systemHash: string;
	sourceCapture?: NativeSourceCapture;
	payload?: { hash: string; bytes: number; api: string; model: string; provider: string };
	outcome?: "success" | "failure" | "aborted" | "withheld";
}
export interface NativeRequestSource {
	index: number;
	operationId: string;
	messageHash: string;
	prompt?: { inputIndex: number; messageIndex: number };
	queue?: { id: string; revision: number };
}
export interface NativeSourceDisposition {
	hash: string;
	count: number;
	members: {
		sourceIndex: number;
		status: "intact" | "converted" | "changed" | "unresolved";
		index?: number;
		messageHash?: string;
	}[];
}
export interface NativeSourceCapture {
	hash: string;
	count: number;
	members: NativeRequestSource[];
	context?: NativeSourceDisposition;
	model?: NativeSourceDisposition;
}
interface Header {
	version: 1;
	scope: FlowScope;
	ids: string[];
}
const headerAddress = value<Header>("jouzu.flow.native-requests", "v1");
const address = (id: string) => value<NativeRequest>("jouzu.flow.native-request", id);
const identity = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 512;
const hash = (text: unknown) => typeof text === "string" && /^[a-f0-9]{64}$/.test(text);

/** Request lifecycle facts only; payload hashes never establish per-source membership. */
export class FlowNativeRequestStore {
	private initialized = false;
	get scope(): Readonly<FlowScope> {
		return this.ownership.scope;
	}
	private constructor(
		private readonly session: Session,
		private readonly ownership: FlowOwnership,
	) {}
	static async attach(session: Session, ownership: FlowOwnership): Promise<FlowNativeRequestStore> {
		const store = new FlowNativeRequestStore(session, ownership);
		await store.transact(() => undefined);
		store.initialized = true;
		return store;
	}
	private validate(records: NativeRequest[]): void {
		if (records.length > 1024 || Buffer.byteLength(JSON.stringify(records)) > 1024 * 1024)
			throw new FlowLedgerError("capacity", "Native request retention limit reached.");
		for (const record of records) {
			if (
				!identity(record.id) ||
				!identity(record.ownerId) ||
				![record.sourceHash, record.transformedHash, record.modelHash, record.systemHash].every(hash) ||
				(record.outcome !== undefined && !["success", "failure", "aborted", "withheld"].includes(record.outcome)) ||
				(record.payload !== undefined &&
					(!record.payload ||
						!hash(record.payload.hash) ||
						!Number.isSafeInteger(record.payload.bytes) ||
						record.payload.bytes < 1 ||
						![record.payload.api, record.payload.model, record.payload.provider].every(identity))) ||
				(record.outcome === "withheld" && record.payload !== undefined) ||
				(record.outcome !== undefined && record.outcome !== "withheld" && !record.payload)
			)
				throw new FlowLedgerError("schema", "Invalid native request receipt.");
			const capture = record.sourceCapture;
			if (capture !== undefined) {
				if (
					!capture ||
					!hash(capture.hash) ||
					!Number.isSafeInteger(capture.count) ||
					capture.count < 0 ||
					!Array.isArray(capture.members) ||
					capture.members.length > 1024
				)
					throw new FlowLedgerError("schema", "Invalid native source capture.");
				const positions = new Set<number>();
				const sources = new Set<string>();
				for (const member of capture.members) {
					if (
						!member ||
						!Number.isSafeInteger(member.index) ||
						member.index < 0 ||
						member.index >= capture.count ||
						positions.has(member.index) ||
						!identity(member.operationId) ||
						!hash(member.messageHash) ||
						(member.prompt === undefined) === (member.queue === undefined) ||
						(member.prompt !== undefined &&
							(!member.prompt ||
								![member.prompt.inputIndex, member.prompt.messageIndex].every(
									(n) => Number.isSafeInteger(n) && n >= 0,
								))) ||
						(member.queue !== undefined &&
							(!member.queue ||
								!identity(member.queue.id) ||
								!Number.isSafeInteger(member.queue.revision) ||
								member.queue.revision < 1))
					)
						throw new FlowLedgerError("identity", "Invalid native source message identity.");
					const key = JSON.stringify([member.operationId, member.prompt, member.queue]);
					if (sources.has(key)) throw new FlowLedgerError("identity", "Native source message was repeated.");
					positions.add(member.index);
					sources.add(key);
				}
				for (const [stage, expectedHash] of [
					["context", record.transformedHash],
					["model", record.modelHash],
				] as const) {
					const context = capture[stage];
					if (context === undefined) continue;
					if (
						!context ||
						!hash(context.hash) ||
						context.hash !== expectedHash ||
						!Number.isSafeInteger(context.count) ||
						context.count < 0 ||
						!Array.isArray(context.members) ||
						context.members.length !== capture.members.length
					)
						throw new FlowLedgerError("schema", "Invalid native context disposition.");
					const mapped = new Set<number>();
					for (const [offset, member] of context.members.entries()) {
						if (
							!member ||
							member.sourceIndex !== capture.members[offset]?.index ||
							!(
								stage === "model"
									? ["intact", "converted", "changed", "unresolved"]
									: ["intact", "changed", "unresolved"]
							).includes(member.status) ||
							(member.messageHash !== undefined && (!hash(member.messageHash) || member.status === "unresolved")) ||
							(member.status === "converted" && !hash(member.messageHash)) ||
							(member.status === "unresolved"
								? member.index !== undefined
								: member.index === undefined ||
									!Number.isSafeInteger(member.index) ||
									member.index < 0 ||
									member.index >= context.count ||
									mapped.has(member.index))
						)
							throw new FlowLedgerError("identity", "Invalid native context source position.");
						if (
							stage === "model" &&
							(!capture.context ||
								(member.status !== "unresolved" && capture.context.members[offset]?.status === "unresolved"))
						)
							throw new FlowLedgerError("identity", "Native model source lacks context provenance.");
						if (
							stage === "model" &&
							["intact", "converted"].includes(member.status) &&
							capture.context?.members[offset]?.status !== "intact"
						)
							throw new FlowLedgerError("identity", "Native conversion cannot erase changed context.");
						if (
							member.status === "intact" &&
							member.messageHash !== undefined &&
							member.messageHash !== capture.members[offset].messageHash
						)
							throw new FlowLedgerError("identity", "Intact native model content differs from its source.");
						if (member.index !== undefined) mapped.add(member.index);
					}
				}
			}
		}
	}
	private transact<T>(update: (records: NativeRequest[]) => T): Promise<T> {
		return this.ownership.run(() =>
			this.session.mutate(async (mutation, context) => {
				const saved = (await mutation.getValue(headerAddress, context))?.value;
				if (!saved && this.initialized) throw new FlowLedgerError("schema", "Native request manifest is missing.");
				const header = saved ?? { version: 1, scope: this.scope, ids: [] };
				if (
					header.version !== 1 ||
					header.scope?.sessionId !== this.scope.sessionId ||
					header.scope?.branchId !== this.scope.branchId ||
					!Array.isArray(header.ids) ||
					header.ids.length > 1024 ||
					!header.ids.every(identity) ||
					new Set(header.ids).size !== header.ids.length
				)
					throw new FlowLedgerError("schema", "Invalid native request manifest.");
				const records = await Promise.all(
					header.ids.map(async (id) => {
						const item = (await mutation.getValue(address(id), context))?.value;
						if (!item || item.id !== id)
							throw new FlowLedgerError("identity", "Native request manifest has missing content.");
						return structuredClone(item);
					}),
				);
				this.validate(records);
				const previous = new Map(records.map((record) => [record.id, JSON.stringify(record)]));
				const result = update(records);
				this.validate(records);
				const changed = records.filter((record) => previous.get(record.id) !== JSON.stringify(record));
				if (!saved || changed.length)
					await mutation.commit(
						[
							setValue(headerAddress, { version: 1, scope: this.scope, ids: records.map((record) => record.id) }),
							...changed.map((record) => setValue(address(record.id), record)),
						],
						context,
					);
				return result;
			}, BACKGROUND_CONTEXT),
		);
	}
	snapshot(): Promise<NativeRequest[]> {
		return this.transact((records) => structuredClone(records));
	}
	begin(input: Omit<NativeRequest, "ownerId" | "payload" | "outcome">): Promise<void> {
		const captured = {
			id: input.id,
			sourceHash: input.sourceHash,
			transformedHash: input.transformedHash,
			modelHash: input.modelHash,
			systemHash: input.systemHash,
			...(input.sourceCapture !== undefined ? { sourceCapture: structuredClone(input.sourceCapture) } : {}),
		};
		return this.transact((records) => {
			if (records.some((record) => record.id === captured.id))
				throw new FlowLedgerError("identity", "Native request ID is already retained.");
			if (records.some((record) => record.outcome === undefined))
				throw new FlowLedgerError("busy", "Native request requires reconciliation before another request.");
			records.push({ ...captured, ownerId: this.ownership.token });
		});
	}
	private owned(records: NativeRequest[], id: string): NativeRequest {
		const record = records.find((item) => item.id === id);
		if (!record || record.ownerId !== this.ownership.token)
			throw new FlowLedgerError("stale", "Native request belongs to another attachment.");
		return record;
	}
	handoff(id: string, payload: NonNullable<NativeRequest["payload"]>): Promise<void> {
		const captured = structuredClone(payload);
		return this.transact((records) => {
			const record = this.owned(records, id);
			if (record.payload || record.outcome)
				throw new FlowLedgerError("transition", "Native request already has a disposition.");
			record.payload = captured;
		});
	}
	finish(id: string, outcome: NonNullable<NativeRequest["outcome"]>): Promise<void> {
		return this.transact((records) => {
			const record = this.owned(records, id);
			if (record.outcome && record.outcome !== outcome)
				throw new FlowLedgerError("transition", "Native request outcome conflicts with retained evidence.");
			record.outcome = outcome;
		});
	}
}
