import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
};

function usageFromBranch(ctx: SessionSnapshotContext, observedAt: number): SessionUiFact<SessionUsageSnapshot> {
	let inputTokens = 0;
	let outputTokens = 0;
	let unknownMessageCount = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		const usage =
			entry.type === "message"
				? (entry.message as { usage?: SessionUsageLike }).usage
				: entry.type === "compaction" || entry.type === "branch_summary"
					? entry.usage
					: undefined;
		if (!usage) {
			if (entry.type === "message" && entry.message.role === "assistant") unknownMessageCount += 1;
			continue;
		}
		inputTokens += Number.isFinite(usage.input) ? (usage.input ?? 0) : 0;
		outputTokens += Number.isFinite(usage.output) ? (usage.output ?? 0) : 0;
	}
	return {
		status: unknownMessageCount > 0 ? "partial" : "known",
		observedAt,
		value: { scope: "active_branch", inputTokens, outputTokens, unknownMessageCount },
	};
}

function contextFrom(ctx: SessionSnapshotContext, observedAt: number): SessionStatusSnapshot["context"] {
	const usage = ctx.getContextUsage();
	const window = usage?.contextWindow ?? ctx.model?.contextWindow;
	if (!usage || !window || window <= 0) return { status: "unknown", observedAt };
	const percent = usage.percent;
	const tokens = usage.tokens;
	const value: { tokens?: number; window: number; percent?: number } = { window };
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
