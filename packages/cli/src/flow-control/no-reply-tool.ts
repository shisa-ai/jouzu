import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { checkFlowNoReply, NO_REPLY_REFUSALS } from "./no-reply.js";
import type { PiSessionFlowIngress } from "./pi-session-ingress.js";
import { FlowLedgerError } from "./receipt-ledger.js";

export const FLOW_NO_REPLY_GUIDANCE = [
	"A delivered result that needs no answer may end the turn with agent_no_reply, using the permission the result itself carried. Anything else — a lane instruction, a wait decision, or user input — is owed a reply, and the permission is refused for those runs.",
	"agent_no_reply is not a silence filter. It does not acknowledge other pending results, complete requested work, or carry over to a later turn.",
];

const schema = {
	type: "object",
	additionalProperties: false,
	required: ["permission"],
	properties: { permission: { type: "string", minLength: 1, maxLength: 512 } },
} as unknown as ToolDefinition["parameters"];

export interface FlowNoReplyOptions {
	ingress(): PiSessionFlowIngress;
}

/**
 * Ends a turn with no reply, for a run that carries nothing the user is owed an answer about.
 *
 * The permission is validated against current ledger state rather than taken on trust, so a token
 * from an earlier run, or one whose run has since taken user input, cannot terminate this turn.
 * Pi ends the turn only when every result in the batch terminates, so a sibling tool doing real
 * work keeps the turn alive without any special handling here.
 */
export function createFlowNoReplyExtension(options: FlowNoReplyOptions): InlineExtension {
	return {
		name: "jouzu-flow-no-reply",
		factory(pi) {
			pi.registerTool({
				name: "agent_no_reply",
				label: "End the turn without replying",
				description:
					"End this turn without a reply, for a delivered result that needs no answer. Requires the exact permission that result carried. Refused for any run carrying user input, requested work, or a wait decision.",
				promptSnippet: "agent_no_reply: end a notification-only turn without replying.",
				promptGuidelines: FLOW_NO_REPLY_GUIDANCE,
				parameters: schema,
				async execute(_toolCallId, raw, _signal, _update, ctx) {
					const permission = (raw as { permission?: unknown })?.permission;
					const ingress = options.ingress();
					const branch = ingress.branch();
					if (branch.scope.sessionId !== ctx.sessionManager.getSessionId())
						throw new FlowLedgerError("scope", "No-reply permission belongs to another session.");
					const verdict = checkFlowNoReply(await branch.attachment.ledger.snapshot(), permission);
					if (!verdict.allowed) throw new FlowLedgerError("stale", NO_REPLY_REFUSALS[verdict.reason]);
					// A visible result: the turn ends silently for the user, not invisibly in the transcript.
					return {
						content: [{ type: "text" as const, text: "Ended this turn without a reply." }],
						details: { run: verdict.attemptId },
						terminate: true,
					};
				},
			});
		},
	};
}
