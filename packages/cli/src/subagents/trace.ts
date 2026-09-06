import { open } from "node:fs/promises";

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
const SCAN_BYTES = 8 * 1024 * 1024;
const RESPONSE_BYTES = 48_000;
const RECORD_BYTES = 24_000;

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}
function project(entry: Record<string, any>): TraceRecord | undefined {
	if (typeof entry.id !== "string") return undefined;
	const base = { entryId: entry.id, type: entry.type, timestamp: entry.timestamp };
	if (entry.type === "compaction" || entry.type === "branch_summary")
		return { ...base, summary: typeof entry.summary === "string" ? entry.summary : "" };
	if (entry.type === "custom_message") return { ...base, role: "custom", text: textContent(entry.content) };
	if (entry.type !== "message" || !entry.message) return undefined;
	const message = entry.message;
	const result: TraceRecord = { ...base, role: message.role, text: textContent(message.content) };
	if (message.role === "assistant") {
		result.calls = Array.isArray(message.content)
			? message.content
					.filter((part: any) => part?.type === "toolCall")
					.map((part: any) => ({ id: part.id, name: part.name, arguments: part.arguments }))
			: [];
		result.stopReason = message.stopReason;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			result.isError = true;
			if (typeof message.errorMessage === "string") result.text += `\n${message.errorMessage}`;
		}
	}
	if (message.role === "toolResult") {
		result.toolCallId = message.toolCallId;
		result.toolName = message.toolName;
		result.isError = message.isError === true || message.details?.error === true || message.details?.ok === false;
	}
	if (message.role === "bashExecution") {
		result.text = `${message.command ?? ""}\n${message.output ?? ""}`;
		result.isError = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
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
	if (Buffer.byteLength(json) <= RECORD_BYTES) return record;
	// Preserve routing fields even when a large arguments/result object needs a preview.
	const bytes = Buffer.from(json);
	let end = 16_000;
	while ((bytes[end] & 0xc0) === 0x80) end--;
	return {
		entryId: record.entryId,
		type: record.type,
		timestamp: record.timestamp,
		role: record.role,
		toolCallId: record.toolCallId,
		toolName: record.toolName,
		isError: record.isError,
		truncated: true,
		preview: bytes.subarray(0, end).toString("utf8"),
	};
}

/** Read without opening a SessionManager: inspecting a rollout must never migrate or rewrite it. */
export async function readSessionTrace(sessionFile: string, options: TraceQuery = {}): Promise<TracePage> {
	const { offset = 0, limit = 20 } = options;
	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100)
		throw new Error("Trace: offset must be a nonnegative byte cursor and limit must be 1–100.");
	if (options.kind !== undefined && !["all", "messages", "tools", "errors", "compaction"].includes(options.kind))
		throw new Error("Trace: choose all, messages, tools, errors, or compaction.");
	if (
		(options.query !== undefined && (typeof options.query !== "string" || options.query.length > 2000)) ||
		(options.entryId !== undefined && typeof options.entryId !== "string")
	)
		throw new Error("Trace: use a text query of at most 2000 characters and a string entryId.");
	const file = await open(sessionFile, "r");
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new Error("Trace: session path is not a regular file.");
		if (offset > stat.size) throw new Error("Trace: offset is past the end of the session.");
		if (offset) {
			const previous = Buffer.alloc(1);
			await file.read(previous, 0, 1, offset - 1);
			if (previous[0] !== 10)
				throw new Error("Trace: offset must start a JSONL line. Use nextOffset from the previous page.");
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
		while (position < stat.size && position - offset < SCAN_BYTES) {
			const chunk = Buffer.alloc(Math.min(64 * 1024, stat.size - position, SCAN_BYTES - (position - offset)));
			const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
			if (!bytesRead) break;
			position += bytesRead;
			pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
			let start = 0;
			for (let end = pending.indexOf(10, start); end !== -1; end = pending.indexOf(10, start)) {
				const line = pending.subarray(start, end).toString("utf8");
				const nextLine = lineStart + end - start + 1;
				let parsed: Record<string, any>;
				try {
					parsed = JSON.parse(line);
				} catch {
					throw new Error(
						`Trace: malformed complete JSONL entry at byte ${lineStart}. Inspect the saved session file.`,
					);
				}
				const record = parsed && typeof parsed === "object" ? project(parsed) : undefined;
				if (record && matches(record, options)) {
					const value = bounded(record);
					const size = Buffer.byteLength(JSON.stringify(value));
					if (records.length && bytes + size > RESPONSE_BYTES)
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
			if (lineStart === offset)
				throw new Error("Trace: one entry exceeds the 8 MB scan limit. Read the saved session file directly.");
			return page(lineStart, "Scan limit reached. Continue with nextOffset.");
		}
		if (pending.length)
			return page(lineStart, "The last JSONL line is incomplete; retry nextOffset after the child writes more output.");
		return page(null);
	} finally {
		await file.close();
	}
}
