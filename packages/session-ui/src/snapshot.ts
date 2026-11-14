import { basename } from "node:path";
import { type ExtensionContext, estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionUiClock } from "./contracts.js";
import { SYSTEM_SESSION_UI_CLOCK } from "./contracts.js";
import type { GitStatusSnapshot } from "./sources/git.js";
import type { RuntimeSnapshot } from "./sources/runtime.js";

export type SessionUiFactStatus = "known" | "unknown" | "partial" | "error";

export interface SessionUiFact<T> {
	status: SessionUiFactStatus;
	observedAt: number;
	value?: T;
}

export interface SessionUsageSnapshot {
	scope: "active_branch";
	inputTokens: number;
	outputTokens: number;
	unknownMessageCount: number;
	cacheReadPercent?: number;
	cacheComplete: boolean;
	cost: number | null;
	costEstimated: boolean;
	costComplete: boolean;
}

export interface SessionStatusSnapshot {
	schemaVersion: 1;
	observedAt: number;
	workspace: {
		label: string;
	};
	activity: {
		idle: boolean;
		idleSince?: number;
	};
	model: {
		providerId?: string;
		modelId?: string;
		displayName?: string;
		thinkingLevel?: string;
		scopedModelCount: number;
	};
	context: SessionUiFact<{
		tokens?: number;
		window: number;
		percent?: number;
		approximate?: boolean;
	}>;
	usage: SessionUiFact<SessionUsageSnapshot>;
	git: SessionUiFact<GitStatusSnapshot>;
	runtime: SessionUiFact<RuntimeSnapshot>;
}

export type SessionSnapshotContext = Pick<
	ExtensionContext,
	"cwd" | "getContextUsage" | "isIdle" | "model" | "scopedModels" | "sessionManager" | "thinkingLevel"
>;

type SessionUsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number; totalFromProvider?: boolean };
};

function validCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Running totals for one set of usage records: the whole branch, or one model's replies. */
interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	unknownMessageCount: number;
	cacheComplete: boolean;
	cost: number | null;
	costEstimated: boolean;
	costComplete: boolean;
}

function emptyUsageTotals(): UsageTotals {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		unknownMessageCount: 0,
		cacheComplete: true,
		cost: null,
		costEstimated: false,
		costComplete: true,
	};
}

/** Add one record. `undefined` is a record whose usage was not saved. */
function addUsage(totals: UsageTotals, usage: SessionUsageLike | undefined): void {
	if (!usage) {
		totals.unknownMessageCount += 1;
		totals.cacheComplete = false;
		totals.costComplete = false;
		return;
	}
	const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
	if (!counts.every(validCount)) totals.unknownMessageCount += 1;
	if (![usage.input, usage.cacheRead, usage.cacheWrite].every(validCount)) totals.cacheComplete = false;
	totals.inputTokens += [usage.input, usage.cacheRead, usage.cacheWrite].reduce<number>(
		(total, value) => total + (validCount(value) ? value : 0),
		0,
	);
	totals.outputTokens += validCount(usage.output) ? usage.output : 0;
	totals.cacheReadTokens += validCount(usage.cacheRead) ? usage.cacheRead : 0;
	const amount = usage.cost?.total;
	// A provider-reported zero is authoritative; a catalog placeholder zero is not.
	if (validCount(amount) && (amount > 0 || usage.cost?.totalFromProvider === true)) {
		totals.cost = (totals.cost ?? 0) + amount;
		totals.costEstimated ||= usage.cost?.totalFromProvider !== true;
	} else {
		totals.costComplete = false;
	}
}

function usageSnapshot(totals: UsageTotals): SessionUsageSnapshot {
	return {
		scope: "active_branch",
		inputTokens: totals.inputTokens,
		outputTokens: totals.outputTokens,
		unknownMessageCount: totals.unknownMessageCount,
		...(totals.cacheComplete && totals.inputTokens > 0
			? { cacheReadPercent: (totals.cacheReadTokens / totals.inputTokens) * 100 }
			: {}),
		cacheComplete: totals.cacheComplete,
		cost: totals.cost,
		costEstimated: totals.costEstimated,
		costComplete: totals.costComplete,
	};
}

/** The usage a branch entry carries, or `null` when the entry type records no usage. */
function entryUsage(entry: SessionEntry): SessionUsageLike | undefined | null {
	if (entry.type === "message") {
		const usage = (entry.message as { usage?: SessionUsageLike }).usage;
		if (usage) return usage;
		return entry.message.role === "assistant" ? undefined : null;
	}
	if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") return entry.usage;
	return null;
}

function usageFromBranch(ctx: SessionSnapshotContext, observedAt: number): SessionUiFact<SessionUsageSnapshot> {
	const totals = emptyUsageTotals();
	for (const entry of ctx.sessionManager.getBranch()) {
		const usage = entryUsage(entry);
		if (usage !== null) addUsage(totals, usage);
	}
	return {
		status: totals.unknownMessageCount > 0 ? "partial" : "known",
		observedAt,
		value: usageSnapshot(totals),
	};
}

