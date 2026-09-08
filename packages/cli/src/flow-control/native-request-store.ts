import { BACKGROUND_CONTEXT, type Session, setValue, value } from "@earendil-works/pi-agent-core";
import { type NativeProjectionCapture, validateNativeProjections } from "./native-context-projections.js";
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
	projectionCapture?: NativeProjectionCapture;
	requiredSources?: number[];
	cancelledSources?: number[];
	retryOf?: string;
	retryAuthorization?: { ownerId: string; requestId?: string };
	withheldPayload?: NativeRequest["payload"];
	payload?: {
		hash: string;
		bytes: number;
		api: string;
		model: string;
		provider: string;
		sources?: NativePayloadSource[];
		projections?: NativePayloadSource[];
	};
	outcome?: "success" | "failure" | "aborted" | "withheld";
}
export interface NativePayloadSource {
	sourceIndex: number;
	disposition: "included" | "changed" | "unresolved";
	index?: number;
	contentHash?: string;
}
export type NativeSourceClaim = Pick<NativeRequestSource, "operationId" | "prompt" | "queue">;
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
export const nativeSourceKey = (source: NativeSourceClaim) =>
	JSON.stringify([
		source.operationId,
		source.prompt?.inputIndex,
		source.prompt?.messageIndex,
		source.queue?.id,
		source.queue?.revision,
	]);
const identity = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 512;
const hash = (text: unknown) => typeof text === "string" && /^[a-f0-9]{64}$/.test(text);

export const nativeRequestHeld = (record: NativeRequest): boolean =>
	record.outcome === "withheld" && !!record.requiredSources?.length;
export const nativeHoldPending = (record: NativeRequest): boolean =>
	nativeRequestHeld(record) && !!record.requiredSources?.some((index) => !record.cancelledSources?.includes(index));
export const nativeCancelledSources = (records: NativeRequest[]): NativeRequestSource[] =>
	records.flatMap((record) =>
		(record.sourceCapture?.members ?? []).filter((source) => record.cancelledSources?.includes(source.index)),
	);
export const nativeHoldHash = (record: NativeRequest): string => record.withheldPayload?.hash ?? record.modelHash;

