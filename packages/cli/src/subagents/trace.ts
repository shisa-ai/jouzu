import { open } from "node:fs/promises";
import { CatalogMessageId, catalogText, defaultCatalog } from "../cli-messages.js";
import type { CatalogBundle } from "../locale-catalog.js";

export interface TraceQuery {
	offset?: number;
	limit?: number;
	query?: string;
	kind?: "all" | "messages" | "tools" | "errors" | "compaction";
	entryId?: string;
}
export interface TraceRecord {
	entryId: string;
	type: string;
	timestamp?: string;
	role?: string;
	text?: string;
	calls?: { id: string; name: string; arguments: unknown }[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	stopReason?: string;
	summary?: string;
	truncated?: boolean;
	preview?: string;
}
export interface TracePage {
	records: TraceRecord[];
	nextOffset: number | null;
	totalBytes: number;
	notice?: string;
}
export const TRACE_SCAN_BYTES = 8 * 1024 * 1024;
export const TRACE_RESPONSE_BYTES = 46_000;
export const TRACE_RECORD_BYTES = 24_000;
export const TRACE_DEFAULT_LIMIT = 20;
export const TRACE_MAX_LIMIT = 100;

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}
function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
function project(entry: Record<string, unknown>): TraceRecord | undefined {
	if (typeof entry.id !== "string" || typeof entry.type !== "string") return undefined;
	const base = { entryId: entry.id, type: entry.type, timestamp: string(entry.timestamp) };
	if (entry.type === "compaction" || entry.type === "branch_summary")
		return { ...base, summary: string(entry.summary) ?? "" };
	if (entry.type === "custom_message") return { ...base, role: "custom", text: textContent(entry.content) };
	const message = object(entry.message);
	if (entry.type !== "message" || !message) return undefined;
	const result: TraceRecord = { ...base, role: string(message.role), text: textContent(message.content) };
	if (message.role === "assistant") {
		result.calls = Array.isArray(message.content)
			? message.content.flatMap((value: unknown) => {
					const part = object(value);
					return part?.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string"
						? [{ id: part.id, name: part.name, arguments: part.arguments }]
						: [];
				})
			: [];
		result.stopReason = string(message.stopReason);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			result.isError = true;
			if (typeof message.errorMessage === "string") result.text += `\n${message.errorMessage}`;
		}
	}
	if (message.role === "toolResult") {
		result.toolCallId = string(message.toolCallId);
		result.toolName = string(message.toolName);
		const details = object(message.details);
		result.isError = message.isError === true || details?.error === true || details?.ok === false;
	}
	if (message.role === "bashExecution") {
		result.text = `${string(message.command) ?? ""}\n${string(message.output) ?? ""}`;
		result.isError = message.cancelled === true || (typeof message.exitCode === "number" && message.exitCode !== 0);
	}
	return result;
}
function matches(record: TraceRecord, options: TraceQuery): boolean {
	if (options.entryId && record.entryId !== options.entryId) return false;
	if (options.kind === "tools" && !record.calls?.length && record.role !== "toolResult") return false;
	if (options.kind === "errors" && !record.isError) return false;
	if (options.kind === "compaction" && record.type !== "compaction" && record.type !== "branch_summary") return false;
	if (options.kind === "messages" && record.type !== "message" && record.type !== "custom_message") return false;
	return !options.query || JSON.stringify(record).toLowerCase().includes(options.query.toLowerCase());
}
function bounded(record: TraceRecord): TraceRecord {
	const json = JSON.stringify(record);
	if (Buffer.byteLength(json) <= TRACE_RECORD_BYTES) return record;
	// Preserve routing fields even when a large arguments/result object needs a preview.
	const bytes = Buffer.from(json);
	let end = 16_000;
	while ((bytes[end] & 0xc0) === 0x80) end--;
	// JSON escaping can expand the preview again, so bound its serialized size too.
	const preview: TraceRecord = {
		entryId: record.entryId.slice(0, 256),
		type: String(record.type).slice(0, 256),
		timestamp: record.timestamp?.slice(0, 256),
		role: record.role?.slice(0, 256),
		toolCallId: record.toolCallId?.slice(0, 256),
		toolName: record.toolName?.slice(0, 256),
		isError: record.isError,
		truncated: true,
		preview: bytes.subarray(0, end).toString("utf8"),
	};
	while (Buffer.byteLength(JSON.stringify(preview)) > TRACE_RECORD_BYTES) {
		end = Math.floor(end / 2);
		while ((bytes[end] & 0xc0) === 0x80) end--;
		preview.preview = bytes.subarray(0, end).toString("utf8");
	}
	return preview;
}

