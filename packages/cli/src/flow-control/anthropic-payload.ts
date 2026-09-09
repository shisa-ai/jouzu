import type { Message } from "@earendil-works/pi-ai";
import { anthropicContent } from "./anthropic-content.js";
import type { FlowPayloadProjection } from "./provider-payload.js";
import { FlowLedgerError } from "./receipt-ledger.js";

const record = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new FlowLedgerError("schema", "Invalid Anthropic message or content block.");
	return value as Record<string, unknown>;
};
const identity = (value: unknown): string => {
	if (typeof value !== "string" || !value.length)
		throw new FlowLedgerError("schema", "Invalid Anthropic tool identity.");
	return value;
};

/** Project standalone user instructions; grouped tool output and displaced text cannot acknowledge them. */
export const anthropicFlowPayload: FlowPayloadProjection = (payload) => {
	const messages = record(payload).messages;
	if (!Array.isArray(messages)) throw new FlowLedgerError("schema", "Anthropic payload has no message array.");
	const pending = new Set<string>();
	const projected: Message[] = [];
	for (const value of messages) {
		const message = record(value);
		const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		if (!Array.isArray(blocks)) throw new FlowLedgerError("schema", "Invalid Anthropic message content.");
		const content = blocks.map(record);
		if (message.role === "assistant") {
			if (pending.size) throw new FlowLedgerError("schema", "Anthropic payload interrupts unresolved tool calls.");
			for (const block of content) {
				if (block.type === "tool_result")
					throw new FlowLedgerError("schema", "Anthropic tool result has an invalid role.");
				if (block.type !== "tool_use") continue;
				const id = identity(block.id);
				identity(block.name);
				if (pending.has(id)) throw new FlowLedgerError("schema", "Anthropic payload repeats a tool call.");
				pending.add(id);
			}
		} else if (message.role === "user") {
			let results = false,
				ordinary = false;
			const text: Record<string, unknown>[] = [];
			for (const block of content) {
				if (block.type === "tool_result") {
					if (ordinary || !pending.delete(identity(block.tool_use_id)))
						throw new FlowLedgerError("schema", "Anthropic payload has an unmatched or misplaced tool result.");
					if (block.is_error !== undefined && typeof block.is_error !== "boolean")
						throw new FlowLedgerError("schema", "Invalid Anthropic tool error status.");
					results = true;
				} else {
					if (pending.size) throw new FlowLedgerError("schema", "Anthropic payload interrupts unresolved tool calls.");
					ordinary = true;
					text.push(block);
				}
			}
			if (pending.size) throw new FlowLedgerError("schema", "Anthropic payload lacks required tool results.");
			const parts = anthropicContent(text);
			if (!results && parts.length) projected.push({ role: "user", content: parts, timestamp: 0 });
		} else if (message.role === "system") {
			if (pending.size) throw new FlowLedgerError("schema", "Anthropic payload interrupts unresolved tool calls.");
			// Pi can insert historical effort settings as system rows; they carry no admitted user content.
		} else throw new FlowLedgerError("schema", "Unsupported Anthropic message role.");
	}
	if (pending.size) throw new FlowLedgerError("schema", "Anthropic payload lacks required tool results.");
	return projected;
};
