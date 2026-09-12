import type { InlineExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { createBackgroundControllerExtension } from "./background-extension.js";
import { createFlowStatusExtension } from "./flow-status-extension.js";
import { createMultiloopControllerExtension } from "./multiloop-extension.js";
import { createFlowNoReplyExtension } from "./no-reply-tool.js";
import type { PiFlowAttachment } from "./pi-attachment.js";
import { PiSessionFlowIngress } from "./pi-session-ingress.js";
import { FlowLedgerError } from "./receipt-ledger.js";
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
	/** Reported to the user; flow failures never silently bypass admission. */
	onError(error: unknown): void;
	limits?: Partial<FlowControlLimits>;
}

export interface FlowControlRuntime {
	/** Pass to `pi.main` so the ingress attaches at the session creation boundary. */
	flowIngressFactory(context: { cwd: string; sessionManager: SessionManager }): Promise<PiSessionFlowIngress>;
	/** Register with `pi.main` in this order; each binds to the same ingress. */
	extensions: InlineExtension[];
	ingress(): PiSessionFlowIngress;
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
	const multiloop = createMultiloopControllerExtension({ ingress, onError: options.onError });
	const background = createBackgroundControllerExtension({
		ingress,
		currentWork: () => ingress().branch().workContext.current(),
		onError: options.onError,
	});
	const waitTools = createFlowWaitExtension({
		attachment: () => ingress().branch().attachment,
		authorize: (workId) => ingress().branch().workContext.authorize(workId),
		maxDurationMs: limits.maxWaitDurationMs,
	});
	const noReply = createFlowNoReplyExtension({ ingress });
	const status = createFlowStatusExtension({
		ingress,
		unaccountable: () =>
			multiloop
				.unboundLanes()
				.map((lane) => ({ producer: "multiloop", description: `lane ${lane.lane} (${lane.runTag})` })),
	});
	return {
		extensions: [multiloop, background, waitTools, noReply, status],
		ingress,
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
				userWorkParticipants: ["bg", "multiloop"],
				host: {
					maxPayloadBytes: limits.maxPayloadBytes,
					consumedAttempt: multiloop.consumedAttempt,
				},
				policy: () => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: [] }),
				autoRelease: { onError: options.onError, retireHistory: true },
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
					if (background.attach(attachment, sessionManager) === "unavailable")
						options.onError(
							new FlowLedgerError(
								"identity",
								"Background task waits are unavailable because the background task extension is not loaded.",
							),
						);
				},
			});
			return attached;
		},
		async dispose() {
			const active = attached;
			attached = undefined;
			await active?.dispose();
		},
	};
}
