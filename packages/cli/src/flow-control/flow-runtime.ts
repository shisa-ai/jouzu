import type { InlineExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { createBackgroundControllerExtension } from "./background-extension.js";
import { createFlowStatusExtension } from "./flow-status-extension.js";
import { createMultiloopControllerExtension } from "./multiloop-extension.js";
import { createFlowNoReplyExtension } from "./no-reply-tool.js";
import type { PiFlowAttachment } from "./pi-attachment.js";
import { PiSessionFlowIngress } from "./pi-session-ingress.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import { createSubagentObservationExtension } from "./subagent-observation-extension.js";
import { createSubagentWaitExtension } from "./subagent-waits.js";
import { createTaskControllerExtension } from "./task-extension.js";
import { createFlowWaitExtension } from "./wait-tools.js";

export interface FlowControlLimits {
	/** Composed automatic turn budget, before provider conversion. */
	maxInputBytes: number;
	/** Aggregate result envelope shared by every producer in one turn. */
	maxResultBytes: number;
	/** Largest transmitted provider payload accepted for source observation. */
	maxPayloadBytes: number;
	/** Session cap applied to every declared wait deadline. */
	maxWaitDurationMs: number;
}

export const defaultFlowControlLimits: FlowControlLimits = {
	maxInputBytes: 32 * 1024,
	maxResultBytes: 16 * 1024,
	maxPayloadBytes: 8 * 1024 * 1024,
	maxWaitDurationMs: 8 * 60 * 60 * 1000,
};

export interface FlowControlRuntimeOptions {
	/** Directory owning this installation's durable flow state. */
	root: string;
	/** Reopened interactive histories wait for the user before automated work can run. */
	interactive?: boolean;
	/** Reported to the user; flow failures never silently bypass admission. */
	onError(error: unknown): void;
	limits?: Partial<FlowControlLimits>;
	runtimeReport?(): string;
}

export interface FlowControlRuntime {
	/** Pass to `pi.main` so the ingress attaches at the session creation boundary. */
	flowIngressFactory(context: { cwd: string; sessionManager: SessionManager }): Promise<PiSessionFlowIngress>;
	/** Register with `pi.main` in this order; each binds to the same ingress. */
	extensions: InlineExtension[];
	ingress(): PiSessionFlowIngress;
	/** Flow control is on for this session: it intercepts, queues, and schedules. */
	enabled(): boolean;
	/** Flush and detach (`false`), or attach again (`true`). */
	setEnabled(enabled: boolean): Promise<{ flushed: number; waits: number }>;
	dispose(): Promise<void>;
}

/**
 * Assemble one session flow controller: provider-route qualification, semantic multiloop and
 * background adapters, wait and result tools, and idle retention. The launcher and the
 * integration fixtures share this function so neither proves an assembly the other does not run.
 */
export function createFlowControlRuntime(options: FlowControlRuntimeOptions): FlowControlRuntime {
	const limits = { ...defaultFlowControlLimits, ...options.limits };
	let attached: PiSessionFlowIngress | undefined;
	const ingress = () => {
		if (!attached) throw new FlowLedgerError("stale", "Flow control ingress is not attached.");
		return attached;
	};
	// While flow control is off, producers route through their own delivery paths and the flow tools
	// refuse. The ingress object stays attached, so turning it back on needs no re-attach or handshake.
	const enabled = () => attached?.enabled() ?? false;
	const tasks = createTaskControllerExtension({ ingress, enabled, onError: options.onError });
	const multiloop = createMultiloopControllerExtension({ ingress, enabled, onError: options.onError });
	const background = createBackgroundControllerExtension({
		ingress,
		enabled,
		currentWork: () => ingress().branch().workContext.current(),
		onError: options.onError,
	});
	const subagents = createSubagentWaitExtension({ ingress, enabled, onError: options.onError });
	const waitTools = createFlowWaitExtension({
		attachment: () => ingress().branch().attachment,
		currentWork: () => ingress().branch().workContext.current(),
		authorize: (workId) => ingress().branch().workContext.authorize(workId),
		enabled,
		maxDurationMs: limits.maxWaitDurationMs,
	});
	const noReply = createFlowNoReplyExtension({ ingress, enabled });
	const status = createFlowStatusExtension({
		ingress,
		enabled,
		setEnabled,
		runtimeReport: options.runtimeReport,
		tasks: () => tasks.inventory(),
		unaccountable: () => [
			...multiloop
				.unboundLanes()
				.map((lane) => ({ producer: "multiloop", description: `lane ${lane.lane} (${lane.runTag})` })),
			...tasks.unboundTasks().map((task) => ({
				producer: "tasks",
				description: `task #${task.taskId}; start with TaskUpdate in_progress or TaskExecute from a user turn`,
			})),
		],
	});
	return {
		extensions: [
			tasks,
			multiloop,
			background,
			subagents,
			createSubagentObservationExtension({ ingress }),
			waitTools,
			noReply,
			status,
		],
		ingress,
		enabled,
		setEnabled,
		async flowIngressFactory({ sessionManager }) {
			// The host replaces the session for resume, fork, rewind, and session switching, and calls
			// this again for each one after tearing the previous session down. One ingress serves one
			// session, so hand back a fresh one: refusing aborted every one of those operations.
			const previous = attached;
			attached = undefined;
			try {
				await previous?.dispose();
			} catch (error) {
				// The outgoing session's state is already written; failing here would abort the
				// replacement the user asked for, so report it and continue into the new session.
				options.onError(error);
			}
			attached = new PiSessionFlowIngress({
				root: options.root,
				// Only valid here: extensions cannot replace the stream before the SDK boundary.
				qualifyProviderRoute: true,
				maxInputBytes: limits.maxInputBytes,
				maxResultBytes: limits.maxResultBytes,
				userWorkParticipants: ["bg", "multiloop", "tasks", "subagent"],
				host: {
					maxPayloadBytes: limits.maxPayloadBytes,
					consumedAttempt: (attempt) => {
						multiloop.consumedAttempt(attempt);
						tasks.consumedAttempt(attempt);
					},
				},
				policy: () => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: [] }),
				autoRelease: { onError: options.onError, retireHistory: true },
				// An interrupt's hold is reported through the status extension, which owns the terminal.
				onAutomatedPause: () => void status.announcePause().catch(options.onError),
				// State from an earlier record shape is isolated rather than migrated, and the user is
				// told where it went so nothing disappears silently.
				onIsolatedState: (path) =>
					options.onError(
						new FlowLedgerError(
							"schema",
							`Flow state from an earlier version was moved aside to ${path}; this session starts with fresh state.`,
						),
					),
				attachWaitSources: async (attachment: PiFlowAttachment) => {
					subagents.attach(attachment, sessionManager);
					if (background.attach(attachment, sessionManager) === "unavailable")
						options.onError(
							new FlowLedgerError(
								"identity",
								"Background task waits are unavailable because the background task extension is not loaded.",
							),
						);
				},
				// Off releases the background delivery lease, which is what lets the task extension deliver its
				// own completion batches while flow control is out of the circuit. On takes it back.
				detachProducers: async () => {
					await subagents.detach();
					await background.detach();
				},
				reattachProducers: async () => {
					const current = attached;
					if (!current) return;
					subagents.attach(current.branch().attachment, sessionManager);
					if (background.attach(current.branch().attachment, sessionManager) === "unavailable")
						options.onError(
							new FlowLedgerError(
								"identity",
								"Background task waits are unavailable because the background task extension is not loaded.",
							),
						);
					background.install();
				},
			});
			if (options.interactive && sessionManager.getEntries().length > 0)
				attached.pauseAutomated("the session was reopened");
			return attached;
		},
		async dispose() {
			const active = attached;
			attached = undefined;
			await active?.dispose();
		},
	};

	/** Flush and detach, or attach again. Refused while a session is closing or has no ingress. */
	async function setEnabled(next: boolean): Promise<{ flushed: number; waits: number }> {
		const active = attached;
		if (!active) throw new FlowLedgerError("stale", "Flow control has no session to change.");
		if (next === active.enabled()) return { flushed: 0, waits: 0 };
		if (!next) return active.suspend();
		await active.resume();
		return { flushed: 0, waits: 0 };
	}
}
