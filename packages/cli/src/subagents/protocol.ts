import type { AgentModel, AgentRole } from "./roles.js";

/** Credentials travel only over the private parent/child pipe, never into run records. */
export interface WorkerLaunch {
	role: AgentRole;
	model: AgentModel;
	auth: { apiKey?: string; headers?: Record<string, string>; baseUrl?: string; env?: Record<string, string> };
	cwd: string;
	directory: string;
	sessionFile?: string;
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
