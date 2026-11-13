import { basename } from "node:path";
import { type ExtensionContext, estimateTokens } from "@earendil-works/pi-coding-agent";
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

function usageFromBranch(ctx: SessionSnapshotContext, observedAt: number): SessionUiFact<SessionUsageSnapshot> {
	let inputTokens = 0;
	let outputTokens = 0;
	let unknownMessageCount = 0;
	let cacheReadTokens = 0;
	let cacheComplete = true;
	let cost: number | null = null;
	let costEstimated = false;
	let costComplete = true;
	for (const entry of ctx.sessionManager.getBranch()) {
		const usage =
			entry.type === "message"
				? (entry.message as { usage?: SessionUsageLike }).usage
				: entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage"
					? entry.usage
					: undefined;
		if (!usage) {
			if (
				(entry.type === "message" && entry.message.role === "assistant") ||
				entry.type === "compaction" ||
				entry.type === "branch_summary" ||
				entry.type === "usage"
			) {
				unknownMessageCount += 1;
				cacheComplete = false;
				costComplete = false;
			}
			continue;
		}
		const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
		if (!counts.every(validCount)) unknownMessageCount += 1;
		if (![usage.input, usage.cacheRead, usage.cacheWrite].every(validCount)) cacheComplete = false;
		inputTokens += [usage.input, usage.cacheRead, usage.cacheWrite].reduce<number>(
			(total, value) => total + (validCount(value) ? value : 0),
			0,
		);
		outputTokens += validCount(usage.output) ? usage.output : 0;
		cacheReadTokens += validCount(usage.cacheRead) ? usage.cacheRead : 0;
		const amount = usage.cost?.total;
		// A provider-reported zero is authoritative; a catalog placeholder zero is not.
		if (validCount(amount) && (amount > 0 || usage.cost?.totalFromProvider === true)) {
			cost = (cost ?? 0) + amount;
			costEstimated ||= usage.cost?.totalFromProvider !== true;
		} else {
			costComplete = false;
		}
	}
	return {
		status: unknownMessageCount > 0 ? "partial" : "known",
		observedAt,
		value: {
			scope: "active_branch",
			inputTokens,
			outputTokens,
			unknownMessageCount,
			...(cacheComplete && inputTokens > 0 ? { cacheReadPercent: (cacheReadTokens / inputTokens) * 100 } : {}),
			cacheComplete,
			cost,
			costEstimated,
			costComplete,
		},
	};
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
