import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type FlowPayloadProjection, openAIFlowPayload } from "./provider-payload.js";
import { FlowLedgerError } from "./receipt-ledger.js";

/** Pi messages carry text and image content directly inside context.messages. */
export function piMessagesContent(content: unknown): (TextContent | ImageContent)[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) throw new FlowLedgerError("schema", "Invalid Pi message content.");
	return content.map((part) => {
		if (!part || typeof part !== "object" || Array.isArray(part))
			throw new FlowLedgerError("schema", "Invalid Pi message content part.");
		const keys = Object.keys(part);
		if (part.type === "text" && typeof part.text === "string" && keys.every((key) => ["type", "text"].includes(key)))
			return { type: "text", text: part.text };
		if (
			part.type === "image" &&
			typeof part.mimeType === "string" &&
			typeof part.data === "string" &&
			keys.every((key) => ["type", "mimeType", "data"].includes(key))
		)
			return { type: "image", mimeType: part.mimeType, data: part.data };
		throw new FlowLedgerError("schema", "Unsupported Pi message content.");
	});
}

export function piMessagesRows(payload: unknown): unknown[] {
	const context = payload && typeof payload === "object" && "context" in payload ? payload.context : undefined;
	const messages = context && typeof context === "object" && "messages" in context ? context.messages : undefined;
	if (!Array.isArray(messages)) throw new FlowLedgerError("schema", "Pi payload has no context message array.");
	return messages;
}

export const piMessagesFlowPayload: FlowPayloadProjection = (payload) =>
	openAIFlowPayload("openai-completions")({
		messages: piMessagesRows(payload).map((value) => {
			if (!value || typeof value !== "object" || !("role" in value) || !("content" in value))
				throw new FlowLedgerError("schema", "Invalid Pi payload message.");
			const row = value as Record<string, unknown>;
			if (row.role === "toolResult") return { role: "tool", tool_call_id: row.toolCallId };
			if (row.role === "assistant" && Array.isArray(row.content))
				return {
					role: "assistant",
					tool_calls: row.content
						.filter((part) => part.type === "toolCall")
						.map((part) => ({ id: part.id, type: "function" })),
				};
			if (row.role !== "user") throw new FlowLedgerError("schema", "Unsupported Pi payload message role.");
			return {
				role: "user",
				content: piMessagesContent(row.content).map((part) =>
					part.type === "text"
						? part
						: { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
				),
			};
		}),
	});
