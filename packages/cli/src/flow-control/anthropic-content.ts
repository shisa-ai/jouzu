import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { FlowLedgerError } from "./receipt-ledger.js";

/** Normalize only text and inline images; tool references cannot stand in for result content. */
export function anthropicContent(value: unknown): (TextContent | ImageContent)[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) throw new FlowLedgerError("schema", "Invalid Anthropic content.");
	return value.map((part) => {
		if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
		if (
			part?.type === "image" &&
			part.source?.type === "base64" &&
			typeof part.source.media_type === "string" &&
			typeof part.source.data === "string"
		)
			return { type: "image", mimeType: part.source.media_type, data: part.source.data };
		throw new FlowLedgerError("schema", "Unsupported Anthropic content block.");
	});
}
