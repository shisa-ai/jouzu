import type { InlineExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { createBackgroundControllerExtension } from "./background-extension.js";
import { createFlowStatusExtension } from "./flow-status-extension.js";
import { createMultiloopControllerExtension } from "./multiloop-extension.js";
import { createFlowNoReplyExtension } from "./no-reply-tool.js";
import type { PiFlowAttachment } from "./pi-attachment.js";
import { PiSessionFlowIngress } from "./pi-session-ingress.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import { flowRunContainsUserInput } from "./run-input.js";
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
			if (attached) throw new FlowLedgerError("identity", "Flow control runtime serves one session.");
			attached = new PiSessionFlowIngress({
				root: options.root,
				// Only valid here: extensions cannot replace the stream before the SDK boundary.
				qualifyProviderRoute: true,
				maxInputBytes: limits.maxInputBytes,
				maxResultBytes: limits.maxResultBytes,
				userWorkParticipants: ["bg", "multiloop"],
				host: {
					maxPayloadBytes: limits.maxPayloadBytes,
					// Only the trailing block after the last assistant turn is this run's input, and a
					// message there is instruction unless every part of it is flow-injected. Anything
					// doubtful counts as user input, so a notification-only run is recognized without
					// ever silencing a reply the user asked for.
					containsUserInput: (input, composition) => flowRunContainsUserInput(input.transformedMessages, composition),
					consumedAttempt: multiloop.consumedAttempt,
				},
				policy: () => ({ userPending: false, recoveryBlocked: false, waitingWorkIds: [] }),
				autoRelease: { onError: options.onError, retireHistory: true },
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
