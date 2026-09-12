import type { TextGuardMode } from "../textguard-policy.js";
import type { AgentModel, AgentRole } from "./roles.js";

/** Credentials travel only over the private parent/child pipe, never into run records. */
export interface WorkerLaunch {
	role: AgentRole;
	model: AgentModel;
	auth: { apiKey?: string; headers?: Record<string, string>; baseUrl?: string; env?: Record<string, string> };
	cwd: string;
	directory: string;
	sessionFile?: string;
	textguardFiles?: boolean;
	/** The parent's scanning mode, so a child never re-blocks what the user unblocked. */
	textguardMode?: TextGuardMode;
	task: string;
}
export type WorkerCommand =
	| { type: "start"; launch: WorkerLaunch }
	| { type: "steer"; id: string; text: string }
	| { type: "stop" };
export type WorkerEvent =
	| { type: "ready"; sessionFile: string; sessionId: string }
	| { type: "activity"; tool: string }
	| { type: "message"; role: string; text: string; entryId?: string }
	| { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null }
	| { type: "control"; id: string; status: "queued" | "rejected" }
	| { type: "result"; status: "completed" | "failed" | "cancelled"; text: string };
