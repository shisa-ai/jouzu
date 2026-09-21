import { randomUUID } from "node:crypto";
import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { FLOW_OFF_MESSAGE } from "./flow-off-message.js";
import type { PiFlowAttachment } from "./pi-attachment.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowWaitHandle } from "./wait-state.js";
import { WAIT_ADJUSTMENT_NOTICES, waitToolResponse } from "./wait-tool-response.js";

export const FLOW_WAIT_GUIDANCE = [
	"Flow control coordinates automated continuations, dependency waits, and completion notifications. Workflow tools track the requested work; a wait holds its next automatic turn while a dependency runs. Ending your turn leaves that work and its background jobs in place.",
	"Continue independent work while dependencies run. When remaining work depends on asynchronous execution, call agent_wait with the exact dependency values returned by the producer's tools. Omit work to wait as the current task or invocation; flowInput IDs identify messages, not work. A task may also wait on a job owned by its direct parent invocation. Do not invent handles or borrow a work ID from an unrelated turn; if ownership is refused, report the blocker instead of repeatedly retrying.",
	"State the dependency in the reason and choose a hard deadline with bounded slack for its expected duration. The returned expiresAt is the effective deadline after the session cap; expiry is a decision point, not proof the job stopped.",
	"Request health only with a policy name offered for that execution. Without one, the wait is deadline-only. checkAfter needs a monitored dependency. Health may end a wait early as unhealthy or health-unknown; it never extends the deadline.",
	"After agent_wait returns waiting and no independent work remains, briefly state what is running, what will unblock you, and what you will verify, then end the turn. Trust completion delivery; do not poll status, add timer-based checks, or create extra continuations merely to stay active. Inspect logs for a concrete diagnostic question or an explicit user request.",
	"On a wake, match each result's producer and execution identity to the work you are waiting for. A stopped or completed older job does not describe its replacement. Notifications can be batched; inspect every relevant result and retrieve omitted details when needed. Verify output and completion criteria before marking requested work complete.",
	"After user input or context restoration, use the supplied wait state and preserve pending work. A status question does not renew or replace a wait. At expiry or dependency failure, decide whether to repair, stop, or declare a new wait; do not retry the wait automatically.",
	"When work changes, cancel or explicitly replace its affected wait and update the owning work. Replacement requires replaceToken. agent_wait_cancel removes only the dependency gate; it does not stop the process or complete the work.",
	"The user can inspect holds with /flow and build identity with /flow runtime, pause or resume automation, or use /flow clear to release a stuck hold. These are user slash commands, not shell commands or agent tools. Report remaining blockers; do not claim reset delivered pending work.",
];

/** Include extension-specific controls only when their tools are active. */
export function flowWaitGuidance(activeTools: readonly string[]): string[] {
	const tools = new Set(activeTools);
	if (!tools.has("agent_wait")) return [];
	return [
		...FLOW_WAIT_GUIDANCE,
		...(tools.has("bg_task")
			? [
					"With bg_task, keep exit notifications enabled when relying on its completion wake; notifyOnExit: false suppresses that result notification. Copy the returned Wait dependency object into agent_wait.on, including its work and scope; omit agent_wait.work so the current task waits. The dependency work identifies the job owner, not the task to suspend.",
				]
			: []),
		...(tools.has("TaskUpdate")
			? [
					"For a task awaiting a person, use TaskUpdate waitForUser: true; for an explicit task pause, use paused: true. Clear the corresponding field when ready to resume. Use blockedBy for task dependencies. A description saying 'blocked' does not suspend automatic task continuation.",
				]
			: []),
		...(tools.has("schedule_prompt")
			? [
					"Use schedule_prompt for an action due at an explicit time or on a recurring schedule, not to poll a running job that already reports completion.",
				]
			: []),
	];
}

