import { basename } from "node:path";
import type { ExtensionCommandContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { catalogText } from "./cli-messages.js";
import type { BackgroundJobSnapshot } from "./flow-control/background-adapter.js";
import { flowPauseText } from "./flow-control/flow-pause.js";
import type { FlowStatus } from "./flow-control/flow-status.js";
import type { FlowTask } from "./flow-control/task-producer.js";
import type { CatalogBundle } from "./locale-catalog.js";
import { catalogRuntimeIdentity } from "./model-catalog-projection.js";
import {
	createSessionStatusSnapshot,
	type GitStatusSnapshot,
	type SessionStatusSnapshot,
	type SessionUsageSnapshot,
	summarizeSessionActivity,
	type WorkScope,
	type WorkUnit,
} from "./session-ui/index.js";
import type { AgentRun } from "./subagents/manager.js";
import { padTerminalText, sanitizeTerminalText, terminalTextWidth } from "./terminal-layout.js";
import type { TextGuardMode } from "./textguard-policy.js";
import { childWorkSnapshot, jobWorkUnits, taskWorkUnits } from "./work-dashboard-sources.js";

const ID = "jouzu.cli.presentation.status";
/** Joins facts on one row; punctuation, not catalog text. */
const SEPARATOR = " · ";

/** Live producers `/status` reads. Each is optional: a missing producer leaves its row out. */
export interface SessionStatusSources {
	/** The status bar's last snapshot, which carries cached git state. */
	snapshot?(): SessionStatusSnapshot | undefined;
	/** Subagent runs this process manages; undefined until the workflow manager attaches. */
	agentRuns?(): { sessionId?: string; runs: AgentRun[] } | undefined;
	flow?: {
		enabled(): boolean;
		status(): Promise<FlowStatus | undefined>;
		jobs(): BackgroundJobSnapshot[] | undefined;
		tasks(): FlowTask[] | undefined;
	};
	textguard?(sessionId: string): { mode: TextGuardMode; pending: number };
}

export interface SessionStatusRuntime {
	jouzuVersion: string;
	piVersion: string;
	profileId: string;
	profileApplied: boolean;
}

type Role = "heading" | "fieldName" | "value" | "secondary" | "warning" | "error" | "success";
type Span = { text: string; role: Role };
type Row = { label?: string; lines: Span[][] };
type Section = Row[];

const ROLE_COLORS: Record<Role, ThemeColor> = {
	heading: "accent",
	fieldName: "muted",
	value: "text",
	secondary: "dim",
	warning: "warning",
	error: "error",
	success: "success",
};

/** One item that needs the user, with the command that handles it. */
export interface StatusAttention {
	text: string;
	route: string;
	/** Needs a decision before automated work continues; otherwise it is information. */
	action: boolean;
}

export interface SessionWorkSummary {
	agentsActive: number;
	jobsRunning: number;
	tasksOpen: number;
	tasksTotal: number;
	flow?: {
		enabled: boolean;
		paused?: string;
		/** Registered automated work that can still take turns, such as loops and goals. */
		automated: number;
		waits: number;
		suspended: number;
	};
	textguard?: { mode: TextGuardMode; pending: number };
	attention: StatusAttention[];
	/** At least one producer could be read. */
	known: boolean;
}

export function compactCount(value: number): string {
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
	if (value >= 10_000) return `${Math.round(value / 1000)}k`;
	if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
	return String(value);
}

/** The status bar's cost notation: `~` for estimates, `+ ?` when more usage has unknown cost. */
export function formatStatusCost(usage: Pick<SessionUsageSnapshot, "cost" | "costEstimated" | "costComplete">) {
	if (usage.cost == null) return undefined;
	return `${usage.costEstimated ? "~" : ""}$${usage.cost.toFixed(3)}${usage.costComplete ? "" : " + ?"}`;
}

function formatAge(catalog: CatalogBundle, milliseconds: number): string {
	const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
	if (minutes < 1) return catalogText(catalog, `${ID}.ageUnderMinute`);
	if (minutes < 60) return catalogText(catalog, `${ID}.ageMinutes`, { minutes });
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return catalogText(catalog, `${ID}.ageHours`, { hours, minutes: minutes % 60 });
	return catalogText(catalog, `${ID}.ageDays`, { days: Math.floor(hours / 24), hours: hours % 24 });
}

export function formatClock(time: number): string {
	const date = new Date(time);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The provider name a person recognizes; a catalog provider's runtime key carries it encoded. */
export function providerLabel(providerId: string): string {
	return catalogRuntimeIdentity(providerId)?.provider ?? providerId;
}

function countsByState(units: WorkUnit[]) {
	return {
		active: units.filter((unit) => unit.state === "queued" || unit.state === "running").length,
		results: units.filter((unit) => unit.attention.some((item) => item.type === "result")).length,
	};
}

/** Read every work producer once and reduce it to counts and attention items. */
export async function collectSessionWork(
	scope: WorkScope,
	sources: SessionStatusSources,
	catalog: CatalogBundle,
): Promise<SessionWorkSummary> {
	const text = (key: string, args?: Record<string, string | number>) => catalogText(catalog, `${ID}.${key}`, args);
	const summary: SessionWorkSummary = {
		agentsActive: 0,
		jobsRunning: 0,
		tasksOpen: 0,
		tasksTotal: 0,
		attention: [],
		known: false,
	};
	const informational: StatusAttention[] = [];
	const agents = sources.agentRuns?.();
	if (agents && agents.sessionId === scope.sessionId) {
		summary.known = true;
		const counts = countsByState(childWorkSnapshot(scope, agents.runs).units);
		summary.agentsActive = counts.active;
		if (counts.results)
			informational.push({
				text: text("attentionAgentResults", { count: counts.results }),
				route: "/workflow",
				action: false,
			});
	}
	const flow = sources.flow;
	if (flow) {
		summary.known = true;
		const jobs = flow.jobs();
		if (jobs) {
			const counts = countsByState(jobWorkUnits(scope, jobs, catalog));
			summary.jobsRunning = counts.active;
			if (counts.results)
				informational.push({
					text: text("attentionJobResults", { count: counts.results }),
					route: "/bg",
					action: false,
				});
		}
		const tasks = flow.tasks();
		if (tasks) {
			const units = taskWorkUnits(scope, tasks);
			summary.tasksTotal = units.length;
			summary.tasksOpen = units.filter((unit) => unit.state !== "completed" && unit.state !== "cancelled").length;
		}
		const enabled = flow.enabled();
		const status = enabled ? await flow.status().catch(() => undefined) : undefined;
		summary.flow = {
			enabled,
			...(status?.paused ? { paused: flowPauseText(status.paused, catalog, 200) } : {}),
			automated: status?.active.length ?? 0,
			waits: status?.waiting.length ?? 0,
			suspended: status?.suspended.length ?? 0,
		};
		if (status) {
			const flowItems: Array<[string, number]> = [
				["attentionHeld", status.held.length],
				["attentionRetryable", status.retryable.length],
				["attentionUncertain", status.uncertain.length],
				["attentionUnaccountable", status.unaccountable.length],
			];
			for (const [key, count] of flowItems)
				if (count) summary.attention.push({ text: text(key, { count }), route: "/flow", action: true });
		}
	}
	const guard = sources.textguard?.(scope.sessionId);
	if (guard) {
		summary.known = true;
		summary.textguard = guard;
		if (guard.pending)
			summary.attention.push({
				text: text("attentionTextguard", { count: guard.pending }),
				route: "/textguard",
				action: true,
			});
	}
	summary.attention.push(...informational);
	return summary;
}

interface ModelRow {
	name?: string;
	id: string;
	providerId: string;
	responses: number;
	usage: Pick<SessionUsageSnapshot, "inputTokens" | "outputTokens" | "cost" | "costEstimated" | "costComplete">;
	subagent: boolean;
}

function subagentModelRows(runs: AgentRun[], sessionId: string): ModelRow[] {
	const rows = new Map<string, ModelRow>();
	for (const run of runs) {
		if (run.parentSessionId !== sessionId) continue;
		const key = `${run.model.provider}\0${run.model.id}`;
		let row = rows.get(key);
		if (!row) {
			row = {
				...(run.model.name ? { name: run.model.name } : {}),
				id: run.model.id,
				providerId: run.model.provider,
				responses: 0,
				usage: { inputTokens: 0, outputTokens: 0, cost: null, costEstimated: false, costComplete: true },
				subagent: true,
			};
			rows.set(key, row);
		}
		row.responses += 1;
		const usage = run.usage;
		row.usage.inputTokens += usage.input + usage.cacheRead + usage.cacheWrite;
		row.usage.outputTokens += usage.output;
		if (usage.cost !== null) row.usage.cost = (row.usage.cost ?? 0) + usage.cost;
		if (usage.cost === null || usage.costComplete === false) row.usage.costComplete = false;
		if (usage.costSource !== "provider") row.usage.costEstimated ||= usage.cost !== null;
	}
	return [...rows.values()];
}

/** Display name and ID together; the ID alone when the name adds nothing. */
function modelSpans(name: string | undefined, id: string): Span[] {
	const safeId = sanitizeTerminalText(id);
	const safeName = name ? sanitizeTerminalText(name) : "";
	if (!safeName || safeName === safeId) return [{ text: safeId, role: "value" }];
	return [
		{ text: safeName, role: "value" },
		{ text: "  ", role: "value" },
		{ text: safeId, role: "secondary" },
	];
}

function joinSpans(parts: Span[][], separator = SEPARATOR): Span[] {
	const spans: Span[] = [];
	for (const [index, part] of parts.entries()) {
		if (index > 0) spans.push({ text: separator, role: "secondary" });
		spans.push(...part);
	}
	return spans;
}

const value = (text: string): Span[] => [{ text, role: "value" }];

export interface SessionStatusInput {
	ctx: Pick<
		ExtensionCommandContext,
		| "cwd"
		| "getContextUsage"
		| "isIdle"
		| "model"
		| "modelRegistry"
		| "scopedModels"
		| "sessionManager"
		| "thinkingLevel"
	>;
	runtime: SessionStatusRuntime;
	catalog: CatalogBundle;
	snapshot?: SessionStatusSnapshot;
	work?: SessionWorkSummary;
	agentRuns?: AgentRun[];
	now?: number;
}

/** Lay out the report as labeled rows. Pure, so tests can compare it without a terminal. */
export function buildSessionStatusSections(input: SessionStatusInput): { heading: string; sections: Section[] } {
	const { ctx, catalog, runtime } = input;
	const now = input.now ?? Date.now();
	const text = (key: string, args?: Record<string, string | number>) => catalogText(catalog, `${ID}.${key}`, args);
	const label = (key: string) => text(`label.${key}`);
	const sessionManager = ctx.sessionManager;
	const sessionId = sessionManager.getSessionId();
	const live = createSessionStatusSnapshot(ctx, {
		...(input.snapshot?.git ? { git: input.snapshot.git } : {}),
		...(input.snapshot?.runtime ? { runtime: input.snapshot.runtime } : {}),
	});
	const activity = summarizeSessionActivity(sessionManager);

	// Identity: the session ID comes first because support requests start from it.
	const identity: Section = [];
	const sessionLines: Span[][] = [value(sanitizeTerminalText(sessionId))];
	const name = sessionManager.getSessionName?.();
	const started = activity.startedAt;
	const details: Span[][] = [];
	if (name) details.push(value(text("sessionName", { name: sanitizeTerminalText(name) })));
	if (started !== undefined)
		details.push(value(text("started", { time: formatClock(started), age: formatAge(catalog, now - started) })));
	if (details.length) sessionLines.push(joinSpans(details));
	identity.push({ label: label("session"), lines: sessionLines });

	const workspace: Span[][] = [value(sanitizeTerminalText(basename(ctx.cwd) || "workspace"))];
	const git = live.git.value;
	if (git) workspace.push(gitSpans(git, text, catalogText(catalog, "jouzu.cli.session.status.detached")));
	identity.push({ label: label("workspace"), lines: [joinSpans(workspace)] });

	if (ctx.model) {
		const thinking = text("thinking", { level: ctx.thinkingLevel ?? "off" });
		identity.push({
			label: label("model"),
			lines: [
				modelSpans(ctx.model.name, ctx.model.id),
				joinSpans([value(sanitizeTerminalText(providerLabel(ctx.model.provider))), value(thinking)]),
			],
		});
	} else identity.push({ label: label("model"), lines: [[{ text: text("modelNotSelected"), role: "warning" }]] });
	identity.push({
		label: label("profile"),
		lines: [
			value(
				text("profileValue", {
					id: sanitizeTerminalText(runtime.profileId),
					state: text(runtime.profileApplied ? "profileApplied" : "profileNotApplied"),
				}),
			),
		],
	});

	// Usage: what this session has done and what it has cost.
	const usageSection: Section = [];
	const counts: Array<[string, number]> = [
		["prompts", activity.prompts],
		["responses", activity.responses],
		["toolCalls", activity.toolCalls],
		["compactions", activity.compactions],
	];
	usageSection.push({
		label: label("activity"),
		lines: [
			joinSpans(
				counts
					.filter(([key, count]) => count > 0 || key === "prompts")
					.map(([key, count]) => value(text(key, { count }))),
			),
		],
	});
	usageSection.push({ label: label("context"), lines: [contextSpans(live, text)] });
	const usage = live.usage.value;
	if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cost != null))
		usageSection.push({ label: label("usage"), lines: [usageSpans(usage, text)] });

	const rows: ModelRow[] = activity.models.map((model) => ({
		name: ctx.modelRegistry?.find(model.providerId, model.modelId)?.name,
		id: model.modelId,
		providerId: model.providerId,
		responses: model.responses,
		usage: model.usage,
		subagent: false,
	}));
	rows.push(...subagentModelRows(input.agentRuns ?? [], sessionId));
	if (rows.length > 1 || rows.some((row) => row.subagent))
		usageSection.push({
			label: label("models"),
			lines: rows.map((row) => {
				const cost = formatStatusCost(row.usage);
				return joinSpans([
					modelSpans(row.name, row.id),
					value(text(row.subagent ? "subagentRuns" : "responses", { count: row.responses })),
					value(`↑${compactCount(row.usage.inputTokens)} ↓${compactCount(row.usage.outputTokens)}`),
					...(cost ? [value(cost)] : []),
				]);
			}),
		});

	const sections: Section[] = [identity, usageSection];
	if (input.work?.known) sections.push(...workSections(input.work, text, label, catalog));

	sections.push([
		{
			label: label("provider"),
			lines: [[{ text: sanitizeTerminalText(ctx.model?.provider ?? "—"), role: "secondary" }]],
		},
		{
			label: label("scopedModels"),
			lines: [
				[
					{
						text: ctx.scopedModels.length === 0 ? text("scopedModelsAll") : String(ctx.scopedModels.length),
						role: "secondary",
					},
				],
			],
		},
		{
			label: label("runtime"),
			lines: [
				[{ text: text("runtimeValue", { jouzu: runtime.jouzuVersion, pi: runtime.piVersion }), role: "secondary" }],
			],
		},
	]);
	return { heading: text("heading"), sections };
}

