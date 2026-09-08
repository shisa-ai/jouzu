import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FlowIntent } from "./admission.js";
import type { FlowProducer } from "./controller.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowWaitState } from "./wait-state.js";
import type { FlowWaitStore } from "./wait-store.js";

const namespace = "jouzu-wait-decisions";
function descriptor(wait: FlowWaitState): FlowIntent | undefined {
	// Explicit gate cancellation is already handled by its caller; it does not request a decision turn.
	if (wait.state === "waiting" || wait.state === "cancelled") return undefined;
	const id = createHash("sha256")
		.update(JSON.stringify([namespace, wait.scope.sessionId, wait.scope.branchId, wait.token]))
		.digest("hex");
	return {
		id: `wait-${id}`,
		revision: "1",
		producer: namespace,
		sequence: wait.endedAt ?? wait.createdAt,
		rank: 3,
		workId: wait.workId,
		workRevision: id,
		independent: true,
		runnable: true,
	};
}

/** Terminal wait state is the durable event; existing input receipts own its delivery and recovery. */
export function createFlowWaitDecisionProducer(store: Pick<FlowWaitStore, "snapshot">): FlowProducer {
	return {
		version: 1,
		namespace,
		async snapshot(signal) {
			signal.throwIfAborted();
			const waits = await store.snapshot();
			signal.throwIfAborted();
			return waits.flatMap((wait) => {
				const intent = descriptor(wait);
				return intent ? [intent] : [];
			});
		},
		async build(intent, signal) {
			signal.throwIfAborted();
			const waits = await store.snapshot();
			signal.throwIfAborted();
			const wait = waits.find((candidate) => isDeepStrictEqual(descriptor(candidate), intent));
			if (!wait) throw new FlowLedgerError("stale", "Wait decision no longer matches retained state.");
			return {
				id: intent.id,
				revision: intent.revision,
				kind: "wait",
				text: JSON.stringify({
					wait: {
						token: wait.token,
						work: wait.workId,
						state: wait.state,
						reason: wait.reason,
						mode: wait.mode,
						createdAt: wait.createdAt,
						expiresAt: wait.expiresAt,
						endedAt: wait.endedAt,
						unmet: wait.unmet,
						observations: wait.observations,
					},
				}),
			};
		},
	};
}
