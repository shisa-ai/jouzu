import { bedrockContent, bedrockToolResult } from "./bedrock-content.js";
import { type FlowPayloadProjection, openAIFlowPayload } from "./provider-payload.js";
import { FlowLedgerError } from "./receipt-ledger.js";

/** Preserve user content and tool ordering when projecting Converse messages. */
export const bedrockFlowPayload: FlowPayloadProjection = (payload) => {
	if (!payload || typeof payload !== "object" || !("messages" in payload) || !Array.isArray(payload.messages))
		throw new FlowLedgerError("schema", "Bedrock payload has no message array.");
	const messages: unknown[] = [];
	for (const row of payload.messages) {
		if (!row || !Array.isArray(row.content)) throw new FlowLedgerError("schema", "Invalid Bedrock message.");
		if (row.role === "assistant") {
			messages.push({
				role: "assistant",
				tool_calls: row.content
					.filter((part: { toolUse?: unknown }) => part.toolUse)
					.map((part: { toolUse: { toolUseId: string } }) => ({ id: part.toolUse.toolUseId, type: "function" })),
			});
			continue;
		}
		if (row.role !== "user") throw new FlowLedgerError("schema", "Unsupported Bedrock message role.");
		const results = row.content.filter((part: { toolResult?: unknown }) => part.toolResult);
		if (results.length) {
			for (const part of results) {
				const result = bedrockToolResult(part);
				if (!result) throw new FlowLedgerError("schema", "Invalid Bedrock tool result.");
				messages.push({ role: "tool", tool_call_id: result.toolUseId });
			}
		}
		const parts = bedrockContent(
			row.content.filter((part: { toolResult?: unknown }) => !part.toolResult),
			true,
			true,
		);
		if (parts.length || !results.length)
			messages.push({
				role: "user",
				content: parts.map((part) =>
					part.type === "text"
						? part
						: { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
				),
			});
	}
	return openAIFlowPayload("openai-completions")({ messages });
};
