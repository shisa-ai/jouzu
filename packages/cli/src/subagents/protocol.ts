import type { CacheWarmingMode } from "@earendil-works/pi-coding-agent";
import type { LanguageContract } from "../language-contract.js";
import type { SideContext } from "../side-context.js";
import type { TextGuardMode } from "../textguard-policy.js";
import type { ChildContext } from "./context.js";
import type { AgentModel, AgentRole, AgentThinkingLevel } from "./roles.js";
import type { WorkerUsage } from "./usage.js";

/** Credentials travel only over the private parent/child pipe, never into run records. */
export interface WorkerLaunch {
	/** User-owned Q&A has no tools, extension discovery, or parent result delivery. */
	purpose?: "side-conversation";
	sideContext?: SideContext;
	role: AgentRole;
	model: AgentModel;
	/** Concrete effort resolved from the parent when this run was requested. */
	thinkingLevel?: AgentThinkingLevel;
	auth: { apiKey?: string; headers?: Record<string, string>; baseUrl?: string; env?: Record<string, string> };
	cwd: string;
	directory: string;
	userAgentDir?: string;
	runtimeStateDir?: string;
	profile?: "core" | "ja";
	sessionFile?: string;
	context?: ChildContext;
	parentContextFile?: string;
	textguardFiles?: boolean;
	/** Snapshot of the global warming setting when this run was launched. */
	cacheWarming?: CacheWarmingMode;
	/**
	 * The role's language contract, snapshotted when this run was launched. The
	 * parent resolves it from the role defaults or the session's language; a
	 * running child keeps the copy it started with, so a later parent change does
	 * not reach it.
	 */
	languageContract?: LanguageContract;
	/** The parent's scanning mode, so a child never re-blocks what the user unblocked. */
	textguardMode?: TextGuardMode;
	task: string;
}
export type WorkerCommand =
	| { type: "start"; launch: WorkerLaunch }
	| { type: "steer"; id: string; text: string }
	| { type: "stop" };
export type WorkerEvent =
	| { type: "schedule_warning"; text: string }
	| { type: "schedules_cancelled"; count: number }
	| { type: "ready"; sessionFile: string; sessionId: string }
	| { type: "activity"; tool: string }
	| { type: "message"; role: string; text: string; entryId?: string }
	| WorkerUsage
	| { type: "control"; id: string; status: "queued" | "rejected" }
	| { type: "result"; status: "completed" | "failed" | "cancelled"; text: string };
