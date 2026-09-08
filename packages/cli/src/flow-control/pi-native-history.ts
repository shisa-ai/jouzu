import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { NativeRequestSource } from "./native-request-store.js";
import { verifyPiHistoryEntry } from "./pi-history-receipts.js";
import { recoverNativeSources } from "./pi-native-source-recovery.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowSubmissionStore } from "./submission-store.js";

interface Claimed {
	message: AgentMessage;
	id?: string;
	revision?: number;
	operationId?: string;
	prompt?: { inputIndex: number; messageIndex: number };
	nativeTimestamp?: boolean;
}

const matchesInput = (input: Claimed, message: AgentMessage) =>
	isDeepStrictEqual(input.message, input.nativeTimestamp ? { ...message, timestamp: 0 } : message);

/** Match native input order after Pi's awaited transcript listener, including unowned queue entries. */
export class PiNativeHistory {
	private readonly claimed: Claimed[] = [];
	private readonly prompts: Claimed[] = [];
	private readonly starting = new WeakMap<object, Claimed>();
	private sources = new WeakMap<object, Omit<NativeRequestSource, "index">[]>();
	private readonly unsubscribe: () => void;
	constructor(session: AgentSession, store: FlowSubmissionStore) {
		this.unsubscribe = session.agent.subscribe(async (event) => {
			if (session.sessionId !== store.scope.sessionId)
				throw new FlowLedgerError("stale", "Native history attachment belongs to another session.");
			if (
				event.type === "agent_end" ||
				(event.type === "message_start" &&
					event.message.role === "assistant" &&
					["error", "aborted"].includes(event.message.stopReason))
			) {
				this.claimed.length = 0;
				this.prompts.length = 0;
			}
			if (event.type === "message_start" && (this.prompts.length || this.claimed.length)) {
				const input = this.prompts.length ? this.prompts.shift() : this.claimed.shift();
				if (!input || !matchesInput(input, event.message))
					throw new FlowLedgerError("identity", "Native consumed message differs from its observed input.");
				this.starting.set(event.message, input);
				if (input.prompt && input.operationId) await store.recordPromptClaim(input.operationId, input.prompt);
				if (input.operationId) {
					let reference: Pick<NativeRequestSource, "prompt" | "queue">;
					if (input.prompt) reference = { prompt: { ...input.prompt } };
					else {
						if (!input.id || input.revision === undefined)
							throw new FlowLedgerError("identity", "Native source has no queue identity.");
						reference = { queue: { id: input.id, revision: input.revision } };
					}
					const sources = this.sources.get(event.message) ?? [];
					sources.push({
						operationId: input.operationId,
						messageHash: createHash("sha256").update(JSON.stringify(event.message)).digest("hex"),
						...reference,
					});
					this.sources.set(event.message, sources);
				}
			}
			if (event.type !== "message_end") return;
			const input = this.starting.get(event.message);
			this.starting.delete(event.message);
			if (!input?.operationId) return;
			if (!matchesInput(input, event.message))
				throw new FlowLedgerError("identity", "Native consumed message changed before history persistence.");
			const manager = session.sessionManager;
			const entry = manager.getLeafEntry();
			const matches =
				entry?.type === "message"
					? entry.message === event.message
					: entry?.type === "custom_message" &&
						event.message.role === "custom" &&
						entry.content === event.message.content &&
						entry.customType === event.message.customType;
			if (!matches || !entry)
				throw new FlowLedgerError("identity", "Native transcript entry differs from its consumed message.");
			manager.flush();
			const evidence = await verifyPiHistoryEntry(manager, entry.id);
			if (evidence.kind === "memory") return;
			if (evidence.kind !== "persisted")
				throw new FlowLedgerError("identity", "Native transcript entry was not persisted.");
			const history = { entryId: entry.id, entryHash: evidence.entryHash };
			if (input.prompt) await store.recordPromptHistory(input.operationId, { ...input.prompt, ...history });
			else {
				if (!input.id || input.revision === undefined)
					throw new FlowLedgerError("identity", "Native history has no queue identity.");
				await store.recordQueueHistory(input.operationId, { id: input.id, revision: input.revision, ...history });
			}
		});
	}
	/** The v1 prompt locator addresses direct input positions, including non-waking context. */
	async recordContext(
		session: AgentSession,
		store: FlowSubmissionStore,
		operationId: string,
		inputIndex: number,
		message: AgentMessage,
		entryId: string,
	): Promise<void> {
		const prompt = { inputIndex, messageIndex: 0 };
		const captured = structuredClone(message);
		const assertContent = () => {
			const entry = session.sessionManager.getEntry(entryId);
			if (
				captured.role !== "custom" ||
				!isDeepStrictEqual(captured, message) ||
				entry?.type !== "custom_message" ||
				entry.customType !== captured.customType ||
				!isDeepStrictEqual(entry.content, captured.content) ||
				entry.display !== captured.display ||
				!isDeepStrictEqual(entry.details, captured.details)
			)
				throw new FlowLedgerError("identity", "Non-waking history differs from its retained source.");
		};
		assertContent();
		await store.recordPromptClaim(operationId, prompt);
		const manager = session.sessionManager;
		manager.flush();
		const evidence = await verifyPiHistoryEntry(manager, entryId);
		if (evidence.kind !== "persisted") throw new FlowLedgerError("identity", "Non-waking context was not persisted.");
		assertContent();
		await store.recordPromptHistory(operationId, { ...prompt, entryId, entryHash: evidence.entryHash });
		assertContent();
		this.sources.set(message, [
			{ operationId, prompt, messageHash: createHash("sha256").update(JSON.stringify(message)).digest("hex") },
		]);
	}

