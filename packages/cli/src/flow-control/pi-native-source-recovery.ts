import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { type AgentSession, type SessionManager, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { NativeRequestSource } from "./native-request-store.js";
import { verifyPiHistoryEntries } from "./pi-history-receipts.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowNativeInput, FlowSubmissionStore } from "./submission-store.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Source = Omit<NativeRequestSource, "index">;
interface MemoryReceipt {
	operationId: string;
	entryId: string;
	entryHash: string;
	prompt?: { inputIndex: number; messageIndex: number };
	queue?: { id: string; revision: number };
}
const memoryHistory = new WeakMap<SessionManager, { sessionId: string; receipts: MemoryReceipt[] }>();

/** Entry ownership survives attachment disposal only within this exact live manager. */
export function retainMemorySource(manager: SessionManager, receipt: Omit<MemoryReceipt, "entryHash">): void {
	if (manager.isPersisted()) throw new FlowLedgerError("identity", "Memory source requires a memory-only session.");
	const entry = manager.getEntry(receipt.entryId);
	if (!entry) throw new FlowLedgerError("identity", "Memory source has no transcript entry.");
	let history = memoryHistory.get(manager);
	if (!history || history.sessionId !== manager.getSessionId()) {
		history = { sessionId: manager.getSessionId(), receipts: [] };
		memoryHistory.set(manager, history);
	}
	if (history.receipts.some((item) => item.entryId === receipt.entryId))
		throw new FlowLedgerError("identity", "Memory entry already has source ownership.");
	history.receipts.push({ ...structuredClone(receipt), entryHash: hash(entry) });
}

/** Memory receipts are valid only for the exact manager lifetime that observed them. */
export function memorySourceReceipts(manager: SessionManager): MemoryReceipt[] {
	const history = memoryHistory.get(manager);
	return !manager.isPersisted() && history?.sessionId === manager.getSessionId()
		? structuredClone(history.receipts)
		: [];
}

function observed(input: FlowNativeInput, position: number): { message: AgentMessage; nativeTimestamp: boolean } {
	const value = input.args[0];
	if (input.kind === "prompt" && typeof value === "string")
		return {
			message: {
				role: "user",
				content: [{ type: "text", text: value }, ...((input.args[1] ?? []) as ImageContent[])],
				timestamp: 0,
			},
			nativeTimestamp: true,
		};
	return {
		message: (input.kind === "prompt" && Array.isArray(value) ? value[position] : value) as AgentMessage,
		nativeTimestamp: input.kind === "context",
	};
}

/** Rebuild through Pi's ordered context projection; entry IDs and verified hashes supply identity. */
export async function recoverNativeSources(
	session: AgentSession,
	store: FlowSubmissionStore,
	atRequestBoundary = false,
): Promise<{
	apply(): WeakMap<object, Source[]>;
	recovered: number;
	unresolved: number;
}> {
	const manager = session.sessionManager;
	const leaf = manager.getLeafId(),
		file = manager.getSessionFile();
	const live = session.agent.state.messages;
	const references = [...live],
		liveHash = hash(live);
	const assertCurrent = () => {
		if (
			!atRequestBoundary &&
			(!session.isIdle || session.agent.state.isStreaming || session.isRetrying || session.isCompacting)
		)
			throw new FlowLedgerError("busy", "Native source recovery requires an idle session.");
		if (
			session.sessionId !== store.scope.sessionId ||
			manager.getLeafId() !== leaf ||
			manager.getSessionFile() !== file ||
			session.agent.state.messages !== live ||
			live.length !== references.length ||
			live.some((message, index) => message !== references[index]) ||
			hash(live) !== liveHash
		)
			throw new FlowLedgerError("stale", "Native context changed during source recovery.");
	};
	assertCurrent();
	let projected = manager
		.buildContextEntries()
		.flatMap((entry) => sessionEntryToContextMessages(entry).map((message) => ({ entry, message })));
	const transcriptMessages = structuredClone(projected.map((item) => item.message));
	// Pi retains a retriable terminal response in history but removes it from
	// live context before continuing, including after overflow compaction.
	// Permit that single omission only at a request boundary; every surviving
	// message must still match the authoritative projection below.
	const terminal = projected.at(-1)?.message;
	if (
		atRequestBoundary &&
		projected.length === live.length + 1 &&
		terminal?.role === "assistant" &&
		(terminal.stopReason === "error" || terminal.stopReason === "length")
	)
		projected = projected.slice(0, -1);
	const messages = projected.map((item) => item.message);
	// Pi timestamps a custom transcript entry separately from its live message.
	// Compare every other field, then retain the exact live object and bytes.
	const comparable = (message: AgentMessage) => (message.role === "custom" ? { ...message, timestamp: 0 } : message);
	if (!isDeepStrictEqual(messages.map(comparable), live.map(comparable)))
		throw new FlowLedgerError("identity", "Live context differs from Pi's transcript reconstruction.");
	const memoryReceipts = memorySourceReceipts(manager);
	const records = await store.snapshot();
	assertCurrent();
	const projectedIds = new Set(projected.map(({ entry }) => entry.id));
	const dispatchIds = new Set(records.flatMap((record) => (record.dispatch ? [record.dispatch.operationId] : [])));
	const proofIds = [
		...memoryReceipts.filter((receipt) => dispatchIds.has(receipt.operationId)).map((receipt) => receipt.entryId),
		...records.flatMap((record) => [
			...(record.dispatch?.queueHistory ?? []).map((receipt) => receipt.entryId),
			...(record.dispatch?.promptHistory ?? []).map((receipt) => receipt.entryId),
		]),
	].filter((id) => projectedIds.has(id));
	const proofs = await verifyPiHistoryEntries(manager, proofIds);
	assertCurrent();
	const bindings = new WeakMap<object, Source[]>();
	const entries = new Set<string>();
	let recovered = 0,
		unresolved = 0;
	for (const record of records) {
		const dispatch = record.dispatch;
		if (!dispatch) continue;
		unresolved += (dispatch.inputs ?? []).filter(
			(input, index) =>
				input.kind === "context" &&
				!dispatch.promptClaims?.some((claim) => claim.inputIndex === index) &&
				!dispatch.contextCancellations?.some((item) => item.inputIndex === index && item.removed),
		).length;
		const receipts = [
			...memoryReceipts
				.filter((receipt) => receipt.operationId === dispatch.operationId)
				.map((receipt) => ({ ...receipt, memory: true })),
			...(dispatch.queueHistory ?? []).map((receipt) => ({
				...receipt,
				memory: false,
				queue: { id: receipt.id, revision: receipt.revision },
				prompt: undefined,
			})),
			...(dispatch.promptHistory ?? []).map((receipt) => ({
				...receipt,
				memory: false,
				prompt: { inputIndex: receipt.inputIndex, messageIndex: receipt.messageIndex },
				queue: undefined,
			})),
		];
		unresolved += (dispatch.queueClaims ?? []).filter(
			(claim) =>
				claim.consumed &&
				!receipts.some((receipt) => receipt.queue?.id === claim.id && receipt.queue.revision === claim.revision),
		).length;
		unresolved += (dispatch.promptClaims ?? []).filter(
			(claim) =>
				!receipts.some(
					(receipt) =>
						receipt.prompt?.inputIndex === claim.inputIndex && receipt.prompt.messageIndex === claim.messageIndex,
				),
		).length;
		for (const receipt of receipts) {
			const targets = projected.filter((item) => item.entry.id === receipt.entryId);
			if (!targets.length) continue; // Pi excludes other branches and compacted input from active context.
			if (targets.length !== 1 || entries.has(receipt.entryId))
				throw new FlowLedgerError("identity", "Native history entry has ambiguous source ownership.");
			entries.add(receipt.entryId);
			const evidence = proofs.get(receipt.entryId);
			if (!evidence) throw new FlowLedgerError("identity", "Native source history has no verification evidence.");
			assertCurrent();
			if (
				receipt.memory
					? evidence.kind !== "memory" || hash(manager.getEntry(receipt.entryId)) !== receipt.entryHash
					: evidence.kind !== "persisted" || evidence.entryHash !== receipt.entryHash
			)
				throw new FlowLedgerError("identity", "Native source history differs from its retained receipt.");
			const input = receipt.prompt
				? dispatch.inputs?.[receipt.prompt.inputIndex]
				: dispatch.inputs?.find(
						(input) =>
							receipt.queue && input.queue?.id === receipt.queue.id && input.queue.revision === receipt.queue.revision,
					);
			if (!input) throw new FlowLedgerError("identity", "Native history has no observed input.");
			const expected = observed(input, receipt.prompt?.messageIndex ?? 0);
			const target = targets[0];
			const ignoreTimestamp = expected.nativeTimestamp || target.entry.type === "custom_message";
			const normalize = (message: AgentMessage) => (ignoreTimestamp ? { ...message, timestamp: 0 } : message);
			if (!isDeepStrictEqual(normalize(expected.message), normalize(target.message)))
				throw new FlowLedgerError("identity", "Native observed input differs from its transcript message.");
			const liveMessage = live[projected.indexOf(target)];
			const source: Source = {
				operationId: dispatch.operationId,
				messageHash: hash(liveMessage),
				...(receipt.prompt ? { prompt: receipt.prompt } : { queue: receipt.queue }),
			};
			const sources = bindings.get(liveMessage) ?? [];
			sources.push(source);
			bindings.set(liveMessage, sources);
			recovered++;
		}
	}
	assertCurrent();
	return {
		recovered,
		unresolved,
		apply() {
			assertCurrent();
			if (!isDeepStrictEqual(manager.buildSessionContext().messages, transcriptMessages))
				throw new FlowLedgerError("stale", "Pi context changed before source restoration.");
			// Bind the verified projection to the unchanged live messages.
			return bindings;
		},
	};
}
