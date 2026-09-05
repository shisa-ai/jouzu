import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { MAX_SCAN_BYTES, PythonTextGuard, type ScanEvidence, type TextScanner, unavailable } from "./textguard.js";

const WEB_TOOLS = new Set([
	"web_fetch",
	"batch_web_fetch",
	"tff-fetch_url",
	"tff-search_web",
	"aio-websearch",
	"aio-webfetch",
	"aio-webcontent",
	"aio-webresult",
	"aio-webmap",
	"aio-webpull",
	"aio-webquery",
	"aio-webresearch",
]);

// JSON quoting plus escaped controls avoids terminal control sequences in source labels.
function sourceLabel(source: string): string {
	return JSON.stringify(source.slice(0, 256)).replace(
		/[\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}
function report(source: string, evidence: ScanEvidence): string {
	return `TextGuard ${sourceLabel(source)}: ${JSON.stringify(evidence)}`;
}

async function skillText(path: string): Promise<string | ScanEvidence> {
	try {
		const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			const stat = await file.stat();
			if (!stat.isFile()) return unavailable("file");
			if (stat.size > MAX_SCAN_BYTES) return unavailable("input-limit");
			const buffer = Buffer.alloc(MAX_SCAN_BYTES + 1);
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
				if (!bytesRead) break;
				length += bytesRead;
			}
			if (length > MAX_SCAN_BYTES) return unavailable("input-limit");
			return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
		} finally {
			await file.close();
		}
	} catch {
		return unavailable("file");
	}
}

export function createTextGuardExtension(
	options: { python: string; files?: boolean; yara?: boolean },
	scanner: TextScanner = new PythonTextGuard(options),
): InlineExtension & { dispose: () => Promise<void> } {
	return {
		name: "jouzu-textguard",
		dispose: () => scanner.close(),
		factory(pi) {
			pi.on("before_agent_start", async (event) => {
				const reports: string[] = [];
				const deadline = performance.now() + 5000;
				let clear = 0;
				let skipped = 0;
				const record = (source: string, evidence: ScanEvidence) => {
					if (evidence.status === "clear") clear += 1;
					else if (reports.length < 16) reports.push(report(source, evidence));
					else skipped += 1;
				};
				const scan = async (source: string, text: string) => {
					const remaining = deadline - performance.now();
					record(source, remaining <= 0 ? unavailable("budget") : await scanner.scan(text, remaining));
				};
				// Expansion has already happened here; scan the exact expanded prompt as well as inventory files.
				if (event.prompt.includes("<skill ")) await scan("expanded skill prompt", event.prompt);
				const skills = event.systemPromptOptions.skills ?? [];
				for (const skill of skills.slice(0, 128)) {
					if (performance.now() >= deadline) {
						record(skill.filePath, unavailable("budget"));
						continue;
					}
					const text = await skillText(skill.filePath);
					if (typeof text !== "string") record(skill.filePath, text);
					else await scan(skill.filePath, text);
					await scan(`${skill.filePath} (name/description)`, `${skill.name}\n${skill.description}`);
				}
				skipped += Math.max(0, skills.length - 128);
				return {
					message: {
						customType: "jouzu-textguard",
						content: [
							`TextGuard 1.0.0 scan evidence: ${clear} inputs without findings. Detection does not grant permissions or certify safety.`,
							...reports,
							...(skipped ? [`${skipped} additional inputs or reports omitted; coverage is incomplete.`] : []),
						].join("\n"),
						display: reports.length > 0 || skipped > 0,
					},
				};
			});
			// Queued and resumed skill expansions can reach context without a new before_agent_start event.
			pi.on("context", async (event) => {
				const deadline = performance.now() + 5000;
				const messages = [];
				for (const message of event.messages) {
					if (message.role !== "user") {
						messages.push(message);
						continue;
					}
					const content =
						typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
					const blocks = content.filter((part) => part.type === "text" && part.text.includes("<skill "));
					if (blocks.length === 0) {
						messages.push(message);
						continue;
					}
					const evidence = [];
					for (const block of blocks.slice(0, 16)) {
						if (block.type !== "text") continue;
						const remaining = deadline - performance.now();
						evidence.push(remaining <= 0 ? unavailable("budget") : await scanner.scan(block.text, remaining));
					}
					if (blocks.length > 16) evidence.push(unavailable("budget"));
					messages.push({
						...message,
						content: [
							...content,
							{ type: "text" as const, text: evidence.map((item) => report("expanded skill prompt", item)).join("\n") },
						],
					});
				}
				return { messages };
			});
			pi.on("tool_result", async (event) => {
				const skillRead =
					event.toolName === "read" &&
					typeof event.input.path === "string" &&
					/(?:^|[/\\])SKILL\.md$/iu.test(event.input.path);
				if (!WEB_TOOLS.has(event.toolName) && !skillRead && !(options.files && event.toolName === "read")) return;
				const parts = event.content.filter((part) => part.type === "text");
				if (parts.length === 0) return;
				// Count before joining so an oversized batch does not allocate another full text copy.
				const size = parts.reduce((total, part) => total + Buffer.byteLength(part.text, "utf8"), parts.length - 1);
				const evidence =
					size > MAX_SCAN_BYTES
						? unavailable("input-limit")
						: await scanner.scan(parts.map((part) => part.text).join("\n"));
				return {
					content: [
						...event.content,
						{ type: "text", text: report(`${event.toolName}:${event.toolCallId}`, evidence) },
					],
				};
			});
		},
	};
}
