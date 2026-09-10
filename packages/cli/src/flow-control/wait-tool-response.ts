import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FlowWaitState } from "./wait-state.js";

export interface FlowWaitToolReceipt {
	token: string;
	toolCallId: string;
	toolName: "agent_wait" | "agent_wait_cancel";
	contentHash: string;
}
export function waitToolResponse(wait: FlowWaitState) {
	const details = {
		token: wait.token,
		scope: wait.scope,
		work: wait.workId,
		state: wait.state,
		reason: wait.reason,
		expiresAt: wait.expiresAt,
		...(wait.checkAt === undefined ? {} : { checkAt: wait.checkAt }),
		// Named per dependency so a reader can tell which handles are monitored and which are not.
		health: wait.on.some((handle) => handle.health)
			? wait.on.map((handle) => ({ handle: handle.handle, policy: handle.health ?? "deadline-only" }))
			: "deadline-only",
		unmet: wait.unmet,
	};
	return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}
export const waitToolContentHash = (content: unknown) =>
	createHash("sha256").update(JSON.stringify(content)).digest("hex");
export function observedWaitToolReceipt(
	message: AgentMessage,
	receipts: FlowWaitToolReceipt[],
): FlowWaitToolReceipt | undefined {
	if (message.role !== "toolResult" || message.isError || !Array.isArray(message.content)) return undefined;
	return receipts.find(
		(receipt) =>
			receipt.toolCallId === message.toolCallId &&
			receipt.toolName === message.toolName &&
			receipt.contentHash === waitToolContentHash(message.content),
	);
}
