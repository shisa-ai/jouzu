import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type FlowPayloadProjection, openAIFlowPayload } from "./provider-payload.js";
import { FlowLedgerError } from "./receipt-ledger.js";

/** Project the camel-case content consumed by Pi's Mistral wire conversion. */
export function mistralContent(content: unknown): (TextContent | ImageContent)[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) throw new FlowLedgerError("schema", "Invalid Mistral content.");
	return content.map((part) => {
		if (!part || typeof part !== "object" || Array.isArray(part))
			throw new FlowLedgerError("schema", "Invalid Mistral content part.");
		const keys = Object.keys(part);
		if (part.type === "text" && typeof part.text === "string" && keys.every((key) => ["type", "text"].includes(key)))
			return { type: "text", text: part.text };
		const url =
			part.type === "image_url" && keys.every((key) => ["type", "imageUrl"].includes(key)) ? part.imageUrl : undefined;
		const match = typeof url === "string" ? /^data:([^;,]+);base64,([\s\S]*)$/.exec(url) : undefined;
		if (!match) throw new FlowLedgerError("schema", "Unsupported Mistral content.");
		return { type: "image", mimeType: match[1], data: match[2] };
	});
}

export const mistralFlowPayload: FlowPayloadProjection = (payload) => {
	if (!payload || typeof payload !== "object" || !("messages" in payload) || !Array.isArray(payload.messages))
		throw new FlowLedgerError("schema", "Mistral payload has no message array.");
	return openAIFlowPayload("openai-completions")({
		messages: payload.messages.map((row) => ({
			...row,
			tool_calls: row.toolCalls,
			tool_call_id: row.toolCallId,
			...(row.role === "user"
				? {
						content: mistralContent(row.content).map((part) =>
							part.type === "text"
								? part
								: { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
						),
					}
				: {}),
		})),
	});
};
