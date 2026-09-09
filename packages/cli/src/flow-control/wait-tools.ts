import { randomUUID } from "node:crypto";
import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiFlowAttachment } from "./pi-attachment.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowWaitHandle } from "./wait-state.js";
import { waitToolResponse } from "./wait-tool-response.js";

export const FLOW_WAIT_GUIDANCE = [
	"Continue useful work independent of live dependencies. Before ending a turn whose remaining work depends on asynchronous execution, call agent_wait with the owning work and exact producer handles returned by its tools.",
	"State the dependency in the reason and choose a mandatory hard deadline with bounded slack. Deadline-only waits accept no checkAfter or health policy. The returned expiresAt is the effective deadline after the session cap.",
	"After agent_wait returns waiting and no independent work remains, end the turn. Do not poll status, create extra continuations, or call unrelated tools to keep a goal, loop, or task active.",
	"Use the latest supplied wait state after user input or context restoration. Status questions preserve the token and original expiry; do not redeclare or renew a wait for a status question.",
	"When work changes, cancel or explicitly replace its affected wait and update the owning work before ending the turn. Replacement requires replaceToken. At expiry or dependency failure, decide whether to repair, stop, or explicitly declare a new wait.",
	"agent_wait_cancel removes only the dependency gate. It does not stop the underlying process, retire requested work, or complete a goal or task.",
];

export interface FlowWaitToolOptions {
	attachment(): PiFlowAttachment;
	/** Host authority for the requested work, captured for this tool invocation. */
	authorize(workId: string): { actor: string; revision: number; assertActive(): void };
	maxDurationMs: number;
	now?(): number;
}
interface WaitArguments {
	work: string;
	reason: string;
	deadline: string;
	on: FlowWaitHandle[];
	mode?: "all" | "any";
	replaceToken?: string;
}
const string = { type: "string", minLength: 1, maxLength: 512 };
const reason = { type: "string", minLength: 1, maxLength: 4096 };
const waitSchema = {
	type: "object",
	additionalProperties: false,
	required: ["work", "reason", "deadline", "on"],
	properties: {
		work: string,
		reason,
		deadline: { type: "string", pattern: "^[1-9][0-9]*(ms|s|m|h|d)$" },
		mode: { type: "string", enum: ["all", "any"] },
		replaceToken: string,
		on: {
			type: "array",
			minItems: 1,
			maxItems: 64,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["producer", "handle", "execution", "until"],
				properties: { producer: string, handle: string, execution: string, until: string },
			},
		},
	},
} as unknown as ToolDefinition["parameters"];
const cancelSchema = {
	type: "object",
	additionalProperties: false,
	required: ["token", "reason"],
	properties: { token: string, reason },
} as unknown as ToolDefinition["parameters"];

function fields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !allowed.includes(key))
	)
		throw new FlowLedgerError(
			"schema",
			"Unsupported wait arguments. Use deadline-only dependencies without checkAfter or health policies.",
		);
}
function text(value: unknown, max = 512): asserts value is string {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw new FlowLedgerError("schema", "Wait identity or reason is empty or too long.");
}
function duration(value: unknown): number {
	if (typeof value !== "string")
		throw new FlowLedgerError("schema", "Wait deadline requires a duration such as 30m or 8h.");
	const match = /^([1-9][0-9]*)(ms|s|m|h|d)$/.exec(value);
	const factors: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
	const result = match ? Number(match[1]) * factors[match[2]] : NaN;
	if (!Number.isSafeInteger(result) || result < 1)
		throw new FlowLedgerError("schema", "Invalid wait deadline duration.");
	return result;
}
function parseWait(raw: unknown): WaitArguments {
	fields(raw, ["work", "reason", "deadline", "on", "mode", "replaceToken"]);
	text(raw.work);
	text(raw.reason, 4096);
	duration(raw.deadline);
	if (raw.mode !== undefined && !["all", "any"].includes(raw.mode as string))
		throw new FlowLedgerError("schema", "Invalid wait mode.");
	if (raw.replaceToken !== undefined) text(raw.replaceToken);
	if (!Array.isArray(raw.on) || !raw.on.length || raw.on.length > 64)
		throw new FlowLedgerError("schema", "A wait requires 1 to 64 exact dependencies.");
	const seen = new Set<string>();
	for (const handle of raw.on) {
		fields(handle, ["producer", "handle", "execution", "until"]);
		for (const name of ["producer", "handle", "execution", "until"]) text(handle[name]);
		const key = JSON.stringify([handle.producer, handle.handle, handle.execution, handle.until]);
		if (seen.has(key)) throw new FlowLedgerError("identity", "Wait dependencies must be unique.");
		seen.add(key);
	}
	return structuredClone(raw) as unknown as WaitArguments;
}

