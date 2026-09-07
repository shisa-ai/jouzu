import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Skill } from "./skills.js";

export interface ContentPolicyResult extends AgentToolResult<unknown> {
 isError?: boolean;
}
/** Host-owned content admission; extension handlers run before these final checks. */
export interface ContentPolicy {
 filterSkills(skills: Skill[]): Promise<Skill[]>;
 readSkill(skill: Skill): Promise<string | undefined>;
 shouldInspectTool(toolName: string, input: unknown): boolean;
 filterToolResult(event: {
  toolName: string;
  toolCallId: string;
  input: unknown;
  result: ContentPolicyResult;
  signal?: AbortSignal;
 }): Promise<ContentPolicyResult>;
 filterContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>;
}
