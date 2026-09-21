import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { FlowWaitState } from "./wait-state.js";

export const WAIT_ADJUSTMENT_NOTICES = [
	"checkAfter ignored: no dependency has a health policy; this wait is deadline-only.",
	"Unmatched replaceToken ignored: a new wait was declared; no live wait was replaced.",
] as const;

export interface FlowWaitToolReceipt {
	token: string;
	toolCallId: string;
	toolName: "agent_wait" | "agent_wait_cancel";
	contentHash: string;
	notices?: string[];
}
// Retained clocks accept safe integers beyond Date's range. Formatting must not reject them.
const formatInstant = (value: number): string =>
	Math.abs(value) <= 8_640_000_000_000_000 ? new Date(value).toISOString() : `${value}ms since epoch`;
export function waitToolResponse(wait: FlowWaitState, format: 1 | 2 | 3 = 3, notices: readonly string[] = []) {
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
			? wait.on.map((handle) => ({
					handle: handle.handle,
					policy: handle.health ?? "deadline-only",
				}))
			: "deadline-only",
		unmet: wait.unmet,
	};
	if (format === 1)
		return {
			content: [{ type: "text" as const, text: JSON.stringify(details) }],
			details,
		};
	// The token stays in the text because cancelling the wait needs it and details do not reach
	// the model. Everything else here is scannable context; the exact payload stays in details.
	const handles = wait.on
		.map(
			(handle) => `${handle.handle} (${handle.producer}/${handle.until}${handle.health ? ` · ${handle.health}` : ""})`,
		)
		.join(", ");
	const check = wait.checkAt === undefined ? "" : ` · check ${formatInstant(wait.checkAt)}`;
	const text = [
		`agent_wait ${wait.state} [${wait.token}] — ${handles}${check} · deadline ${formatInstant(wait.expiresAt)}`,
		wait.unmet.length ? `${wait.unmet.length} unmet` : undefined,
		wait.reason || undefined,
	]
		.filter(Boolean)
		.join(" — ");
	if (format === 2) return { content: [{ type: "text" as const, text }], details };
	const observations = wait.observations.map(
		(item) => `${item.handle} (${item.producer}/${item.until}): ${item.state}`,
	);
	const summary = [text, `mode ${wait.mode}`, observations.join(", "), wait.cancellationReason]
		.filter(Boolean)
		.join(" — ");
	return {
		content: [{ type: "text" as const, text: notices.length ? `${summary}\n${notices.join("\n")}` : summary }],
		details: structuredClone({ ...wait, ...details }),
	};
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
