import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

export interface PromptFeatureState {
	/** Disabled delegation still permits inspecting and acknowledging retained results. */
	subagentsEnabled?: boolean;
	flowEnabled?: boolean;
}

export const FLOW_TOOLS = ["agent_wait", "agent_wait_cancel", "agent_results", "agent_no_reply"] as const;

/** Resolve prompt routing from the same selected and hidden tools Pi uses for declarations. */
export function promptCapabilities(options: BuildSystemPromptOptions, state: PromptFeatureState = {}) {
	const selected = new Set(options.selectedTools ?? ["read", "bash", "edit", "write"]);
	const hidden = new Set(options.hiddenTools ?? []);
	const tools = new Set([...selected].filter((name) => !hidden.has(name)));
	if (state.flowEnabled === false) for (const name of FLOW_TOOLS) tools.delete(name);
	const delegation = tools.has("subagent") && state.subagentsEnabled !== false;
	// Pi supports skills through either a direct reader or an indirectly reachable reader.
	const canReadSkills = selected.has("read") || selected.has("bash");
	const skills = canReadSkills
		? (options.skills ?? []).filter((skill) => {
				if (skill.name === "jouzu-delegation") return delegation;
				if (skill.name === "multiloop")
					return (
						tools.has("get_goal") ||
						tools.has("update_goal") ||
						[...tools].some((name) => name.startsWith("multiloop_"))
					);
				return true;
			})
		: [];
	return {
		tools,
		skills,
		delegation,
		asynchronous: ["bg_task", "subagent", "schedule_prompt"].some(
			(name) => tools.has(name) && (name !== "subagent" || delegation),
		),
	};
}