type Text = (key: string, args?: Record<string, string | number>) => string;

function gitSpans(git: GitStatusSnapshot, text: Text, detached: string): Span[] {
	const branch = sanitizeTerminalText(git.branch ?? detached);
	const relation = [git.ahead > 0 ? `↑${git.ahead}` : "", git.behind > 0 ? `↓${git.behind}` : ""]
		.filter(Boolean)
		.join(" ");
	return [
		{ text: branch, role: "value" },
		{ text: SEPARATOR, role: "secondary" },
		git.dirty ? { text: text("gitChanged"), role: "warning" } : { text: text("gitClean"), role: "success" },
		...(relation ? [{ text: ` ${relation}`, role: "secondary" } as const] : []),
	];
}

function contextSpans(snapshot: SessionStatusSnapshot, text: Text): Span[] {
	const context = snapshot.context.value;
	if (!context) return [{ text: text("unknown"), role: "secondary" }];
	const percent = context.percent;
	const role: Role = percent === undefined ? "value" : percent >= 90 ? "error" : percent >= 70 ? "warning" : "value";
	const prefix = context.approximate ? "~" : "";
	return [
		{
			text: text("contextUsage", {
				tokens: context.tokens === undefined ? text("unknown") : `${prefix}${compactCount(context.tokens)}`,
				window: compactCount(context.window),
				percent: percent === undefined ? "?" : `${prefix}${Math.round(percent)}`,
			}),
			role,
		},
	];
}

