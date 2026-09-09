import { createHash } from "node:crypto";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { FlowModelInput } from "./model-input.js";
import { copyFlowPayload } from "./payload-copy.js";
import { type FlowInclusion, FlowLedgerError, type FlowReceiptLedger } from "./receipt-ledger.js";

export type FlowPayloadProjection = (payload: unknown) => Message[];
const record = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new FlowLedgerError("schema", "Invalid provider payload object.");
	return value as Record<string, unknown>;
};

function validateToolOrder(messages: unknown[], api: string): void {
	const pending = new Set<string>();
	const identity = (id: unknown): string => {
		if (typeof id !== "string" || !id.length) throw new FlowLedgerError("schema", "Invalid provider tool identity.");
		return id;
	};
	for (const item of messages) {
		const message = record(item);
		if (api === "openai-responses" && message.type === "reasoning") continue;
		if (
			(api === "openai-completions" && message.role === "tool") ||
			(api === "openai-responses" && message.type === "function_call_output")
		) {
			if (!pending.delete(identity(message.role === "tool" ? message.tool_call_id : message.call_id)))
				throw new FlowLedgerError("schema", "Provider payload has an unmatched tool result.");
			continue;
		}
		if (api === "openai-responses" && message.type === "function_call") {
			const id = identity(message.call_id);
			if (pending.has(id)) throw new FlowLedgerError("schema", "Provider payload repeats a tool call.");
			pending.add(id);
			continue;
		}
		if (pending.size) throw new FlowLedgerError("schema", "Provider payload interrupts unresolved tool calls.");
		if (message.role === "assistant" && message.tool_calls !== undefined) {
			if (!Array.isArray(message.tool_calls)) throw new FlowLedgerError("schema", "Invalid provider tool calls.");
			for (const value of message.tool_calls) {
				const call = record(value);
				const id = identity(call.id);
				if (call.type !== "function" || pending.has(id))
					throw new FlowLedgerError("schema", "Unsupported or repeated provider tool call.");
				pending.add(id);
			}
		}
		if (message.type === "custom_tool_call" || message.type === "custom_tool_call_output")
			throw new FlowLedgerError("schema", "Unsupported provider tool format.");
	}
	if (pending.size) throw new FlowLedgerError("schema", "Provider payload lacks required tool results.");
}

/** Project only user content from OpenAI-compatible payloads; metadata cannot establish inclusion. */
export function openAIFlowPayload(api: "openai-completions" | "openai-responses"): FlowPayloadProjection {
	return (payload) => {
		const messages = record(payload)[api === "openai-completions" ? "messages" : "input"];
		if (!Array.isArray(messages)) throw new FlowLedgerError("schema", "Provider payload has no message array.");
		validateToolOrder(messages, api);
		return messages.flatMap((item): Message[] => {
			const message = record(item);
			if (message.role !== "user") return [];
			if (api === "openai-responses" && message.type !== undefined && message.type !== "message")
				throw new FlowLedgerError("schema", "Invalid provider user message type.");
			const content =
				typeof message.content === "string"
					? [{ type: api === "openai-completions" ? "text" : "input_text", text: message.content }]
					: message.content;
			if (!Array.isArray(content)) throw new FlowLedgerError("schema", "Invalid provider user content.");
			const parts = content.map((value): TextContent | ImageContent => {
				const part = record(value);
				if (part.type === (api === "openai-completions" ? "text" : "input_text") && typeof part.text === "string")
					return { type: "text", text: part.text };
				const url =
					api === "openai-completions" && part.type === "image_url"
						? record(part.image_url).url
						: api === "openai-responses" && part.type === "input_image"
							? part.image_url
							: undefined;
				const match = typeof url === "string" ? /^data:([^;,]+);base64,([\s\S]*)$/.exec(url) : undefined;
				if (!match) throw new FlowLedgerError("schema", "Unsupported provider user content.");
				return { type: "image", mimeType: match[1], data: match[2] };
			});
			return [{ role: "user", content: parts, timestamp: 0 }];
		});
	};
}

/** Called after all ordinary payload transforms. Returns privately owned bytes for the provider. */
export async function admitFlowPayload(
	ledger: FlowReceiptLedger,
	composition: FlowModelInput,
	requestId: string,
	api: string,
	payload: unknown,
	project: FlowPayloadProjection,
	maxBytes: number,
): Promise<unknown> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
		throw new FlowLedgerError("capacity", "Invalid provider payload byte limit.");
	// Serialize before awaiting storage: later mutation of the caller's object cannot alter admission.
	const { serialized, owned } = copyFlowPayload(payload, api);
	const bytes = Buffer.byteLength(serialized);
	let failure: unknown;
	let inclusion: FlowInclusion[];
	try {
		if (bytes > maxBytes) throw new FlowLedgerError("capacity", "Provider payload exceeds its byte limit.");
		inclusion = composition.inspect(project(JSON.parse(serialized)));
	} catch (error) {
		failure = error;
		inclusion = composition.members.map(({ id, revision }) => ({ id, revision, disposition: "rejected" as const }));
	}
	const admitted = await ledger.payload(composition.attemptId, requestId, {
		api,
		bytes,
		hash: createHash("sha256").update(serialized).digest("hex"),
		inclusion,
	});
	if (failure) throw failure;
	if (!admitted) throw new FlowLedgerError("transition", "Provider payload withheld after transformation.");
	return owned;
}
