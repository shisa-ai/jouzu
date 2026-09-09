import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { FlowLedgerError } from "./receipt-ledger.js";

const record = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new FlowLedgerError("schema", "Invalid Bedrock content object.");
	return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, allowed: string[]) =>
	Object.keys(value).every((key) => allowed.includes(key));

/** Normalize AWS binary content and its serialized base64 representation identically. */
export function bedrockContent(
	content: unknown,
	allowCache = false,
	serialized = false,
): (TextContent | ImageContent)[] {
	if (!Array.isArray(content)) throw new FlowLedgerError("schema", "Invalid Bedrock content array.");
	return content.flatMap((value): (TextContent | ImageContent)[] => {
		const part = record(value);
		if (keys(part, ["text"]) && typeof part.text === "string") return [{ type: "text", text: part.text }];
		if (allowCache && keys(part, ["cachePoint"]) && part.cachePoint) {
			const cache = record(part.cachePoint);
			if (keys(cache, ["type", "ttl"]) && cache.type === "default" && (cache.ttl === undefined || cache.ttl === "1h"))
				return [];
		}
		if (keys(part, ["image"]) && part.image) {
			const image = record(part.image),
				source = record(image.source);
			if (
				keys(image, ["format", "source"]) &&
				keys(source, ["bytes"]) &&
				["jpeg", "png", "gif", "webp"].includes(image.format as string)
			) {
				const data =
					source.bytes instanceof Uint8Array
						? Buffer.from(source.bytes).toString("base64")
						: serialized
							? source.bytes
							: undefined;
				if (typeof data === "string" && Buffer.from(data, "base64").toString("base64") === data)
					return [{ type: "image", mimeType: `image/${image.format}`, data }];
			}
		}
		throw new FlowLedgerError("schema", "Unsupported Bedrock content.");
	});
}

export function bedrockToolResult(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const block = value as Record<string, unknown>;
	if (!keys(block, ["toolResult"]) || !block.toolResult) return undefined;
	const result = record(block.toolResult);
	return keys(result, ["toolUseId", "content", "status"]) &&
		typeof result.toolUseId === "string" &&
		result.toolUseId.length > 0 &&
		["success", "error"].includes(result.status as string)
		? result
		: undefined;
}
