import type { Message } from "@earendil-works/pi-ai";
import { googleContent, googleInputPreserved, googleToolResponse } from "./google-content.js";
import type { FlowPayloadProjection } from "./provider-payload.js";
import { FlowLedgerError } from "./receipt-ledger.js";

const record = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new FlowLedgerError("schema", "Invalid Google message or part.");
	return value as Record<string, unknown>;
};
const identity = (value: unknown): { name: string; id?: string } => {
	const item = record(value);
	if (
		typeof item.name !== "string" ||
		!item.name.length ||
		(item.id !== undefined && (typeof item.id !== "string" || !item.id.length))
	)
		throw new FlowLedgerError("schema", "Invalid Google function identity.");
	return { name: item.name, ...(typeof item.id === "string" ? { id: item.id } : {}) };
};

/** Project standalone user content after validating Google's grouped function responses. */
export const googleFlowPayload: FlowPayloadProjection = (payload) => {
	if (!googleInputPreserved(payload))
		throw new FlowLedgerError("schema", "Google SDK overrides request input after conversion.");
	const contents = record(payload).contents;
	if (!Array.isArray(contents)) throw new FlowLedgerError("schema", "Google payload has no content array.");
	const pending: { name: string; id?: string }[] = [];
	const projected: Message[] = [];
	let afterResult = false;
	for (const value of contents) {
		const row = record(value);
		if (!Array.isArray(row.parts)) throw new FlowLedgerError("schema", "Invalid Google message parts.");
		const parts = row.parts.map(record);
		if (row.role === "model") {
			if (pending.length) throw new FlowLedgerError("schema", "Google payload interrupts unresolved function calls.");
			for (const part of parts) {
				if (part.functionResponse !== undefined)
					throw new FlowLedgerError("schema", "Google function response has an invalid role.");
				if (part.functionCall === undefined) continue;
				const call = identity(part.functionCall);
				if (call.id !== undefined && pending.some((item) => item.id === call.id))
					throw new FlowLedgerError("schema", "Google payload repeats a function call.");
				pending.push(call);
			}
			afterResult = false;
		} else if (row.role === "user") {
			// Pi places pre-Gemini-3 tool images in a separate user row, even between grouped results.
			if (
				afterResult &&
				parts[0]?.text === "Tool result image:" &&
				parts.length > 1 &&
				parts.slice(1).every((part) => part.inlineData !== undefined)
			) {
				googleContent(parts);
				afterResult = false;
				continue;
			}
			let results = false,
				ordinary = false;
			const text: Record<string, unknown>[] = [];
			for (const part of parts) {
				if (part.functionResponse !== undefined) {
					const result = googleToolResponse(part);
					if (!result || ordinary)
						throw new FlowLedgerError("schema", "Invalid or misplaced Google function response.");
					const response = identity(result);
					// Without wire IDs Google associates responses by order, including repeated function names.
					const index = response.id === undefined ? 0 : pending.findIndex((call) => call.id === response.id);
					const call = pending[index];
					if (!call || call.name !== response.name || call.id !== response.id)
						throw new FlowLedgerError("schema", "Google payload has an unmatched function response.");
					pending.splice(index, 1);
					results = true;
				} else {
					if (pending.length)
						throw new FlowLedgerError("schema", "Google payload interrupts unresolved function calls.");
					ordinary = true;
					text.push(part);
				}
			}
			const content = googleContent(text);
			if (!results && content.length) projected.push({ role: "user", content, timestamp: 0 });
			afterResult = results;
		} else throw new FlowLedgerError("schema", "Unsupported Google message role.");
	}
	if (pending.length) throw new FlowLedgerError("schema", "Google payload lacks required function responses.");
	return projected;
};