	accept(inputs: Claimed[]): void {
		this.claimed.push(...structuredClone(inputs));
	}
	identify(messages: AgentMessage[]): NativeRequestSource[] {
		const counts = new Map<object, number>();
		for (const message of messages) counts.set(message, (counts.get(message) ?? 0) + 1);
		const occurrences = new Map<object, number>();
		return messages.flatMap((message, index) => {
			const sources = this.sources.get(message);
			const occurrence = occurrences.get(message) ?? 0;
			occurrences.set(message, occurrence + 1);
			// A surviving alias cannot identify which original occurrence was removed.
			const source = sources?.length === counts.get(message) ? sources?.[occurrence] : undefined;
			return source ? [{ ...structuredClone(source), index }] : [];
		});
	}
	async recover(
		session: AgentSession,
		store: FlowSubmissionStore,
		assertActive: () => void,
	): Promise<{ recovered: number; unresolved: number }> {
		const recovery = await recoverNativeSources(session, store);
		assertActive();
		this.sources = recovery.apply();
		return { recovered: recovery.recovered, unresolved: recovery.unresolved };
	}
	async validateSources(members: NativeRequestSource[], store: FlowSubmissionStore): Promise<void> {
		const records = await store.snapshot();
		for (const member of members) {
			const dispatch = records.find((record) => record.dispatch?.operationId === member.operationId)?.dispatch;
			const claimed = member.prompt
				? dispatch?.promptClaims?.some(
						(claim) =>
							claim.inputIndex === member.prompt?.inputIndex && claim.messageIndex === member.prompt.messageIndex,
					)
				: dispatch?.queueClaims?.some(
						(claim) => claim.id === member.queue?.id && claim.revision === member.queue.revision && claim.consumed,
					);
			if (!claimed) throw new FlowLedgerError("identity", "Native source has no retained consumption receipt.");
		}
	}
	observePrompt(
		operationId: string,
		inputIndex: number,
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): () => void {
		if (this.prompts.length) throw new FlowLedgerError("busy", "Native prompt history is already awaiting input.");
		const nativeTimestamp = typeof input === "string";
		const messages: AgentMessage[] =
			typeof input === "string"
				? [{ role: "user", content: [{ type: "text", text: input }, ...(images ?? [])], timestamp: 0 }]
				: Array.isArray(input)
					? input
					: [input];
		const captured = messages.map((message, messageIndex) => ({
			message: structuredClone(message),
			operationId,
			prompt: { inputIndex, messageIndex },
			nativeTimestamp,
		}));
		this.prompts.push(...captured);
		return () => {
			for (const item of captured) {
				const index = this.prompts.indexOf(item);
				if (index !== -1) this.prompts.splice(index, 1);
			}
		};
	}
	close(): void {
		this.unsubscribe();
		this.claimed.length = 0;
		this.prompts.length = 0;
	}
}