export interface SessionModelUsage {
	providerId: string;
	modelId: string;
	responses: number;
	usage: SessionUsageSnapshot;
}

export interface SessionActivitySummary {
	/** Messages the user sent on the active branch. */
	prompts: number;
	/** Assistant replies on the active branch. */
	responses: number;
	toolCalls: number;
	compactions: number;
	/** Session start time from the session header, in epoch milliseconds. */
	startedAt?: number;
	/** Time of the last entry on the active branch, in epoch milliseconds. */
	lastActivityAt?: number;
	/** Usage of assistant replies, grouped by the model that produced them, in first-use order. */
	models: SessionModelUsage[];
}

const parseTime = (value: string | undefined): number | undefined => {
	const time = value === undefined ? Number.NaN : Date.parse(value);
	return Number.isFinite(time) ? time : undefined;
};

/** Count the active branch's turns, replies, and tool calls, and split reply usage by model. */
export function summarizeSessionActivity(
	sessionManager: Pick<SessionSnapshotContext["sessionManager"], "getBranch" | "getHeader">,
): SessionActivitySummary {
	const summary: SessionActivitySummary = { prompts: 0, responses: 0, toolCalls: 0, compactions: 0, models: [] };
	const models = new Map<string, { providerId: string; modelId: string; responses: number; totals: UsageTotals }>();
	for (const entry of sessionManager.getBranch()) {
		summary.lastActivityAt = parseTime(entry.timestamp) ?? summary.lastActivityAt;
		if (entry.type === "compaction") summary.compactions += 1;
		if (entry.type !== "message") continue;
		const message = entry.message as {
			role: string;
			provider?: string;
			model?: string;
			content?: unknown;
			usage?: SessionUsageLike;
		};
		if (message.role === "user") summary.prompts += 1;
		if (message.role !== "assistant") continue;
		summary.responses += 1;
		if (Array.isArray(message.content))
			summary.toolCalls += message.content.filter(
				(part) => (part as { type?: unknown } | null)?.type === "toolCall",
			).length;
		const providerId = message.provider ?? "";
		const modelId = message.model ?? "";
		const key = `${providerId}\0${modelId}`;
		let model = models.get(key);
		if (!model) {
			model = { providerId, modelId, responses: 0, totals: emptyUsageTotals() };
			models.set(key, model);
		}
		model.responses += 1;
		addUsage(model.totals, message.usage);
	}
	const startedAt = parseTime(sessionManager.getHeader()?.timestamp);
	if (startedAt !== undefined) summary.startedAt = startedAt;
	summary.models = [...models.values()].map((model) => ({
		providerId: model.providerId,
		modelId: model.modelId,
		responses: model.responses,
		usage: usageSnapshot(model.totals),
	}));
	return summary;
}

function contextFrom(ctx: SessionSnapshotContext, observedAt: number): SessionStatusSnapshot["context"] {
	const usage = ctx.getContextUsage();
	const window = usage?.contextWindow ?? ctx.model?.contextWindow;
	if (!usage || !window || window <= 0) return { status: "unknown", observedAt };
	const percent = usage.percent;
	const tokens = usage.tokens;
	const value: NonNullable<SessionStatusSnapshot["context"]["value"]> = { window };
	if (tokens === null && ctx.sessionManager.getBranch().some((entry) => entry.type === "compaction")) {
		// Retained assistant usage still describes the pre-compaction request.
		// Estimate the projected content, including the saved system/tool context, instead.
		const messages = ctx.sessionManager.buildSessionProjection().messages;
		const estimatedTokens = messages.reduce((total, message) => total + estimateTokens(message), 0);
		return {
			status: "partial",
			observedAt,
			value: { window, tokens: estimatedTokens, percent: (estimatedTokens / window) * 100, approximate: true },
		};
	}
	if (tokens !== null) value.tokens = tokens;
	if (percent !== null) value.percent = percent;
	return {
		status: tokens === null || percent === null ? "partial" : "known",
		observedAt,
		value,
	};
}

export function createSessionStatusSnapshot(
	ctx: SessionSnapshotContext,
	options: {
		clock?: SessionUiClock;
		idleSince?: number;
		git?: SessionUiFact<GitStatusSnapshot>;
		runtime?: SessionUiFact<RuntimeSnapshot>;
	} = {},
): SessionStatusSnapshot {
	const clock = options.clock ?? SYSTEM_SESSION_UI_CLOCK;
	const observedAt = clock.now();
	const idle = ctx.isIdle();
	return {
		schemaVersion: 1,
		observedAt,
		workspace: { label: basename(ctx.cwd) || "workspace" },
		activity: {
			idle,
			...(idle && options.idleSince !== undefined ? { idleSince: options.idleSince } : {}),
		},
		model: {
			...(ctx.model ? { providerId: ctx.model.provider, modelId: ctx.model.id, displayName: ctx.model.name } : {}),
			...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
			scopedModelCount: ctx.scopedModels.length,
		},
		context: contextFrom(ctx, observedAt),
		usage: usageFromBranch(ctx, observedAt),
		git: options.git ?? { status: "unknown", observedAt },
		runtime: options.runtime ?? { status: "unknown", observedAt },
	};
}