/** Request lifecycle facts only; payload hashes never establish per-source membership. */
export class FlowNativeRequestStore {
	private initialized = false;
	private blocked = true;
	private queueableRequest?: string;
	get recoveryBlocked(): boolean {
		return this.blocked;
	}
	/** Queue insertion may coexist with the one unresolved request owned by this attachment. */
	blocksQueueing(activeRequestId?: string): boolean {
		return this.blocked && (!activeRequestId || this.queueableRequest !== activeRequestId);
	}
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
		for (const [recordIndex, record] of records.entries()) {
			if (
				record.retryAuthorization !== undefined &&
				(!nativeRequestHeld(record) ||
					!record.retryAuthorization ||
					!identity(record.retryAuthorization.ownerId) ||
					(record.retryAuthorization.requestId !== undefined &&
						!records
							.slice(recordIndex + 1)
							.some(
								(candidate) => candidate.id === record.retryAuthorization?.requestId && candidate.retryOf === record.id,
							)))
			)
				throw new FlowLedgerError("identity", "Invalid native retry authorization.");
			if (
				record.retryOf !== undefined &&
				!records
					.slice(0, recordIndex)
					.some(
						(parent) =>
							parent.id === record.retryOf &&
							parent.retryAuthorization?.requestId === record.id &&
							parent.retryAuthorization.ownerId === record.ownerId,
					)
			)
				throw new FlowLedgerError("identity", "Native retry has no matching authorization.");
			if (
				record.cancelledSources !== undefined &&
				(!nativeRequestHeld(record) ||
					!Array.isArray(record.cancelledSources) ||
					new Set(record.cancelledSources).size !== record.cancelledSources.length ||
					record.cancelledSources.some((index) => !record.requiredSources?.includes(index)))
			)
				throw new FlowLedgerError("identity", "Invalid cancelled native source positions.");
			const payload = record.payload ?? record.withheldPayload;
			validateNativeProjections(record.projectionCapture, record.transformedHash, record.modelHash, payload);
			if (
				record.projectionCapture &&
				(record.projectionCapture.count !== record.sourceCapture?.context?.count ||
					record.projectionCapture.model?.count !== record.sourceCapture?.model?.count)
			)
				throw new FlowLedgerError("identity", "Projection and native conversion capture different contexts.");
			if (
				record.withheldPayload !== undefined &&
				(!record.requiredSources?.length || record.payload || record.outcome !== "withheld")
			)
				throw new FlowLedgerError("schema", "Invalid withheld native payload.");
			if (
				!identity(record.id) ||
				!identity(record.ownerId) ||
				![record.sourceHash, record.transformedHash, record.modelHash, record.systemHash].every(hash) ||
				(record.outcome !== undefined && !["success", "failure", "aborted", "withheld"].includes(record.outcome)) ||
				(payload !== undefined &&
					(!payload ||
						!hash(payload.hash) ||
						!Number.isSafeInteger(payload.bytes) ||
						payload.bytes < 1 ||
						![payload.api, payload.model, payload.provider].every(identity))) ||
				(record.outcome === "withheld" && record.payload !== undefined) ||
				(record.outcome !== undefined && record.outcome !== "withheld" && !record.payload)
			)
				throw new FlowLedgerError("schema", "Invalid native request receipt.");
			if (payload?.sources !== undefined) {
				const sources = payload.sources,
					capture = record.sourceCapture;
				if (!capture || !Array.isArray(sources) || sources.length !== capture.members.length)
					throw new FlowLedgerError("schema", "Invalid native payload source receipts.");
				const positions = new Set<number>();
				for (const [offset, source] of sources.entries()) {
					if (
						!source ||
						source.sourceIndex !== capture.members[offset]?.index ||
						!["included", "changed", "unresolved"].includes(source.disposition) ||
						(source.index !== undefined &&
							(!Number.isSafeInteger(source.index) ||
								source.index < 0 ||
								source.index >= payload.bytes ||
								positions.has(source.index))) ||
						(source.contentHash !== undefined && !hash(source.contentHash)) ||
						(source.index === undefined) !== (source.contentHash === undefined) ||
						(source.disposition === "unresolved" && source.index !== undefined) ||
						(source.disposition === "included" &&
							(payload.api !== "openai-completions" ||
								source.index === undefined ||
								!["intact", "converted"].includes(capture.model?.members[offset]?.status ?? "")))
					)
						throw new FlowLedgerError("identity", "Invalid native payload source membership.");
					if (source.index !== undefined) positions.add(source.index);
				}
			}
			if (
				record.requiredSources !== undefined &&
				(!Array.isArray(record.requiredSources) ||
					new Set(record.requiredSources).size !== record.requiredSources.length ||
					record.requiredSources.some(
						(index) => !record.sourceCapture?.members.some((source) => source.index === index),
					))
			)
				throw new FlowLedgerError("identity", "Invalid required native source positions.");
			if (
				record.payload &&
				record.requiredSources?.some(
					(index) =>
						!record.payload?.sources?.some(
							(source) => source.sourceIndex === index && source.disposition === "included",
						),
				)
			)
				throw new FlowLedgerError("identity", "Native handoff omits required source content.");
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
					const key = nativeSourceKey(member);
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
				this.blocked = this.requiresRecovery(records);
				const unresolved = records.filter((record) => record.outcome === undefined);
				const candidate = unresolved.length === 1 ? unresolved[0] : undefined;
				this.queueableRequest =
					candidate?.ownerId === this.ownership.token &&
					!this.requiresRecovery(records.filter((record) => record !== candidate))
						? candidate.id
						: undefined;
				return result;
			}, BACKGROUND_CONTEXT),
		);
	}
	private requiresRecovery(records: NativeRequest[]): boolean {
		return records.some(
			(record) =>
				record.outcome === undefined ||
				(nativeHoldPending(record) &&
					!record.retryAuthorization?.requestId &&
					record.retryAuthorization?.ownerId !== this.ownership.token),
		);
	}
	/** Explicit host action only; authorizes one preparation without appending or sending input. */
	authorizeRetry(id: string, expectedHash: string): Promise<void> {
		return this.transact((records) => {
			const record = records.find((item) => item.id === id);
			if (!record || !nativeHoldPending(record) || nativeHoldHash(record) !== expectedHash)
				throw new FlowLedgerError("stale", "Native content hold changed or is unavailable.");
			if (records.some((item) => item.outcome === undefined) || record.retryAuthorization?.requestId)
				throw new FlowLedgerError("busy", "Native retry already has a request or requires reconciliation.");
			record.retryAuthorization = { ownerId: this.ownership.token };
		});
	}
	/** Cancel reviewed, never handed-off required sources without changing their history receipts. */
	cancelSources(id: string, expectedHash: string, indices: number[]): Promise<void> {
		const selected = [...indices];
		return this.transact((records) => {
			const record = records.find((item) => item.id === id);
			if (!record || !nativeRequestHeld(record) || nativeHoldHash(record) !== expectedHash)
				throw new FlowLedgerError("stale", "Native content hold changed or is unavailable.");
			if (records.some((item) => item.outcome === undefined) || record.retryAuthorization?.requestId)
				throw new FlowLedgerError("busy", "Native cancellation requires an unconsumed hold.");
			if (
				!selected.length ||
				new Set(selected).size !== selected.length ||
				selected.some((index) => !record.requiredSources?.includes(index))
			)
				throw new FlowLedgerError("identity", "Cancellation must identify held required sources.");
			record.cancelledSources = [...new Set([...(record.cancelledSources ?? []), ...selected])];
			delete record.retryAuthorization;
		});
	}
	snapshot(): Promise<NativeRequest[]> {
		return this.transact((records) => structuredClone(records));
	}
	begin(
		input: Omit<
			NativeRequest,
			| "ownerId"
			| "payload"
			| "withheldPayload"
			| "outcome"
			| "requiredSources"
			| "retryOf"
			| "retryAuthorization"
			| "cancelledSources"
		>,
		requireUnreceived = false,
		consumedClaims?: NativeSourceClaim[],
	): Promise<void> {
		const claims = consumedClaims === undefined ? undefined : structuredClone(consumedClaims);
		const captured = {
			id: input.id,
			sourceHash: input.sourceHash,
			transformedHash: input.transformedHash,
			modelHash: input.modelHash,
			systemHash: input.systemHash,
			...(input.sourceCapture !== undefined ? { sourceCapture: structuredClone(input.sourceCapture) } : {}),
			...(input.projectionCapture !== undefined ? { projectionCapture: structuredClone(input.projectionCapture) } : {}),
		};
		return this.transact((records) => {
			if (records.some((record) => record.id === captured.id))
				throw new FlowLedgerError("identity", "Native request ID is already retained.");
			if (this.requiresRecovery(records))
				throw new FlowLedgerError("busy", "Native request requires reconciliation before another request.");
			const cancelled = new Set(nativeCancelledSources(records).map(nativeSourceKey));
			const received = new Set(
				records.flatMap((request) =>
					(request.sourceCapture?.members ?? [])
						.filter((source) =>
							request.payload?.sources?.some(
								(item) => item.sourceIndex === source.index && item.disposition === "included",
							),
						)
						.map(nativeSourceKey),
				),
			);
			if (requireUnreceived) {
				if (!claims || !captured.sourceCapture)
					throw new FlowLedgerError("identity", "Required native input has no consumption inventory.");
				const capturedKeys = new Set(captured.sourceCapture.members.map(nativeSourceKey));
				const claimKeys = new Set(claims.map(nativeSourceKey));
				if (
					captured.sourceCapture.members.some((source) => !claimKeys.has(nativeSourceKey(source))) ||
					claims.some(
						(claim) =>
							!received.has(nativeSourceKey(claim)) &&
							!cancelled.has(nativeSourceKey(claim)) &&
							!capturedKeys.has(nativeSourceKey(claim)),
					)
				)
					throw new FlowLedgerError("identity", "Consumed native input requires source reconciliation.");
			}
			const requiredSources = requireUnreceived
				? (captured.sourceCapture?.members
						.filter((source) => !received.has(nativeSourceKey(source)) && !cancelled.has(nativeSourceKey(source)))
						.map((source) => source.index) ?? [])
				: undefined;
			const retry = records.find(
				(record) =>
					nativeHoldPending(record) &&
					!record.retryAuthorization?.requestId &&
					record.retryAuthorization?.ownerId === this.ownership.token,
			);
			if (retry && !requireUnreceived)
				throw new FlowLedgerError("identity", "Native retry requires input admission checks.");
			if (retry) {
				const capturedKeys = new Set(captured.sourceCapture?.members.map(nativeSourceKey));
				if (
					retry.sourceCapture?.members.some(
						(source) =>
							retry.requiredSources?.includes(source.index) &&
							!cancelled.has(nativeSourceKey(source)) &&
							!capturedKeys.has(nativeSourceKey(source)),
					)
				)
					throw new FlowLedgerError("identity", "Native retry is missing held input.");
				retry.retryAuthorization = { ownerId: this.ownership.token, requestId: captured.id };
			}
			records.push({
				...captured,
				ownerId: this.ownership.token,
				...(requiredSources ? { requiredSources } : {}),
				...(retry ? { retryOf: retry.id } : {}),
			});
		});
	}
	private owned(records: NativeRequest[], id: string): NativeRequest {
		const record = records.find((item) => item.id === id);
		if (!record || record.ownerId !== this.ownership.token)
			throw new FlowLedgerError("stale", "Native request belongs to another attachment.");
		return record;
	}
	handoff(id: string, payload: NonNullable<NativeRequest["payload"]>): Promise<boolean> {
		const captured = structuredClone(payload);
		return this.transact((records) => {
			const record = this.owned(records, id);
			if (record.payload || record.outcome)
				throw new FlowLedgerError("transition", "Native request already has a disposition.");
			const cancelled = new Set(nativeCancelledSources(records).map(nativeSourceKey));
			if (
				record.sourceCapture?.members.some(
					(source) =>
						cancelled.has(nativeSourceKey(source)) &&
						captured.sources?.some((item) => item.sourceIndex === source.index && item.disposition !== "unresolved"),
				)
			)
				throw new FlowLedgerError("identity", "Cancelled native input reached the provider payload.");
			const missing = record.requiredSources?.some(
				(index) =>
					!captured.sources?.some((source) => source.sourceIndex === index && source.disposition === "included"),
			);
			if (missing) {
				record.withheldPayload = captured;
				record.outcome = "withheld";
				return false;
			}
			record.payload = captured;
			return true;
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
