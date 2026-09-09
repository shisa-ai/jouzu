import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { FlowLedgerError } from "./receipt-ledger.js";

/** Qualify the text and inline image fields preserved by Google's SDK conversion. */
export function googleContent(parts: unknown): (TextContent | ImageContent)[] {
	if (!Array.isArray(parts)) throw new FlowLedgerError("schema", "Invalid Google user content.");
	return parts.map((part) => {
		if (!part || typeof part !== "object" || Array.isArray(part))
			throw new FlowLedgerError("schema", "Invalid Google content part.");
		const keys = Object.keys(part);
		if (keys.length === 1 && typeof part.text === "string") return { type: "text", text: part.text };
		const data = part.inlineData;
		if (
			keys.length === 1 &&
			data &&
			typeof data === "object" &&
			!Array.isArray(data) &&
			Object.keys(data).every((key) => key === "mimeType" || key === "data") &&
			typeof data.mimeType === "string" &&
			typeof data.data === "string"
		)
			return { type: "image", mimeType: data.mimeType, data: data.data };
		throw new FlowLedgerError("schema", "Unsupported Google user content.");
	});
}

export function googleToolResponse(part: unknown): Record<string, unknown> | undefined {
	if (!part || typeof part !== "object" || Array.isArray(part) || Object.keys(part).length !== 1) return undefined;
	const response = "functionResponse" in part ? part.functionResponse : undefined;
	if (
		!response ||
		typeof response !== "object" ||
		Array.isArray(response) ||
		Object.keys(response).some((key) => !["name", "id", "response", "parts"].includes(key)) ||
		("parts" in response && !Array.isArray(response.parts))
	)
		return undefined;
	return response as Record<string, unknown>;
}

/** The SDK applies extraBody after conversion; an input override has no source mapping. */
export function googleInputPreserved(payload: unknown): boolean {
	if (!payload || typeof payload !== "object" || !("config" in payload)) return true;
	const config = payload.config;
	if (!config || typeof config !== "object" || !("httpOptions" in config)) return true;
	const options = config.httpOptions;
	if (!options || typeof options !== "object" || !("extraBody" in options)) return true;
	const extra = options.extraBody;
	return (
		extra === undefined ||
		extra === null ||
		(typeof extra === "object" && !Array.isArray(extra) && !Object.hasOwn(extra, "contents"))
	);
}
