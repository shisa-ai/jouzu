import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { type AgentSession, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { NativeRequestSource } from "./native-request-store.js";
import { verifyPiHistoryEntry } from "./pi-history-receipts.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowNativeInput, FlowSubmissionStore } from "./submission-store.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Source = Omit<NativeRequestSource, "index">;

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
		if (!session.isIdle || session.agent.state.isStreaming || session.isRetrying || session.isCompacting)
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
	const projected = manager
		.buildContextEntries()
		.flatMap((entry) => sessionEntryToContextMessages(entry).map((message) => ({ entry, message })));
	const messages = projected.map((item) => item.message);
	if (!isDeepStrictEqual(messages, live))
		throw new FlowLedgerError("identity", "Live context differs from Pi's transcript reconstruction.");
	const records = await store.snapshot();
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
			...(dispatch.queueHistory ?? []).map((receipt) => ({
				...receipt,
				queue: { id: receipt.id, revision: receipt.revision },
				prompt: undefined,
			})),
			...(dispatch.promptHistory ?? []).map((receipt) => ({
				...receipt,
				prompt: { inputIndex: receipt.inputIndex, messageIndex: receipt.messageIndex },
				queue: undefined,
			})),
		];
		unresolved += (dispatch.queueClaims ?? []).filter(
			(claim) =>
				claim.consumed &&
				!dispatch.queueHistory?.some((receipt) => receipt.id === claim.id && receipt.revision === claim.revision),
		).length;
		unresolved += (dispatch.promptClaims ?? []).filter(
			(claim) =>
				!dispatch.promptHistory?.some(
					(receipt) => receipt.inputIndex === claim.inputIndex && receipt.messageIndex === claim.messageIndex,
				),
		).length;
		for (const receipt of receipts) {
			const targets = projected.filter((item) => item.entry.id === receipt.entryId);
			if (!targets.length) continue; // Pi excludes other branches and compacted input from active context.
			if (targets.length !== 1 || entries.has(receipt.entryId))
				throw new FlowLedgerError("identity", "Native history entry has ambiguous source ownership.");
			entries.add(receipt.entryId);
			const evidence = await verifyPiHistoryEntry(manager, receipt.entryId);
			assertCurrent();
			if (evidence.kind !== "persisted" || evidence.entryHash !== receipt.entryHash)
				throw new FlowLedgerError("identity", "Native source history differs from its retained receipt.");
			const input = receipt.prompt
				? dispatch.inputs?.[receipt.prompt.inputIndex]
				: dispatch.inputs?.find(
						(input) => input.queue?.id === receipt.queue?.id && input.queue.revision === receipt.queue.revision,
					);
			if (!input) throw new FlowLedgerError("identity", "Native history has no observed input.");
			const expected = observed(input, receipt.prompt?.messageIndex ?? 0);
			const target = targets[0];
			const ignoreTimestamp = expected.nativeTimestamp || target.entry.type === "custom_message";
			const normalize = (message: AgentMessage) => (ignoreTimestamp ? { ...message, timestamp: 0 } : message);
			if (!isDeepStrictEqual(normalize(expected.message), normalize(target.message)))
				throw new FlowLedgerError("identity", "Native observed input differs from its transcript message.");
			const source: Source = {
				operationId: dispatch.operationId,
				messageHash: hash(target.message),
				...(receipt.prompt ? { prompt: receipt.prompt } : { queue: receipt.queue }),
			};
			const sources = bindings.get(target.message) ?? [];
			sources.push(source);
			bindings.set(target.message, sources);
			recovered++;
		}
	}
	assertCurrent();
	return {
		recovered,
		unresolved,
		apply() {
			assertCurrent();
			if (!isDeepStrictEqual(manager.buildSessionContext().messages, messages))
				throw new FlowLedgerError("stale", "Pi context changed before source restoration.");
			// Install Pi's equivalent reconstruction and its source map together, without changing message bytes.
			session.agent.state.messages = messages;
			return bindings;
		},
	};
}
