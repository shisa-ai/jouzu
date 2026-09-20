import type { ExtensionAPI, InlineExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { type AgentRun, isActiveRun } from "../subagents/manager.js";
import type { PiFlowAttachment } from "./pi-attachment.js";
import type { PiSessionFlowIngress } from "./pi-session-ingress.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowExecutionEvidence, FlowExecutionIdentity } from "./wait-producers.js";

export const SUBAGENT_WAIT_SOURCE = "jouzu:subagent-wait-source";
export interface SubagentWaitSourceRequest {
	sessionId: string;
	accept(source: { get(id: string): AgentRun; subscribe(changed: () => void): () => void }): void;
}

export function subagentWaitEvidence(identity: FlowExecutionIdentity, run: AgentRun): FlowExecutionEvidence {
	if (
		identity.handle !== identity.execution ||
		run.id !== identity.execution ||
		run.parentSessionId !== identity.scope.sessionId
	)
		throw new FlowLedgerError("identity", "Subagent wait does not name this session's exact run.");
	const pending = isActiveRun(run);
	return {
		...structuredClone(identity),
		revision: pending ? 1 : 2,
		predicates: [
			{
				until: "terminal",
				state: pending
					? "pending"
					: run.status === "completed"
						? "satisfied"
						: run.status === "cancelled"
							? "cancelled"
							: "failed",
			},
		],
	};
}

/** Bind only successful launches whose work was captured before the tool ran. */
export function createSubagentWaitExtension(options: {
	ingress(): PiSessionFlowIngress;
	enabled(): boolean;
	onError(error: unknown): void;
}): InlineExtension & {
	attach(attachment: PiFlowAttachment, sessionManager: SessionManager): void;
	detach(): Promise<void>;
} {
	let events: ExtensionAPI["events"] | undefined;
	let attached: PiFlowAttachment | undefined;
	let registration: ReturnType<PiFlowAttachment["waitProducers"]["register"]> | undefined;
	const calls = new Map<string, { attachment: PiFlowAttachment; work: { id: string; revision: number } }>();
	return {
		name: "jouzu-subagent-waits",
		factory(pi) {
			events = pi.events;
			pi.on("tool_call", (event) => {
				if (
					event.toolName !== "subagent" ||
					!["launch", "resume"].includes(String(event.input.op)) ||
					!options.enabled() ||
					!registration
				)
					return;
				const branch = options.ingress().branch();
				if (branch.attachment !== attached) throw new FlowLedgerError("stale", "Subagent wait branch changed.");
				const current = branch.workContext.current();
				if (!current)
					throw new FlowLedgerError(
						"identity",
						"Subagent launch requires current owning work. Continue from an authorized user or task turn.",
					);
				calls.set(event.toolCallId, {
					attachment: branch.attachment,
					work: branch.attachment.waits.captureExecutionWork(current.id, current.revision, "subagent"),
				});
			});
			pi.on("tool_result", async (event) => {
				if (event.toolName !== "subagent") return;
				const captured = calls.get(event.toolCallId);
				calls.delete(event.toolCallId);
				if (!captured || event.isError) return;
				if (
					!options.enabled() ||
					captured.attachment !== attached ||
					options.ingress().branch().attachment !== attached
				)
					return;
				try {
					const text = event.content.find((part) => part.type === "text");
					const result = JSON.parse(text?.type === "text" ? text.text : "null") as { id?: unknown } | null;
					if (!result || typeof result.id !== "string")
						throw new FlowLedgerError("schema", "Subagent launch returned no run identity.");
					const bound = await registration?.bind(
						{ workId: captured.work.id, handle: result.id, execution: result.id },
						captured.work.revision,
					);
					if (!bound) throw new FlowLedgerError("stale", "Subagent wait source detached before registration.");
					await bound.flush();
					if (captured.attachment !== attached)
						throw new FlowLedgerError("stale", "Subagent wait source changed during registration.");
					const waitDependency = { producer: "subagent", handle: result.id, execution: result.id, until: "terminal" };
					return {
						content: [...event.content, { type: "text" as const, text: JSON.stringify({ waitDependency }) }],
						details: { ...(event.details && typeof event.details === "object" ? event.details : {}), waitDependency },
					};
				} catch (error) {
					options.onError(error);
					return {
						content: [
							...event.content,
							{
								type: "text" as const,
								text: "The subagent launch succeeded, but its wait receipt could not be registered. Retain the run ID and use its completion notification; do not repeat the launch.",
							},
						],
						isError: true,
					};
				}
			});
			pi.on("agent_end", () => {
				calls.clear();
			});
		},
		attach(attachment, sessionManager) {
			calls.clear();
			attached = undefined;
			registration = undefined;
			if (!events) throw new FlowLedgerError("stale", "Subagent wait extension is not loaded.");
			let source: Parameters<SubagentWaitSourceRequest["accept"]>[0] | undefined;
			let accepting = true;
			events.emit(SUBAGENT_WAIT_SOURCE, {
				sessionId: sessionManager.getSessionId(),
				accept(candidate) {
					if (!accepting || source)
						throw new FlowLedgerError("identity", "Subagent wait handshake is closed or repeated.");
					source = candidate;
				},
			} satisfies SubagentWaitSourceRequest);
			accepting = false;
			if (!source) return;
			const selected = source;
			const evidence = (identity: FlowExecutionIdentity) =>
				subagentWaitEvidence(identity, selected.get(identity.execution));
			registration = attachment.waitProducers.register(
				{
					version: 1,
					namespace: "subagent",
					requiresRegisteredExecution: true,
					subscribe: (identity, changed) =>
						selected.subscribe(() => {
							try {
								changed(evidence(identity));
							} catch (error) {
								options.onError(error);
							}
						}),
					async snapshot(identity) {
						return evidence(identity);
					},
					canRetireExecution(identity) {
						const run = selected.get(identity.execution);
						return !isActiveRun(run) && run.completion?.handled === true;
					},
				},
				options.onError,
			);
			attached = attachment;
		},
		async detach() {
			const previous = registration;
			registration = undefined;
			attached = undefined;
			calls.clear();
			await previous?.close();
		},
	};
}
