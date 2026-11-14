import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { createLlamaExtension } from "./llama.js";
import { createDeferredMcpExtension } from "./mcp.js";

/** These tools require their own transcript result to establish ownership or acknowledge delivery. */
export function requiresDirectToolCall(name: string): boolean {
	return (
		[
			"agent_wait",
			"agent_wait_cancel",
			"agent_no_reply",
			"agent_results",
			"subagent",
			"bg_task",
			"bg_status",
			"schedule_prompt",
			"compact_context",
			"get_goal",
			"update_goal",
		].includes(name) ||
		/^Task(?:CreateMany|Create|Get|List|Update|Reorder|Execute|Output|Stop)$/.test(name) ||
		name.startsWith("multiloop_")
	);
}

/** A nested call has no individual transcript result; do not allow it to create an unobservable obligation. */
export function createDirectToolPolicyExtension(): InlineExtension {
	return {
		name: "jouzu-direct-tool-policy",
		factory(pi) {
			pi.on("tool_call", (event) => {
				if (event.parentToolCallId && requiresDirectToolCall(event.toolName))
					return {
						block: true,
						reason: `Call ${event.toolName} directly, not from another tool, so its result can be acknowledged.`,
					};
			});
		},
	};
}

/** Qualify llama.cpp chat transport, keep codemode disabled and load MCP with deferred discovery. */
export function classicHostBuiltinOverrides(): InlineExtension[] {
	return [
		createLlamaExtension(),
		{
			name: "codemode",
			builtin: true,
			replaceable: true,
			// Scripts can issue model requests outside the classic host's request checkpoint.
			factory() {},
		},
		createDeferredMcpExtension(),
	];
}
