import { createHash } from "node:crypto";
import { type MainOptions, type Skill, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { UnavailableReason } from "./textguard.js";
import { type ContentReview, TextGuardAdmission } from "./textguard-admission.js";
import { snapshotPayload } from "./textguard-payload.js";
import { TextGuardSkills } from "./textguard-skills.js";

type Policy = Awaited<ReturnType<NonNullable<MainOptions["contentPolicyFactory"]>>>;
type ToolEvent = Parameters<Policy["filterToolResult"]>[0];
type ToolResult = ToolEvent["result"];
type Messages = Parameters<Policy["filterContext"]>[0];
type Scanner = ConstructorParameters<typeof TextGuardAdmission>[0];
export const TEXTGUARD_WEB_TOOLS = new Set([
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
const LIMIT = 128;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
interface RequestSource {
	name: string;
	inspect: boolean;
	source?: string;
	path?: string;
}
export interface PolicyNotice {
	reason: UnavailableReason;
}

export class NativeContentPolicy implements Policy {
	readonly admission: TextGuardAdmission;
	readonly skills: TextGuardSkills;
	private requests = new Map<string, RequestSource>();
	private expansions = new Map<string, number>();
	private reports = new Map<string, ContentReview>();
	private notices: PolicyNotice[] = [];
	private generation = 0;
	constructor(options: { cwd: string; scanner: Scanner; files?: boolean }) {
		this.admission = new TextGuardAdmission(options.scanner);
		this.skills = new TextGuardSkills(this.admission, options.cwd);
		this.files = options.files === true;
	}
	private files: boolean;
	reviews(): ContentReview[] {
		return this.admission.reviews();
	}
	scanReports(): ContentReview[] {
		return structuredClone([...this.skills.scanReports(), ...this.reports.values()].slice(-LIMIT));
	}
	scanNotices(): PolicyNotice[] {
		return [...this.skills.scanNotices().map(({ reason }) => ({ reason })), ...structuredClone(this.notices)].slice(
			-LIMIT,
		);
	}
	clear(): void {
		this.generation++;
		this.skills.clear();
		this.requests.clear();
		this.expansions.clear();
		this.reports.clear();
		this.notices = [];
	}
	filterSkills(skills: Skill[]): Promise<Skill[]> {
		return this.skills.filterSkills(skills);
	}
	async readSkill(skill: Skill): Promise<string | undefined> {
		const generation = this.generation;
		const snapshot = snapshotPayload(skill);
		if (snapshot.status !== "identified") return;
		const checked = await this.skills.readSkill(snapshot.value);
		if (checked === undefined || generation !== this.generation) return;
		const block = `<skill name="${snapshot.value.name}" location="${snapshot.value.filePath}">\nReferences are relative to ${snapshot.value.baseDir}.\n\n${stripFrontmatter(checked).trim()}\n</skill>`;
		this.expansions.set(digest(block), block.length);
		while (this.expansions.size > LIMIT) this.expansions.delete(this.expansions.keys().next().value as string);
		return checked;
	}
	shouldInspectTool(name: string, input: unknown): boolean {
		if (TEXTGUARD_WEB_TOOLS.has(name)) return true;
		if (name !== "read") return false;
		const path = input && typeof input === "object" && "path" in input ? input.path : undefined;
		return this.files || typeof path !== "string" || this.skills.isSkillPath(path);
	}
	private request(name: string, id: string, input: unknown): RequestSource {
		const inspect = this.shouldInspectTool(name, input);
		const snapshot = snapshotPayload(input);
		const path =
			input &&
			typeof input === "object" &&
			"path" in input &&
			typeof input.path === "string" &&
			input.path.length <= 16384
				? input.path
				: undefined;
		const identified = snapshot.status === "identified" ? snapshot.value : undefined;
		const label =
			identified && typeof identified === "object"
				? ["url", "path", "query"]
						.map((key) => (identified as Record<string, unknown>)[key])
						.find((value) => typeof value === "string")
				: undefined;
		const entry = {
			name,
			inspect,
			path,
			source:
				snapshot.status === "identified"
					? `${name}:${typeof label === "string" ? label.slice(0, 128) : "request"}:${snapshot.digest}`
					: undefined,
		};
		this.requests.delete(id);
		this.requests.set(id, entry);
		while (this.requests.size > 1024) this.requests.delete(this.requests.keys().next().value as string);
		return entry;
	}
	private withheld(): ToolResult {
		return {
			content: [{ type: "text", text: "TextGuard withheld this content pending user review." }],
			details: {},
			isError: true,
		};
	}
	private async checkPayload<T>(
		source: string,
		value: T,
		signal?: AbortSignal,
		unsupported = false,
	): Promise<T | undefined> {
		const generation = this.generation;
		const snapshot = snapshotPayload(value);
		if (snapshot.status === "unavailable") {
			this.notices.push({ reason: snapshot.reason });
			this.notices = this.notices.slice(-LIMIT);
			return;
		}
		const decision =
			snapshot.text === undefined || unsupported
				? await this.admission.checkUnavailableSnapshot(
						source,
						snapshot.digest,
						unsupported ? "unsupported-content" : "input-limit",
						signal,
					)
				: await this.admission.check(source, snapshot.text, signal);
		if (generation !== this.generation) return;
		if (decision.review.evidence.status !== "clear") {
			this.reports.delete(decision.review.id);
			this.reports.set(decision.review.id, decision.review);
			while (this.reports.size > LIMIT) this.reports.delete(this.reports.keys().next().value as string);
		}
		return decision.allowed ? snapshot.value : undefined;
	}
	private async checkResult(source: RequestSource, result: ToolResult, signal?: AbortSignal): Promise<ToolResult> {
		if (!source.source) {
			this.notices.push({ reason: "protocol" });
			this.notices = this.notices.slice(-LIMIT);
			return this.withheld();
		}
		const value = {
			content: result.content,
			details: result.details ?? {},
			isError: result.isError ?? false,
			...(result.usage === undefined ? {} : { usage: result.usage }),
		};
		const checked = await this.checkPayload(
			source.source,
			value,
			signal,
			result.content.some((part) => part.type !== "text"),
		);
		return checked ?? this.withheld();
	}
	async filterToolResult(event: ToolEvent): Promise<ToolResult> {
		const source = this.request(event.toolName, event.toolCallId, event.input);
		if (!source.inspect) return event.result;
		return this.checkResult(source, event.result, event.signal);
	}
	private knownExpansion(text: string): boolean {
		for (const [identity, length] of this.expansions) {
			if (
				text.length >= length &&
				!text.slice(length).includes("<skill ") &&
				digest(text.slice(0, length)) === identity
			)
				return true;
		}
		return false;
	}
	async filterContext(messages: Messages, signal?: AbortSignal): Promise<Messages> {
		const generation = this.generation;
		const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
		const admitted: Messages = [];
		for (const message of messages) {
			if (message.role === "assistant") {
				for (const part of message.content)
					if (part.type === "toolCall") this.request(part.name, part.id, part.arguments);
				admitted.push(message);
				continue;
			}
			if (message.role === "toolResult") {
				const source = this.requests.get(message.toolCallId);
				const inspect =
					TEXTGUARD_WEB_TOOLS.has(message.toolName) ||
					(message.toolName === "read" &&
						(!source || source.inspect || (source.path && this.skills.isSkillPath(source.path))));
				if (inspect) {
					const result = await this.checkResult(
						source?.name === message.toolName ? source : { name: message.toolName, inspect: true },
						{ ...message, details: message.details ?? {} },
						boundedSignal,
					);
					admitted.push({
						role: "toolResult",
						toolName: message.toolName,
						toolCallId: message.toolCallId,
						timestamp: message.timestamp,
						content: result.content,
						details: result.details,
						isError: result.isError ?? false,
						...(result.usage === undefined ? {} : { usage: result.usage }),
					});
				} else admitted.push(message);
				continue;
			}
			if (message.role === "user") {
				const content =
					typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
				let denied = false;
				for (const part of content) {
					if (part.type === "text" && part.text.includes("<skill ") && !this.knownExpansion(part.text)) {
						if ((await this.checkPayload("skill:expanded-message", part.text, boundedSignal)) === undefined) {
							denied = true;
							break;
						}
					}
				}
				admitted.push(
					denied ? { role: "user", content: this.withheld().content, timestamp: message.timestamp } : message,
				);
			} else admitted.push(message);
		}
		if (generation !== this.generation || boundedSignal.aborted) throw new Error("TextGuard context check interrupted");
		return admitted;
	}
}