function usageSpans(usage: SessionUsageSnapshot, text: Text): Span[] {
	const parts: Span[][] = [];
	const tokens = compactCount(usage.inputTokens);
	const input =
		usage.cacheComplete && usage.cacheReadPercent !== undefined
			? text("tokensInCached", { tokens, percent: Math.round(usage.cacheReadPercent) })
			: text("tokensIn", { tokens });
	parts.push(value(input));
	parts.push(value(text("tokensOut", { tokens: compactCount(usage.outputTokens) })));
	const cost = formatStatusCost(usage);
	if (cost) parts.push([{ text: cost, role: usage.costComplete ? "value" : "warning" }]);
	const spans = joinSpans(parts);
	if (usage.unknownMessageCount > 0)
		spans.push({ text: ` ${text("usageIncomplete", { count: usage.unknownMessageCount })}`, role: "warning" });
	return spans;
}

function workSections(
	work: SessionWorkSummary,
	text: Text,
	label: (key: string) => string,
	catalog: CatalogBundle,
): Section[] {
	const section: Section = [];
	const items: Span[][] = [];
	if (work.agentsActive) items.push(value(text("agentsActive", { count: work.agentsActive })));
	if (work.jobsRunning) items.push(value(text("jobsRunning", { count: work.jobsRunning })));
	if (work.tasksOpen) items.push(value(text("tasksOpen", { open: work.tasksOpen, total: work.tasksTotal })));
	if (work.flow?.automated) items.push(value(text("automatedWork", { count: work.flow.automated })));
	if (work.flow?.waits) items.push(value(text("waits", { count: work.flow.waits })));
	if (work.flow?.suspended) items.push(value(text("suspended", { count: work.flow.suspended })));
	section.push({
		label: label("work"),
		lines: [items.length ? joinSpans(items) : [{ text: text("workIdle"), role: "secondary" }]],
	});
	if (work.flow) {
		const state: Span[] = work.flow.paused
			? [
					{
						text: catalogText(catalog, "jouzu.cli.flow.status.pausedLine", { reason: work.flow.paused }),
						role: "warning",
					},
				]
			: work.flow.enabled
				? value(text("flowOn"))
				: [{ text: text("flowOff"), role: "secondary" }];
		section.push({ label: label("flow"), lines: [state] });
	}
	if (work.textguard)
		section.push({
			label: label("textguard"),
			lines: [[{ text: work.textguard.mode, role: work.textguard.mode === "off" ? "warning" : "value" }]],
		});
	if (!work.attention.length) return [section];
	return [
		section,
		[
			{
				label: label("attention"),
				lines: work.attention.map((item) => [
					{ text: item.action ? "! " : "· ", role: item.action ? "warning" : "secondary" },
					{ text: item.text, role: item.action ? "warning" : "value" },
					{ text: "  ", role: "value" },
					{ text: item.route, role: "secondary" },
				]),
			},
		],
	];
}

/** Render the sections with aligned labels; `theme` absent means plain text. */
export function renderSessionStatus(
	report: { heading: string; sections: Section[] },
	theme?: Pick<Theme, "fg">,
): string {
	const paint = (span: Span) => (theme ? theme.fg(ROLE_COLORS[span.role], span.text) : span.text);
	const labels = report.sections.flat().map((row) => row.label ?? "");
	const width = Math.max(0, ...labels.map((item) => terminalTextWidth(item))) + 2;
	const lines = [paint({ text: report.heading, role: "heading" })];
	for (const section of report.sections) {
		lines.push("");
		for (const row of section)
			for (const [index, spans] of row.lines.entries()) {
				const prefix = index === 0 && row.label ? padTerminalText(row.label, width) : " ".repeat(width);
				lines.push(`${paint({ text: prefix, role: "fieldName" })}${spans.map(paint).join("")}`);
			}
	}
	return lines.join("\n");
}