export function createFlowWaitExtension(options: FlowWaitToolOptions): InlineExtension {
	if (!Number.isSafeInteger(options.maxDurationMs) || options.maxDurationMs < 1)
		throw new FlowLedgerError("capacity", "Invalid session wait duration limit.");
	const maxDurationMs = options.maxDurationMs;
	const now = options.now ?? Date.now;
	function access(attachment: PiFlowAttachment, work: string, signal?: AbortSignal) {
		const authority = options.authorize(work);
		const check = () => {
			signal?.throwIfAborted();
			if (options.attachment() !== attachment) throw new FlowLedgerError("stale", "Wait tool attachment changed.");
			authority.assertActive();
		};
		check();
		return { ...authority, check };
	}
	return {
		name: "jouzu-flow-waits",
		factory(pi) {
			pi.on("before_agent_start", (event) => {
				if (!pi.getActiveTools().includes("agent_wait")) return;
				const missing = FLOW_WAIT_GUIDANCE.filter((line) => !event.systemPrompt.includes(line));
				if (missing.length)
					return { systemPrompt: `${event.systemPrompt}\n\nDependency waits:\n${missing.join("\n")}` };
			});
			pi.registerTool({
				name: "agent_wait",
				label: "Wait for dependencies",
				description:
					"Declare a durable deadline-only dependency wait for authorized work. Use exact producer/handle/execution/until values returned by producer tools. A successful waiting result gates that work until completion, failure, cancellation, or the capped hard deadline. Replacement requires replaceToken.",
				promptSnippet: "agent_wait: wait for exact asynchronous dependencies with a hard deadline.",
				promptGuidelines: FLOW_WAIT_GUIDANCE,
				parameters: waitSchema,
				async execute(toolCallId, raw, signal, _update, ctx) {
					const args = parseWait(raw),
						attachment = options.attachment();
					if (attachment.ledger.scope.sessionId !== ctx.sessionManager.getSessionId())
						throw new FlowLedgerError("scope", "Wait tool belongs to another session.");
					const authority = access(attachment, args.work, signal);
					const expiresAt = now() + Math.min(duration(args.deadline), maxDurationMs);
					if (!Number.isSafeInteger(expiresAt))
						throw new FlowLedgerError("schema", "Wait expiry exceeds the supported time range.");
					const bound = new Set<string>();
					for (const handle of args.on) {
						const key = JSON.stringify([handle.producer, handle.execution]);
						if (!bound.has(key)) {
							await attachment.waitProducers.bindForWait(
								handle.producer,
								{ workId: args.work, handle: handle.handle, execution: handle.execution },
								authority.revision,
							);
							bound.add(key);
						}
						authority.check();
					}
					return waitToolResponse(
						await attachment.waits.declareOwned(
							authority.actor,
							authority.revision,
							{
								scope: { ...attachment.ledger.scope },
								workId: args.work,
								token: randomUUID(),
								reason: args.reason,
								mode: args.mode ?? "all",
								on: args.on,
								expiresAt,
							},
							now(),
							maxDurationMs,
							args.replaceToken,
							authority.check,
							{ toolCallId, toolName: "agent_wait" },
						),
					);
				},
			});
			pi.registerTool({
				name: "agent_wait_cancel",
				label: "Cancel dependency wait",
				description:
					"Idempotently remove an authorized wait gate by token and reason. This leaves its process and requested work active.",
				promptSnippet: "agent_wait_cancel: remove a dependency gate without stopping its job or completing its work.",
				parameters: cancelSchema,
				async execute(toolCallId, raw, signal, _update, ctx) {
					fields(raw, ["token", "reason"]);
					text(raw.token);
					text(raw.reason, 4096);
					const args = { token: raw.token, reason: raw.reason },
						attachment = options.attachment();
					if (attachment.ledger.scope.sessionId !== ctx.sessionManager.getSessionId())
						throw new FlowLedgerError("scope", "Wait tool belongs to another session.");
					const wait = (await attachment.waits.snapshot()).find((wait) => wait.token === args.token);
					if (!wait) throw new FlowLedgerError("identity", "Wait token is not registered in this branch.");
					const authority = access(attachment, wait.workId, signal);
					return waitToolResponse(
						await attachment.waits.cancelOwned(
							authority.actor,
							authority.revision,
							args.token,
							args.reason,
							now(),
							authority.check,
							{ toolCallId, toolName: "agent_wait_cancel" },
						),
					);
				},
			});
		},
	};
}
