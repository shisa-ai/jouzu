import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { FlowIntent } from "./admission.js";
import type { FlowProducer } from "./controller.js";
import type { FlowNativeRequestStore } from "./native-request-store.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowSubmissionStore } from "./submission-store.js";
import type { FlowWaitState } from "./wait-state.js";
import type { FlowWaitStore } from "./wait-store.js";
import { type FlowWaitToolReceipt, observedWaitToolReceipt } from "./wait-tool-response.js";

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

function decisionText(wait: FlowWaitState): string {
	return JSON.stringify({
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
	});
}

interface NativeWaitEvidence {
	submissions: Pick<FlowSubmissionStore, "snapshot">;
	requests: Pick<FlowNativeRequestStore, "snapshot">;
}

/** Only an exact retained context source included in a successful request acknowledges these decisions. */
async function deliveredNativeDecisions(
	waits: FlowWaitState[],
	evidence: NativeWaitEvidence,
	toolReceipts: FlowWaitToolReceipt[],
): Promise<Set<string>> {
	const expected = new Map(
		waits.flatMap((wait) => {
			const intent = descriptor(wait);
			return intent ? [[intent.id, decisionText(wait)] as const] : [];
		}),
	);
	const delivered = new Set<string>();
	if (!expected.size) return delivered;
	const [submissions, requests] = await Promise.all([evidence.submissions.snapshot(), evidence.requests.snapshot()]);
	const acknowledge = (message: { customType?: unknown; content?: unknown } | undefined) => {
		if (message?.customType !== "jouzu-wait-context" || typeof message.content !== "string") return;
		let items: unknown;
		try {
			items = JSON.parse(message.content).waitDecisions;
		} catch {
			return;
		}
		if (!Array.isArray(items)) return;
		for (const item of items) {
			if (
				item?.kind === "wait" &&
				item.revision === "1" &&
				typeof item.id === "string" &&
				typeof item.text === "string" &&
				expected.get(item.id) === item.text
			)
				delivered.add(item.id);
		}
	};
	for (const request of requests) {
		if (request.outcome !== "success") continue;
		for (const [offset, projection] of (request.projectionCapture?.members ?? []).entries()) {
			if (
				request.projectionCapture?.model?.members[offset]?.status === "converted" &&
				request.payload?.projections?.some(
					(item) => item.sourceIndex === projection.index && item.disposition === "included",
				)
			) {
				if (projection.message.role === "toolResult") {
					const receipt = observedWaitToolReceipt(projection.message, toolReceipts);
					const wait = receipt && waits.find((wait) => wait.token === receipt.token);
					const intent = wait && descriptor(wait);
					if (intent) delivered.add(intent.id);
				} else acknowledge(projection.message);
			}
		}
		for (const source of request.sourceCapture?.members ?? []) {
			if (
				!source.prompt ||
				!request.payload?.sources?.some((item) => item.sourceIndex === source.index && item.disposition === "included")
			)
				continue;
			const submission = submissions.find((item) => item.dispatch?.operationId === source.operationId);
			const input = submission?.dispatch?.inputs?.[source.prompt.inputIndex];
			if (input?.kind !== "context" || source.prompt.messageIndex !== 0) continue;
			const message = input.args[0] as { customType?: unknown; content?: unknown } | undefined;
			acknowledge(message);
		}
	}
	return delivered;
}

/** Terminal wait state is the durable event; existing input receipts own its delivery and recovery. */
export function createFlowWaitDecisionProducer(
	store: Pick<FlowWaitStore, "snapshot"> & Partial<Pick<FlowWaitStore, "toolReceipts">>,
	native?: NativeWaitEvidence,
): FlowProducer {
	return {
		version: 1,
		namespace,
		async snapshot(signal) {
			signal.throwIfAborted();
			const waits = await store.snapshot();
			const delivered = native
				? await deliveredNativeDecisions(waits, native, (await store.toolReceipts?.()) ?? [])
				: new Set<string>();
			signal.throwIfAborted();
			return waits.flatMap((wait) => {
				const intent = descriptor(wait);
				return intent && !delivered.has(intent.id) ? [intent] : [];
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
				text: decisionText(wait),
			};
		},
	};
}