export interface FlowWaitToolOptions {
	attachment(): PiFlowAttachment;
	/** The work selected by the host for this tool invocation. */
	currentWork?(): { id: string; revision: number } | undefined;
	/** Host authority for the requested work, captured for this tool invocation. */
	authorize(workId: string): { actor: string; revision: number; assertActive(): void };
	enabled?(): boolean;
	maxDurationMs: number;
	now?(): number;
}
interface WaitArguments {
	work?: string;
	reason: string;
	deadline: string;
	on: (FlowWaitHandle & { work?: { id: string; revision: number }; scope?: { sessionId: string; branchId: string } })[];
	mode?: "all" | "any";
	replaceToken?: string;
	checkAfter?: string;
}
const string = { type: "string", minLength: 1, maxLength: 512 };
const reason = { type: "string", minLength: 1, maxLength: 4096 };
const waitSchema = {
	type: "object",
	additionalProperties: false,
	required: ["reason", "deadline", "on"],
	properties: {
		work: {
			...string,
			description: "Omit or pass null to use the current invocation. If supplied, must exactly match its work ID.",
		},
		reason,
		deadline: { type: "string", pattern: "^[1-9][0-9]*(ms|s|m|h|d)$" },
		checkAfter: { type: "string", pattern: "^[1-9][0-9]*(ms|s|m|h|d)$" },
		mode: { type: "string", enum: ["all", "any"] },
		replaceToken: {
			...string,
			description:
				"Omit or pass null for a new wait ('none' also works). Unknown placeholders are ignored only when no live wait exists. A retained finished token is rejected; omit it to start a new wait. To replace a live wait, copy its exact returned token.",
		},
		on: {
			type: "array",
			minItems: 1,
			maxItems: 64,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["producer", "handle", "execution", "until"],
				properties: {
					producer: string,
					handle: string,
					execution: string,
					until: string,
					health: string,
					work: {
						type: "object",
						additionalProperties: false,
						required: ["id", "revision"],
						properties: { id: string, revision: { type: "integer", minimum: 1 } },
						description: "Execution owner returned by the producer. Copy this when waiting from a different task.",
					},
					scope: {
						type: "object",
						additionalProperties: false,
						required: ["sessionId", "branchId"],
						properties: { sessionId: string, branchId: string },
					},
				},
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
			"Unsupported wait arguments. Use only the documented wait and dependency fields.",
		);
}
function text(value: unknown, max = 512): asserts value is string {
	if (typeof value !== "string" || !value.trim() || value.length > max)
		throw new FlowLedgerError("schema", "Wait identity or reason is empty or too long.");
}
/** A strict provider marks optional properties required, so a model that cannot omit one declines it
 * with null or an empty value. Neither can name a work, duration, mode, policy, or token. */
function omitUnsupplied(value: Record<string, unknown>, optional: readonly string[]): void {
	for (const key of optional) if (value[key] === null || value[key] === "") delete value[key];
}
function prepareWaitArguments(input: unknown): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input;
	const raw = structuredClone(input) as Record<string, unknown>;
	if (raw.replaceToken === "none") delete raw.replaceToken;
	omitUnsupplied(raw, ["work", "checkAfter", "mode", "replaceToken"]);
	if (Array.isArray(raw.on)) {
		for (const handle of raw.on) {
			if (handle && typeof handle === "object" && !Array.isArray(handle))
				omitUnsupplied(handle, ["health", "work", "scope"]);
		}
	}
	return raw;
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
	fields(raw, ["work", "reason", "deadline", "checkAfter", "on", "mode", "replaceToken"]);
	// This sentinel means no replacement; the store still refuses a new wait over a live one.
	if (raw.replaceToken === "none") delete raw.replaceToken;
	omitUnsupplied(raw, ["work", "checkAfter", "mode", "replaceToken"]);
	if (raw.work !== undefined) text(raw.work);
	text(raw.reason, 4096);
	duration(raw.deadline);
	if (raw.mode !== undefined && !["all", "any"].includes(raw.mode as string))
		throw new FlowLedgerError("schema", "Invalid wait mode.");
	if (raw.replaceToken !== undefined) text(raw.replaceToken);
	if (raw.checkAfter !== undefined && duration(raw.checkAfter) >= duration(raw.deadline))
		throw new FlowLedgerError("schema", "An expected check must fall before the wait deadline.");
	if (!Array.isArray(raw.on) || !raw.on.length || raw.on.length > 64)
		throw new FlowLedgerError("schema", "A wait requires 1 to 64 exact dependencies.");
	const seen = new Set<string>();
	for (const handle of raw.on) {
		fields(handle, ["producer", "handle", "execution", "until", "health", "work", "scope"]);
		omitUnsupplied(handle, ["health", "work", "scope"]);
		if (handle.work !== undefined) {
			fields(handle.work, ["id", "revision"]);
			text(handle.work.id);
			if (!Number.isSafeInteger(handle.work.revision) || (handle.work.revision as number) < 1)
				throw new FlowLedgerError("schema", "Invalid execution owner revision.");
		}
		if (handle.scope !== undefined) {
			fields(handle.scope, ["sessionId", "branchId"]);
			text(handle.scope.sessionId);
			text(handle.scope.branchId);
		}
		for (const name of ["producer", "handle", "execution", "until"]) text(handle[name]);
		if (handle.health !== undefined) text(handle.health);
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
	const requireEnabled = () => {
		if (options.enabled && !options.enabled()) throw new FlowLedgerError("stale", FLOW_OFF_MESSAGE);
	};
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
				// While flow control is off its tools refuse, so guidance that tells the model to use them
				// would be instructions it cannot follow.
				if (options.enabled && !options.enabled()) return;
				const missing = flowWaitGuidance(pi.getActiveTools()).filter((line) => !event.systemPrompt.includes(line));
				if (missing.length)
					return {
						systemPrompt: `${event.systemPrompt}\n\nFlow control and workflow coordination:\n${missing.join("\n")}`,
					};
			});
			pi.registerTool({
				name: "agent_wait",
				label: "Wait for dependencies",
				description:
					"Declare a durable dependency wait for the current invocation; omit work to select it automatically. Use exact producer/handle/execution/until values returned by producer tools, and a health policy only where that tool offered one. A successful waiting result gates that work until completion, failure, cancellation, a health decision, or the capped hard deadline. Replacement requires replaceToken.",
				promptSnippet: "agent_wait: wait for exact asynchronous dependencies with a hard deadline.",
				promptGuidelines: FLOW_WAIT_GUIDANCE,
				parameters: waitSchema,
				// Strict providers derive a required-but-nullable form; keep that representation
				// instead of letting them require a fabricated placeholder for optional fields.
				constrainedSampling: { type: "json_schema", strict: "prefer" },
				prepareArguments: prepareWaitArguments,
				async execute(toolCallId, raw, signal, _update, ctx) {
					requireEnabled();
					const args = parseWait(raw),
						attachment = options.attachment();
					if (attachment.ledger.scope.sessionId !== ctx.sessionManager.getSessionId())
						throw new FlowLedgerError("scope", "Wait tool belongs to another session.");
					const workId = args.work ?? options.currentWork?.()?.id;
					if (!workId)
						throw new FlowLedgerError(
							"identity",
							"Waiting requires a current authorized work invocation. Omit work to use the current invocation; do not invent an ID. If no invocation is available, report the blocker.",
						);
					const authority = access(attachment, workId, signal);
					for (const handle of args.on) {
						if (
							handle.scope &&
							(handle.scope.sessionId !== attachment.ledger.scope.sessionId ||
								handle.scope.branchId !== attachment.ledger.scope.branchId)
						)
							throw new FlowLedgerError("scope", "Dependency belongs to another session or branch.");
					}
					const expiresAt = now() + Math.min(duration(args.deadline), maxDurationMs);
					if (!Number.isSafeInteger(expiresAt))
						throw new FlowLedgerError("schema", "Wait expiry exceeds the supported time range.");
					// Resolve ownership before subscribing; policy checks use the captured execution evidence.
					const monitored = args.on.filter((handle) => handle.health !== undefined);
					const owners = new Map<string, string>();
					for (const handle of args.on) {
						const identity = await attachment.waitProducers.waitIdentity(
							handle.producer,
							{ workId, handle: handle.handle, execution: handle.execution },
							authority.revision,
							handle.work?.id,
						);
						authority.check();
						const key = JSON.stringify([handle.producer, handle.execution]);
						if (owners.has(key) && owners.get(key) !== identity.workId)
							throw new FlowLedgerError("identity", "Wait predicates disagree on execution ownership.");
						owners.set(key, identity.workId);
						authority.check();
					}
					// An expected check exists to reconcile health early. With no monitored dependency there is
					// nothing to reconcile, so an inapplicable check is dropped rather than refused: a provider
					// that requires every field leaves the model no way to omit it, and the deadline-only wait
					// it asked for is still declared exactly.
					const checkAt =
						args.checkAfter === undefined || !monitored.length ? undefined : now() + duration(args.checkAfter);
					const notices: string[] = [];
					if (args.checkAfter !== undefined && !monitored.length) notices.push(WAIT_ADJUSTMENT_NOTICES[0]);
					const bound = new Set<string>();
					const rollback: (() => Promise<void>)[] = [];
					try {
						for (const handle of args.on) {
							const key = JSON.stringify([handle.producer, handle.execution]);
							if (!bound.has(key)) {
								const close = await attachment.waitProducers.bindForWait(
									handle.producer,
									{ workId, handle: handle.handle, execution: handle.execution },
									authority.revision,
									owners.get(key),
								);
								if (close) rollback.push(close);
								bound.add(key);
							}
							authority.check();
						}
						for (const handle of monitored) {
							const ownerId = owners.get(JSON.stringify([handle.producer, handle.execution]));
							if (!ownerId || !handle.health)
								throw new FlowLedgerError("identity", "Monitored dependency has no captured owner or health policy.");
							await attachment.waitProducers.requirePendingHealthPolicy(
								handle.producer,
								{
									workId: ownerId,
									handle: handle.handle,
									execution: handle.execution,
								},
								handle.until,
								handle.health,
							);
							authority.check();
						}
						return waitToolResponse(
							await attachment.waits.declareOwned(
								authority.actor,
								authority.revision,
								{
									scope: { ...attachment.ledger.scope },
									workId,
									token: randomUUID(),
									reason: args.reason,
									mode: args.mode ?? "all",
									on: args.on.map(({ work: _work, scope: _scope, ...handle }) => handle),
									...(checkAt === undefined ? {} : { checkAt }),
									expiresAt,
								},
								now(),
								maxDurationMs,
								args.replaceToken,
								authority.check,
								{ toolCallId, toolName: "agent_wait" },
								// The model supplies this token. A provider that requires every property leaves it no
								// way to omit the field, so a value that names no live wait declares the wait it asked
								// for instead of failing. A live wait still requires its exact token.
								{ tolerateUnmatchedToken: true, responseNotices: notices },
							),
							3,
							notices,
						);
					} catch (error) {
						await Promise.all(rollback.map((close) => close()));
						throw error;
					}
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
					requireEnabled();
					fields(raw, ["token", "reason"]);
					text(raw.token);
					text(raw.reason, 4096);
					const args = { token: raw.token, reason: raw.reason },
						attachment = options.attachment();
					if (attachment.ledger.scope.sessionId !== ctx.sessionManager.getSessionId())
						throw new FlowLedgerError("scope", "Wait tool belongs to another session.");
					const wait = (await attachment.waits.snapshot()).find((wait) => wait.token === args.token);
					if (!wait)
						throw new FlowLedgerError(
							"identity",
							"Wait token is not registered in this branch. Copy the token returned by agent_wait in this branch; do not use a job ID or a token from another session.",
						);
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
