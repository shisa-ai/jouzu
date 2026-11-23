/**
 * Why flow control holds model admission or one input.
 *
 * Producers record the English `reason`, which the session stores and observers compare. Clients
 * receive the code, and the user reads `jouzu.cli.flow.control.<message>`. One entry per reason
 * keeps the three together, so rewording a reason keeps its code and its translation.
 */
import { CatalogMessageId, catalogText } from "../cli-messages.js";
import type { CatalogBundle } from "../locale-catalog.js";

type HoldEntry = { readonly reason: string; readonly message?: string };

/** A recovery decision holds model admission. */
export const FLOW_RECOVERY_HOLDS = {
	"host-recovery": { reason: "host recovery is still in progress", message: "hostRecovery" },
	"request-decision": { reason: "a withheld request needs a decision", message: "requestDecision" },
	"interrupted-outcome": { reason: "an interrupted turn has an unknown outcome", message: "interruptedOutcome" },
	"wait-reconciliation": { reason: "wait sources are still being reconciled", message: "waitReconciliation" },
	"saved-decision": { reason: "saved work needs a recovery decision", message: "savedDecision" },
} as const satisfies Record<string, HoldEntry>;

/** Admission holds one input. */
export const FLOW_INPUT_HOLDS = {
	"input-missing": { reason: "Input is missing or cancelled.", message: "inputMissing" },
	"input-recovery": { reason: "Input is waiting for recovery reconciliation.", message: "inputRecovery" },
	"host-retry": { reason: "Input is waiting for host retry or compaction.", message: "hostRetry" },
	"queue-revision": { reason: "Input has no exact native queue revision.", message: "queueRevision" },
	"input-paused": {
		reason: "Automated input is paused until the next user turn is under way.",
		message: "inputPaused",
	},
	"input-interrupted": {
		reason: "Automated input is waiting for an interrupted turn to be resolved.",
		message: "inputInterrupted",
	},
	"context-receipt": {
		reason: "Deferred context requires a persistence receipt before release.",
		message: "contextReceipt",
	},
	"context-idle": { reason: "Non-waking context is waiting for an idle append boundary.", message: "contextIdle" },
	"input-independence": {
		reason: "Unclassified input cannot establish independence from a live wait.",
		message: "inputIndependence",
	},
	"queued-work": { reason: "Input is waiting for queued user work.", message: "queuedWork" },
	"host-idle": { reason: "Automated input is waiting for an idle host boundary.", message: "hostIdle" },
	"earlier-input": {
		reason: "Input is waiting for an earlier retained instruction in its lane.",
		message: "earlierInput",
	},
	"host-policy-failed": { reason: "Host admission policy failed; review input before retry." },
	"external-authorization": {
		reason: "External input authorization is unavailable; review the configuration before retrying.",
	},
} as const satisfies Record<string, HoldEntry>;

export type FlowRecoveryHoldCode = keyof typeof FLOW_RECOVERY_HOLDS;
export type FlowInputHoldCode = keyof typeof FLOW_INPUT_HOLDS;
type LocalizedInputHoldCode = "host-admission" | "semantic-admission" | "unavailable";
export type FlowHoldCode = FlowRecoveryHoldCode | FlowInputHoldCode | LocalizedInputHoldCode;

/**
 * Input holds recorded as catalog text in the session's language. Their code is found by comparing
 * the reason with the same message in the reader's catalog.
 */
export const FLOW_LOCALIZED_INPUT_HOLDS: readonly (readonly [FlowInputHoldCode | LocalizedInputHoldCode, string])[] = [
	["host-admission", CatalogMessageId.flowIngressHostAdmission],
	["semantic-admission", CatalogMessageId.flowIngressSemanticAdmission],
	["input-recovery", CatalogMessageId.flowIngressRecoveryReconciliation],
	["unavailable", CatalogMessageId.flowSubmissionUnavailable],
];

export const flowRecoveryHoldReason = (code: FlowRecoveryHoldCode): string => FLOW_RECOVERY_HOLDS[code].reason;
export const flowInputHoldReason = (code: FlowInputHoldCode): string => FLOW_INPUT_HOLDS[code].reason;

const RECORDED = new Map<string, { code: FlowHoldCode; message?: string }>(
	Object.entries<HoldEntry>({ ...FLOW_RECOVERY_HOLDS, ...FLOW_INPUT_HOLDS }).map(([code, entry]) => [
		entry.reason,
		{ code: code as FlowHoldCode, ...(entry.message ? { message: entry.message } : {}) },
	]),
);

/** The code and message key of a hold reason Jouzu records, or undefined for any other reason. */
export function flowHold(reason: string, catalog: CatalogBundle): { code: FlowHoldCode; message?: string } | undefined {
	const recorded = RECORDED.get(reason);
	if (recorded) return recorded;
	const localized = FLOW_LOCALIZED_INPUT_HOLDS.find(([, id]) => reason === catalogText(catalog, id));
	return localized ? { code: localized[0] } : undefined;
}
