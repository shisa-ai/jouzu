import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";

export interface FlowWaitHandle {
	producer: string;
	handle: string;
	execution: string;
	until: string;
}
export interface FlowWaitObservation extends FlowWaitHandle {
	scope: FlowScope;
	workId: string;
	state: "pending" | "satisfied" | "failed" | "cancelled" | "missing";
}
export interface FlowWaitState {
	version: 1;
	token: string;
	scope: FlowScope;
	workId: string;
	reason: string;
	mode: "all" | "any";
	on: FlowWaitHandle[];
	createdAt: number;
	expiresAt: number;
	state: "waiting" | "resolved" | "failed" | "expired" | "cancelled";
	unmet: FlowWaitHandle[];
	observations: FlowWaitObservation[];
	endedAt?: number;
	cancellationReason?: string;
}
const key = (handle: FlowWaitHandle) =>
	JSON.stringify([handle.producer, handle.handle, handle.execution, handle.until]);
const identity = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 512;
const instant = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** The caller supplies one authoritative observation for every requested execution/predicate. */
function observe(wait: FlowWaitState, observations: FlowWaitObservation[]) {
	if (observations.length !== wait.on.length)
		throw new FlowLedgerError("identity", "Wait reconciliation requires every exact dependency.");
	const byHandle = new Map<string, FlowWaitObservation>();
	for (const observation of observations) {
		if (
			observation.scope.sessionId !== wait.scope.sessionId ||
			observation.scope.branchId !== wait.scope.branchId ||
			observation.workId !== wait.workId ||
			!wait.on.some((handle) => key(handle) === key(observation)) ||
			byHandle.has(key(observation)) ||
			!["pending", "satisfied", "failed", "cancelled", "missing"].includes(observation.state)
		)
			throw new FlowLedgerError("identity", "Wait observation has foreign or unsupported dependency identity.");
		byHandle.set(key(observation), observation);
	}
	return wait.on.map((handle) => byHandle.get(key(handle)) as FlowWaitObservation);
}

/** Resolve before deadline; a hard expiry is never extended by reconciliation or cancellation. */
export function reconcileFlowWait(
	wait: FlowWaitState,
	observations: FlowWaitObservation[],
	now: number,
): FlowWaitState {
	if (!instant(now) || now < wait.createdAt) throw new FlowLedgerError("schema", "Invalid wait reconciliation time.");
	if (wait.state !== "waiting") return structuredClone(wait);
	const current = observe(wait, observations);
	const next = structuredClone(wait);
	next.observations = structuredClone(current);
	next.unmet = wait.on
		.filter((_handle, index) => current[index].state !== "satisfied")
		.map((handle) => ({ ...handle }));
	if (now >= wait.expiresAt) next.state = "expired";
	else if (wait.mode === "all" ? next.unmet.length === 0 : current.some((item) => item.state === "satisfied"))
		next.state = "resolved";
	else if (
		wait.mode === "all"
			? current.some((item) => !["pending", "satisfied"].includes(item.state))
			: current.every((item) => item.state !== "pending")
	)
		next.state = "failed";
	if (next.state !== "waiting") next.endedAt = now;
	return next;
}

export function createFlowWait(
	request: Omit<
		FlowWaitState,
		"version" | "createdAt" | "state" | "unmet" | "observations" | "endedAt" | "cancellationReason"
	>,
	observations: FlowWaitObservation[],
	now: number,
	maxDurationMs: number,
): FlowWaitState {
	if (
		![request.token, request.scope.sessionId, request.scope.branchId, request.workId].every(identity) ||
		typeof request.reason !== "string" ||
		!request.reason.trim() ||
		request.reason.length > 4096 ||
		!["all", "any"].includes(request.mode) ||
		!Array.isArray(request.on) ||
		request.on.length < 1 ||
		request.on.length > 64 ||
		request.on.some((handle) => ![handle.producer, handle.handle, handle.execution, handle.until].every(identity)) ||
		new Set(request.on.map(key)).size !== request.on.length ||
		!instant(now) ||
		!Number.isSafeInteger(maxDurationMs) ||
		maxDurationMs < 1 ||
		!instant(request.expiresAt) ||
		request.expiresAt <= now ||
		"checkAt" in request
	)
		throw new FlowLedgerError("schema", "Invalid wait identity, dependencies, or deadline.");
	return reconcileFlowWait(
		{
			...structuredClone(request),
			expiresAt: Math.min(request.expiresAt, now + maxDurationMs),
			version: 1,
			createdAt: now,
			state: "waiting",
			unmet: [],
			observations: [],
		},
		observations,
		now,
	);
}

/** Cancels the gate only; this reducer has no producer-job cancellation operation. */
export function cancelFlowWait(wait: FlowWaitState, reason: string, now: number): FlowWaitState {
	if (!instant(now) || now < wait.createdAt || typeof reason !== "string" || !reason.trim() || reason.length > 4096)
		throw new FlowLedgerError("schema", "Invalid wait cancellation.");
	if (wait.state !== "waiting") return structuredClone(wait);
	return { ...structuredClone(wait), state: "cancelled", endedAt: now, cancellationReason: reason };
}
