import { FlowLedgerError } from "./receipt-ledger.js";

/**
 * A health policy the producer registers for one exact execution. A wait may only request a policy
 * by the name its producer registered, so the host never invents liveness semantics: the producer
 * owns what counts as evidence and how long that evidence stays meaningful.
 */
export interface FlowHealthPolicy {
	/** Producer-scoped name a wait must request verbatim. */
	name: string;
	/** What the producer inspects. Recorded so a decision can name the evidence it acted on. */
	evidence: string;
	/**
	 * Evidence older than this no longer proves health. A quiet phase longer than this interval
	 * needs a policy whose freshness accounts for it, not a shorter check cadence.
	 */
	freshnessMs: number;
	/** Bounded time one probe may take before it counts as unanswered. */
	probeTimeoutMs: number;
	/** Time after evidence goes stale and its probe is unanswered before the wait ends. */
	graceMs: number;
	/** Interval between health checks once evidence is fresh. */
	cadenceMs: number;
}

/**
 * One producer observation. `revision` is monotonic per execution: replayed or reordered evidence
 * carries a revision at or below what is already retained and cannot refresh health.
 */
export interface FlowHealthEvidence {
	policy: string;
	revision: number;
	observedAt: number;
	state: "healthy" | "unhealthy";
	/**
	 * Producer-defined progress marker. A process heartbeat proves the process exists; only a
	 * marker the producer advances proves the work itself is moving.
	 */
	marker?: string;
	detail?: string;
}

export type FlowHealthVerdict =
	| { state: "healthy"; nextCheckAt: number; evidence: string }
	| { state: "unhealthy"; reason: string; evidence: string }
	| { state: "health-unknown"; reason: string; evidence: string };

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const instant = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const identity = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0 && value.length <= 512;

/** Reject a policy the host cannot act on before it is registered, rather than at the first check. */
export function validateFlowHealthPolicy(policy: FlowHealthPolicy): FlowHealthPolicy {
	if (
		!policy ||
		!identity(policy.name) ||
		!identity(policy.evidence) ||
		![policy.freshnessMs, policy.probeTimeoutMs, policy.cadenceMs].every(positive) ||
		!instant(policy.graceMs)
	)
		throw new FlowLedgerError("schema", "Invalid health policy definition.");
	// A cadence longer than freshness would declare evidence stale before the next scheduled check,
	// so the wait would end unknown on a healthy execution.
	if (policy.cadenceMs > policy.freshnessMs)
		throw new FlowLedgerError("schema", "Health check cadence must not exceed its freshness interval.");
	return {
		name: policy.name,
		evidence: policy.evidence,
		freshnessMs: policy.freshnessMs,
		probeTimeoutMs: policy.probeTimeoutMs,
		graceMs: policy.graceMs,
		cadenceMs: policy.cadenceMs,
	};
}

/** Retain the newer of two observations; equal or lower revisions are replays and never win. */
export function retainFlowHealthEvidence(
	current: FlowHealthEvidence | undefined,
	incoming: FlowHealthEvidence,
): FlowHealthEvidence {
	if (
		!incoming ||
		!identity(incoming.policy) ||
		!instant(incoming.revision) ||
		!instant(incoming.observedAt) ||
		!["healthy", "unhealthy"].includes(incoming.state) ||
		(incoming.marker !== undefined && !identity(incoming.marker)) ||
		(incoming.detail !== undefined && (typeof incoming.detail !== "string" || incoming.detail.length > 4096))
	)
		throw new FlowLedgerError("schema", "Invalid health evidence.");
	if (current && current.policy !== incoming.policy)
		throw new FlowLedgerError("identity", "Health evidence belongs to another policy.");
	if (current && incoming.revision <= current.revision) return current;
	return { ...incoming };
}

/**
 * Decide one health check without contacting a producer or the model. `since` is when the policy
 * started applying — registration time, or reattachment, whichever is later — so an execution that
 * has never reported is judged from when the host began expecting evidence rather than from zero.
 *
 * Health never moves the hard deadline: `nextCheckAt` is capped below it, and a wait that reaches
 * expiry is expired by the deadline path rather than kept alive by fresh evidence.
 */
export function assessFlowHealth(
	policy: FlowHealthPolicy,
	evidence: FlowHealthEvidence | undefined,
	now: number,
	since: number,
	expiresAt: number,
): FlowHealthVerdict {
	validateFlowHealthPolicy(policy);
	if (!instant(now) || !instant(since) || !instant(expiresAt))
		throw new FlowLedgerError("schema", "Invalid health assessment time.");
	if (evidence && evidence.policy !== policy.name)
		throw new FlowLedgerError("identity", "Health evidence belongs to another policy.");
	// An explicit producer failure is a decision now; no grace applies to a known-bad execution.
	if (evidence?.state === "unhealthy")
		return {
			state: "unhealthy",
			evidence: policy.evidence,
			reason: evidence.detail?.trim() || `${policy.evidence} reported the execution unhealthy`,
		};
	const observedAt = evidence ? Math.max(evidence.observedAt, since) : since;
	const staleAt = observedAt + policy.freshnessMs;
	if (now < staleAt)
		return { state: "healthy", evidence: policy.evidence, nextCheckAt: Math.min(staleAt, now + policy.cadenceMs) };
	// Stale evidence is not yet a decision: one bounded probe and its grace period run first.
	if (now < staleAt + policy.probeTimeoutMs + policy.graceMs)
		return {
			state: "healthy",
			evidence: policy.evidence,
			nextCheckAt: staleAt + policy.probeTimeoutMs + policy.graceMs,
		};
	return {
		state: "health-unknown",
		evidence: policy.evidence,
		reason: evidence
			? `${policy.evidence} last reported at ${evidence.observedAt} and its probe went unanswered`
			: `${policy.evidence} never reported before its probe went unanswered`,
	};
}

/** The next moment a live wait needs a health check, or undefined when it has no health policy. */
export function nextFlowHealthCheck(verdict: FlowHealthVerdict, expiresAt: number): number | undefined {
	if (verdict.state !== "healthy") return undefined;
	return verdict.nextCheckAt < expiresAt ? verdict.nextCheckAt : undefined;
}
