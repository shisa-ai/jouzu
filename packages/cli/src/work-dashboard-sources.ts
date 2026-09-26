import type { FlowStatus } from "./flow-control/flow-status.js";
import type {
	WorkDashboardSnapshot,
	WorkDashboardSource,
	WorkScope,
	WorkSourceSnapshot,
	WorkUnit,
} from "./session-ui/index.js";
import type { AgentRun } from "./subagents/manager.js";
import { sanitizeTerminalText } from "./terminal-layout.js";

const timestamp = (value: string): number | undefined => {
	const result = Date.parse(value);
	return Number.isFinite(result) ? result : undefined;
};
export function childWorkSnapshot(scope: WorkScope, runs: AgentRun[]): WorkSourceSnapshot {
	return {
		availability: "available",
		complete: true,
		units: runs
			.filter((run) => run.parentSessionId === scope.sessionId)
			.map((run): WorkUnit => {
				const finished = !["queued", "starting", "running"].includes(run.status);
				return {
					id: run.id,
					producer: "subagent",
					owner: run.parentSessionId,
					kind: "agent",
					state: run.status === "starting" ? "queued" : run.status === "interrupted" ? "failed" : run.status,
					label: sanitizeTerminalText(run.role.id),
					detail: sanitizeTerminalText(run.currentTool ?? run.task),
					route: "/workflow",
					revision: run.completion?.revision ?? run.updatedAt,
					createdAt: timestamp(run.createdAt),
					// Notification handling writes do not change updatedAt.
					...(finished ? { completedAt: timestamp(run.updatedAt) } : {}),
					attention:
						finished && run.completion?.handled === false
							? [{ id: run.completion.revision, type: "result", since: timestamp(run.updatedAt), route: "/workflow" }]
							: [],
				};
			}),
	};
}
/** Queued and running children, matching the Session Line count; undefined until the source has read. */
export function activeChildCount(snapshot: WorkDashboardSnapshot): number | undefined {
	const source = snapshot.sources.subagent;
	if (!source || source.availability === "unknown") return undefined;
	return source.units.filter((unit) => unit.state === "queued" || unit.state === "running").length;
}
export function createChildWorkSource(service: {
	runs(): AgentRun[];
	subscribe(changed: () => void): () => void;
	/** Unknown until the workflow manager finishes attaching. */
	sessionId(): string | undefined;
}): WorkDashboardSource {
	return {
		id: "subagent",
		membership: "session",
		subscribe: (changed) => service.subscribe(changed),
		read: (scope) =>
			service.sessionId() === scope.sessionId
				? childWorkSnapshot(scope, service.runs())
				: { availability: "unknown", complete: false, units: [] },
	};
}
/**
 * Only actionable flow conditions become units; ordinary holds and waits add no alerts. `undefined`
 * means flow control is off, which leaves nothing for it to withhold.
 */
export function flowWorkSnapshot(
	scope: WorkScope,
	status: FlowStatus | undefined,
	firstSeen?: (id: string) => number,
): WorkSourceSnapshot {
	if (!status) return { availability: "available", complete: true, units: [] };
	if (status.scope.sessionId !== scope.sessionId || status.scope.branchId !== scope.branchId)
		return { availability: "unknown", complete: false, units: [] };
	const reasons = [
		...status.retryable.map((request) => ({
			id: `request:${request.requestId}`,
			label: "Withheld request",
			revision: request.hash,
		})),
		...status.uncertain.map((attempt) => ({
			id: `attempt:${attempt.id}`,
			label: "Outcome unknown",
			revision: undefined,
		})),
		...status.unaccountable.map((work) => ({
			id: `unaccountable:${JSON.stringify([work.producer, work.description])}`,
			label: sanitizeTerminalText(work.description),
			revision: undefined,
		})),
	];
	return {
		availability: "available",
		complete: true,
		units: reasons.map((reason) => ({
			id: reason.id,
			producer: "flow",
			owner: scope.branchId,
			kind: "flow",
			state: "waiting",
			label: reason.label,
			revision: reason.revision,
			route: "/flow",
			attention: [
				{
					id: reason.id,
					type: "authority",
					route: "/flow",
					...(firstSeen ? { since: firstSeen(reason.id) } : {}),
				},
			],
		})),
	};
}
/**
 * Flow state has no change notification, so it is polled: every second while alerts are shown,
 * otherwise every five seconds. Flow records carry no onset time, so alerts are ordered by when
 * this attachment first saw them.
 */
export function createFlowWorkSource(
	read: () => Promise<FlowStatus | undefined>,
	now: () => number = Date.now,
	idleIntervalMs = 5_000,
): WorkDashboardSource {
	const seen = new Map<string, number>();
	let last: { at: number; snapshot: WorkSourceSnapshot } | undefined;
	return {
		id: "flow",
		membership: "branch",
		pollIntervalMs: 1000,
		subscribe: () => () => {},
		read: async (scope) => {
			const at = now();
			if (last && !last.snapshot.units.length && at - last.at < idleIntervalMs) return last.snapshot;
			const snapshot = flowWorkSnapshot(scope, await read(), (id) => seen.get(id) ?? at);
			const current = new Set(snapshot.units.map((unit) => unit.id));
			for (const id of seen.keys()) if (!current.has(id)) seen.delete(id);
			for (const id of current) if (!seen.has(id)) seen.set(id, at);
			last = snapshot.complete ? { at, snapshot } : undefined;
			return snapshot;
		},
	};
}