/** Read without opening a SessionManager: inspecting a rollout must never migrate or rewrite it. */
export async function readSessionTrace(
	sessionFile: string,
	options: TraceQuery = {},
	catalog: CatalogBundle = defaultCatalog(),
): Promise<TracePage> {
	const { offset = 0, limit = TRACE_DEFAULT_LIMIT } = options;
	const msg = (id: CatalogMessageId, args?: Readonly<Record<string, string | number>>) =>
		catalogText(catalog, id, args);
	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > TRACE_MAX_LIMIT)
		throw new Error(msg(CatalogMessageId.subagentTraceBounds));
	if (options.kind !== undefined && !["all", "messages", "tools", "errors", "compaction"].includes(options.kind))
		throw new Error(msg(CatalogMessageId.subagentTraceKind));
	if (
		(options.query !== undefined && (typeof options.query !== "string" || options.query.length > 2000)) ||
		(options.entryId !== undefined && typeof options.entryId !== "string")
	)
		throw new Error(msg(CatalogMessageId.subagentTraceQuery));
	const file = await open(sessionFile, "r");
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new Error(msg(CatalogMessageId.subagentTraceNotRegularFile));
		if (offset > stat.size) throw new Error(msg(CatalogMessageId.subagentTracePastEnd));
		if (offset) {
			const previous = Buffer.alloc(1);
			await file.read(previous, 0, 1, offset - 1);
			if (previous[0] !== 10) throw new Error(msg(CatalogMessageId.subagentTraceLineBoundary));
		}
		const records: TraceRecord[] = [];
		let position = offset;
		let lineStart = offset;
		let bytes = 0;
		let pending = Buffer.alloc(0);
		const page = (nextOffset: number | null, notice?: string): TracePage => ({
			records,
			nextOffset,
			totalBytes: stat.size,
			...(notice ? { notice } : {}),
		});
		while (position < stat.size && position - offset < TRACE_SCAN_BYTES) {
			const chunk = Buffer.alloc(Math.min(64 * 1024, stat.size - position, TRACE_SCAN_BYTES - (position - offset)));
			const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
			if (!bytesRead) break;
			position += bytesRead;
			pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
			let start = 0;
			for (let end = pending.indexOf(10, start); end !== -1; end = pending.indexOf(10, start)) {
				const line = pending.subarray(start, end).toString("utf8");
				const nextLine = lineStart + end - start + 1;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					throw new Error(msg(CatalogMessageId.subagentTraceMalformedEntry, { offset: lineStart }));
				}
				const entry = object(parsed);
				const record = entry ? project(entry) : undefined;
				if (record && matches(record, options)) {
					const value = bounded(record);
					const size = Buffer.byteLength(JSON.stringify(value));
					if (records.length && bytes + size > TRACE_RESPONSE_BYTES)
						return page(lineStart, "Response limit reached. Continue with nextOffset.");
					records.push(value);
					bytes += size;
					if (records.length >= limit) return page(nextLine < stat.size ? nextLine : null);
				}
				lineStart = nextLine;
				start = end + 1;
			}
			pending = pending.subarray(start);
		}
		if (position < stat.size) {
			if (lineStart === offset) throw new Error(msg(CatalogMessageId.subagentTraceEntryTooLarge));
			return page(lineStart, "Scan limit reached. Continue with nextOffset.");
		}
		if (pending.length)
			return page(lineStart, "The last JSONL line is incomplete; retry nextOffset after the child writes more output.");
		return page(null);
	} finally {
		await file.close();
	}
}
