import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import { anthropicContent } from "./anthropic-content.js";
import type { NativePayloadSource, NativeSourceCapture } from "./native-request-store.js";
import { payloadRowOrigin } from "./payload-copy.js";
import { openAIFlowPayload } from "./provider-payload.js";
import { FlowLedgerError } from "./receipt-ledger.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type SourceAPI = "openai-completions" | "openai-responses" | "anthropic-messages";
const toolIdentity = (message: unknown, api: SourceAPI) => {
	if (!message || typeof message !== "object") return undefined;
	if (api === "anthropic-messages") {
		if (
			!("type" in message) ||
			message.type !== "tool_result" ||
			!("tool_use_id" in message) ||
			typeof message.tool_use_id !== "string" ||
			("is_error" in message && typeof message.is_error !== "boolean")
		)
			return undefined;
		return hash({
			type: message.type,
			toolUseId: message.tool_use_id,
			isError: "is_error" in message ? message.is_error : false,
		});
	}
	if (api === "openai-responses") {
		if (
			!("type" in message) ||
			message.type !== "function_call_output" ||
			!("call_id" in message) ||
			typeof message.call_id !== "string"
		)
			return undefined;
		return hash({ type: message.type, callId: message.call_id });
	}
	if (
		!("role" in message) ||
		message.role !== "tool" ||
		!("tool_call_id" in message) ||
		typeof message.tool_call_id !== "string"
	)
		return undefined;
	return hash({ role: "tool", toolCallId: message.tool_call_id, name: "name" in message ? message.name : undefined });
};
const contentHash = (message: unknown, api: SourceAPI) => {
	if (toolIdentity(message, api) && message && typeof message === "object") {
		const content =
			api === "openai-responses"
				? "output" in message
					? message.output
					: undefined
				: "content" in message
					? message.content
					: undefined;
		return api === "anthropic-messages"
			? hash(anthropicContent(content))
			: typeof content === "string"
				? hash([{ type: "text", text: content }])
				: undefined;
	}
	if (api === "anthropic-messages") {
		if (
			!message ||
			typeof message !== "object" ||
			!("role" in message) ||
			message.role !== "user" ||
			!("content" in message)
		)
			return undefined;
		return hash(anthropicContent(message.content));
	}
	const [projected] = openAIFlowPayload(api)({ [api === "openai-responses" ? "input" : "messages"]: [message] });
	return projected ? hash(projected.content) : undefined;
};
const rows = (payload: unknown, api: SourceAPI): unknown[] => {
	const key = api === "openai-responses" ? "input" : "messages";
	const result = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[key] : undefined;
	return Array.isArray(result) ? result : [];
};

/** Source-to-wire associations supplied by the provider, followed through final payload transforms. */
export class NativePayloadSources {
	private readonly sources = new Map<Message, number[]>();
	private readonly tracked = new Set<number>();
	private readonly expected = new Map<number, string>();
	private readonly links = new Map<
		number,
		{ output: unknown; contentHash?: string; changed: boolean; toolIdentity?: string } | null
	>();
	constructor(
		messages: Message[],
		private readonly capture?: { members: { index: number }[]; model?: NativeSourceCapture["model"] },
		private readonly api: SourceAPI = "openai-completions",
	) {
		for (const [index, message] of messages.entries()) {
			const positions = this.sources.get(message) ?? [];
			positions.push(index);
			this.sources.set(message, positions);
			if (message.role === "user" || message.role === "toolResult")
				this.expected.set(
					index,
					hash(typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content),
				);
		}
		for (const member of capture?.model?.members ?? []) if (member.index !== undefined) this.tracked.add(member.index);
	}
	observe(source: Message, output: unknown): void {
		const indices = this.sources.get(source);
		if (indices?.length !== 1 || !this.tracked.has(indices[0])) return;
		const index = indices[0];
		if (this.links.has(index)) {
			this.links.set(index, null);
			return;
		}
		if (source.role !== "user" && source.role !== "toolResult")
			throw new FlowLedgerError("identity", "Provider source mapping has an unsupported role.");
		let convertedHash: string | undefined;
		try {
			convertedHash = contentHash(output, this.api);
		} catch {
			/* Unsupported content has no receipt. */
		}
		if (!convertedHash) {
			this.links.set(index, null);
			return;
		}
		const identity = source.role === "toolResult" ? toolIdentity(output, this.api) : undefined;
		this.links.set(index, {
			output,
			contentHash: convertedHash,
			changed: convertedHash !== this.expected.get(index) || (source.role === "toolResult" && identity === undefined),
			...(identity ? { toolIdentity: identity } : {}),
		});
	}
	inspect(api: string, payload: unknown, serialized: unknown): NativePayloadSource[] | undefined {
		if (!this.capture) return undefined;
		const finalRows = rows(payload, this.api),
			ownedRows = rows(serialized, this.api);
		return this.capture.members.map((source, offset): NativePayloadSource => {
			const model = this.capture?.model?.members[offset];
			const unresolved: NativePayloadSource = { sourceIndex: source.index, disposition: "unresolved" };
			if (api !== this.api || model?.index === undefined || model.status === "unresolved") return unresolved;
			const link = this.links.get(model.index);
			if (!link) return unresolved;
			const blockResult = this.api === "anthropic-messages" && link.toolIdentity !== undefined;
			const matches = finalRows.flatMap((row, index): { index: number; blockIndex?: number }[] => {
				if (!blockResult) return payloadRowOrigin(row) === payloadRowOrigin(link.output) ? [{ index }] : [];
				const blocks = row && typeof row === "object" && "content" in row ? row.content : undefined;
				return Array.isArray(blocks)
					? blocks.flatMap((block, blockIndex) =>
							payloadRowOrigin(block) === payloadRowOrigin(link.output) ? [{ index, blockIndex }] : [],
						)
					: [];
			});
			if (matches.length !== 1) return unresolved;
			const { index, blockIndex } = matches[0];
			try {
				const select = (row: unknown) => {
					if (blockIndex === undefined) return row;
					if (
						!row ||
						typeof row !== "object" ||
						!("role" in row) ||
						row.role !== "user" ||
						!("content" in row) ||
						!Array.isArray(row.content)
					)
						return undefined;
					return row.content[blockIndex];
				};
				const final = select(finalRows[index]),
					owned = select(ownedRows[index]);
				const finalHash = contentHash(final, this.api),
					ownedHash = contentHash(owned, this.api);
				if (
					!finalHash ||
					finalHash !== ownedHash ||
					(link.toolIdentity &&
						(toolIdentity(final, this.api) !== link.toolIdentity ||
							toolIdentity(owned, this.api) !== link.toolIdentity))
				)
					return { sourceIndex: source.index, disposition: "changed" };
				return {
					sourceIndex: source.index,
					disposition:
						model.status === "changed" || link.changed || finalHash !== link.contentHash ? "changed" : "included",
					index,
					...(blockIndex !== undefined ? { blockIndex } : {}),
					contentHash: finalHash,
				};
			} catch {
				return { sourceIndex: source.index, disposition: "changed" };
			}
		});
	}
}
