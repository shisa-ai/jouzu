import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Marker that `@sting8k/pi-vcc` looks for in `customInstructions`. Its
 * `session_before_compact` hook claims any compaction carrying this prefix and
 * supplies its own structured summary, so Jouzu reaches the pi-vcc compactor
 * without forking it or importing its internals. When pi-vcc is absent or stops
 * recognizing the marker, Pi's own summarizer runs instead.
 */
export const PI_VCC_COMPACT_MARKER = "__pi_vcc__";

/**
 * Custom message used to resume work after a requested compaction. It carries
 * no content and is removed from the model payload by the `context` handler
 * below, so work continues from the compaction summary with no visible
 * "continue" prompt in the conversation.
 */
export const COMPACTION_CONTINUE_CUSTOM_TYPE = "jouzu-compaction-continue";

export const COMPACTION_TOOL_NAME = "compact_context";

export const COMPACTION_TOOL_DESCRIPTION =
	"Request that this session's earlier conversation be replaced with a summary so the current work can continue in a smaller context. " +
	"Compaction runs after the current turn ends, so finish the response you are writing after calling this, then continue the work. " +
	"Earlier messages stay on disk and remain searchable afterwards. " +
	"Request it when a long task needs room to continue, not on a fixed schedule.";

export const COMPACTION_TOOL_PROMPT_SNIPPET =
	"compact_context: request a summary of earlier conversation when a long task needs room to continue. It runs after the current turn.";

const REQUEST_ACCEPTED_MESSAGE =
	"Compaction requested. It runs once this turn ends; finish your current response as normal, then continue the work.";

const REQUEST_ALREADY_PENDING_MESSAGE =
	"Compaction is already requested for the end of this turn. Finish your current response as normal.";

export type CompactionRequestState = "idle" | "requested" | "dispatching";

/**
 * Tracks a model-issued compaction request across the turn boundary.
 *
 * `AgentSession.compact()` aborts the current agent run before compacting, so
 * dispatching from inside the tool call would kill the turn that asked for it.
 * The controller holds the request until the run settles, and collapses
 * repeated requests within one turn into a single compaction.
 */
export class CompactionRequestController {
	private state: CompactionRequestState = "idle";

	getState(): CompactionRequestState {
		return this.state;
	}

	/** Record a request. Returns the text handed back to the model. */
	request(): string {
		if (this.state !== "idle") return REQUEST_ALREADY_PENDING_MESSAGE;
		this.state = "requested";
		return REQUEST_ACCEPTED_MESSAGE;
	}

	/**
	 * A settled run dispatches a pending request only when the user has not
	 * queued anything; a waiting user message takes priority over compaction.
	 */
	shouldDispatch(hasPendingMessages: boolean): boolean {
		return this.state === "requested" && !hasPendingMessages;
	}

	beginDispatch(): void {
		this.state = "dispatching";
	}

	settle(): void {
		this.state = "idle";
	}
}

function isPiVccCompaction(details: unknown): boolean {
	return typeof details === "object" && details !== null && (details as { compactor?: unknown }).compactor === "pi-vcc";
}

/** User-facing outcome line for a completed compaction. */
export function describeCompactionOutcome(details: unknown): string {
	const compactor = isPiVccCompaction(details) ? " (pi-vcc summary)" : "";
	return `Context compacted at the agent's request${compactor}. Earlier messages remain searchable.`;
}

/**
 * User-facing outcome line for a compaction that did not happen. Pi reports
 * "Compaction cancelled", "Already compacted", and "Nothing to compact
 * (session too small)" for the ordinary case of there being nothing to do.
 */
export function describeCompactionFailure(error: Error): string {
	const nothingToDo =
		error.message === "Compaction cancelled" ||
		error.message === "Already compacted" ||
		error.message.startsWith("Nothing to compact");
	if (nothingToDo) return "Nothing to compact; the agent's compaction request was skipped.";
	return `The agent's compaction request failed: ${error.message}`;
}

/**
 * `parameters` reaches the provider as plain JSON Schema, so a zero-argument
 * tool needs no schema builder and no TypeBox dependency in this package.
 */
const NO_PARAMETERS = { type: "object", properties: {} } as unknown as ToolDefinition["parameters"];

/**
 * Register the model-callable compaction request on a Jouzu-owned extension.
 * The controller is injectable so turn-boundary behavior can be tested without
 * a live agent session.
 */
export function registerCompactionRequest(
	pi: ExtensionAPI,
	controller: CompactionRequestController = new CompactionRequestController(),
): CompactionRequestController {
	pi.on("context", (event) => {
		const messages = event.messages.filter(
			(message) => message.role !== "custom" || message.customType !== COMPACTION_CONTINUE_CUSTOM_TYPE,
		);
		if (messages.length !== event.messages.length) return { messages };
	});

	pi.registerTool({
		name: COMPACTION_TOOL_NAME,
		label: "Compact Context",
		description: COMPACTION_TOOL_DESCRIPTION,
		promptSnippet: COMPACTION_TOOL_PROMPT_SNIPPET,
		parameters: NO_PARAMETERS,
		async execute() {
			return { content: [{ type: "text", text: controller.request() }], details: undefined };
		},
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!controller.shouldDispatch(ctx.hasPendingMessages())) return;
		controller.beginDispatch();
		dispatchCompaction(pi, ctx, controller);
	});

	return controller;
}

function dispatchCompaction(pi: ExtensionAPI, ctx: ExtensionContext, controller: CompactionRequestController): void {
	// `ctx.compact` asserts the extension context is still active before it
	// dispatches, so it throws synchronously on a context left stale by a
	// session replacement or reload. That throw runs neither callback below, so
	// without this guard the controller would stay in `dispatching` and every
	// later request would be refused as already pending for the rest of the
	// session.
	try {
		ctx.compact({
			customInstructions: PI_VCC_COMPACT_MARKER,
			onComplete: (result) => {
				controller.settle();
				notify(ctx, describeCompactionOutcome(result?.details), "info");
				resumeAfterCompaction(pi);
			},
			onError: (error) => {
				// Deliberately no resume here. Resuming after a failed compaction
				// invites the agent to request it again immediately; the user sees
				// the notice and can steer.
				controller.settle();
				notify(ctx, describeCompactionFailure(error), "warning");
			},
		});
	} catch (error) {
		controller.settle();
		notify(ctx, describeCompactionFailure(asError(error)), "warning");
	}
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
	try {
		ctx.ui.notify(message, level);
	} catch {
		// A notification failure must not strand the session.
	}
}

/** Resume the agent after a requested compaction, without model-visible text. */
function resumeAfterCompaction(pi: ExtensionAPI): void {
	try {
		void Promise.resolve(
			pi.sendMessage(
				{ customType: COMPACTION_CONTINUE_CUSTOM_TYPE, content: [], display: false, details: undefined },
				{ triggerTurn: true, deliverAs: "followUp" },
			),
		).catch(() => {});
	} catch {
		// Resuming is best effort; the user can always continue manually.
	}
}
