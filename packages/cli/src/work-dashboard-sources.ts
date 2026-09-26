import type { BackgroundJobSnapshot } from "./flow-control/background-adapter.js";
import type { FlowStatus } from "./flow-control/flow-status.js";
import type { FlowTask } from "./flow-control/task-producer.js";
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
					// The task names the run; two children of one role are otherwise indistinguishable.
					detail: sanitizeTerminalText(
						[run.status === "running" ? run.currentTool : undefined, run.task.split("\n", 1)[0].trim()]
							.filter(Boolean)
							.join(" · "),
					),
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
interface ClaimEvents {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}
export interface WidgetClaimChannel {
	events: ClaimEvents | undefined;
	claim: string;
	ready: string;
}
/**
 * A producer's rows appear only while it confirms that its own widget is hidden, so work is never
 * shown twice and a producer without the claim interface keeps its native widget. The claim never
 * writes the producer's saved visibility setting; detaching releases it.
 */
export function createClaimedWorkSource(options: {
	id: string;
	channel: WidgetClaimChannel;
	/** Units in scope, or undefined while the producer's inventory is unavailable. */
	read(scope: WorkScope): WorkUnit[] | undefined;
	subscribe?(changed: () => void): () => void;
	pollIntervalMs?: number;
}): WorkDashboardSource {
	const { events, claim, ready } = options.channel;
	let release: (() => void) | undefined;
	const acquire = () => {
		if (!events || release) return;
		try {
			events.emit(claim, {
				version: 1,
				respond(value: unknown) {
					if (typeof value === "function") release = value as () => void;
				},
			});
		} catch {}
	};
	const drop = () => {
		const current = release;
		release = undefined;
		try {
			current?.();
		} catch {}
	};
	return {
		id: options.id,
		membership: "session",
		...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
		subscribe(changed) {
			const unsubscribe = [
				// The producer ends every claim when a session starts, then announces it can take one again.
				events?.on(ready, () => {
					release = undefined;
					changed();
				}),
				options.subscribe?.(changed),
			];
			return () => {
				for (const dispose of unsubscribe) dispose?.();
				drop();
			};
		},
		read(scope) {
			const units = options.read(scope);
			if (!units) {
				drop();
				return { availability: "available", complete: true, units: [] };
			}
			acquire();
			return { availability: "available", complete: true, units: release ? units : [] };
		},
	};
}
const TASK_STATES: Record<FlowTask["state"], WorkUnit["state"]> = {
	active: "queued",
	blocked: "waiting",
	paused: "paused",
	completed: "completed",
};
/**
 * Every task becomes a unit so the dashboard section can count the whole checklist. Completed tasks
 * carry no completion time and therefore count without taking rows. Identities sort in checklist order.
 */
export function taskWorkUnits(scope: WorkScope, tasks: FlowTask[]): WorkUnit[] {
	return tasks.map((task) => ({
		id: `#${task.taskId.padStart(8, "0")}`,
		producer: "tasks",
		owner: scope.sessionId,
		kind: "task",
		state: task.status === "in_progress" && task.state !== "completed" ? "running" : TASK_STATES[task.state],
		label: sanitizeTerminalText(`#${task.taskId} ${task.subject}`),
		...(task.reason ? { detail: sanitizeTerminalText(task.reason) } : {}),
		attention: [],
		route: "/tasks",
	}));
}
const JOB_STATES: Record<string, WorkUnit["state"]> = {
	running: "running",
	completed: "completed",
	failed: "failed",
	timed_out: "failed",
	stopped: "cancelled",
};
/** A finished job whose completion has not reached the model yet needs attention, as a child result does. */
export function jobWorkUnits(scope: WorkScope, jobs: BackgroundJobSnapshot[]): WorkUnit[] {
	return jobs
		.filter((job) => job.sessionId === scope.sessionId)
		.map((job): WorkUnit => {
			const state = JOB_STATES[job.status] ?? "queued";
			const finished = state === "completed" || state === "failed" || state === "cancelled";
			const name = job.title?.trim() || job.command?.split("\n", 1)[0].trim() || "";
			return {
				id: job.id,
				producer: "jobs",
				owner: scope.sessionId,
				kind: "job",
				state,
				label: sanitizeTerminalText(`${job.id}${name ? ` ${name}` : ""}`),
				...(state === "failed" && job.exitCode !== undefined && job.exitCode !== null
					? { detail: `exit ${job.exitCode}` }
					: {}),
				...(job.startedAt !== undefined ? { createdAt: job.startedAt } : {}),
				...(finished && job.updatedAt !== undefined ? { completedAt: job.updatedAt } : {}),
				attention:
					finished && job.notifyOnExit !== false && job.exitNotified !== true
						? [{ id: `${job.id}:exit`, type: "result", since: job.updatedAt, route: "/bg" }]
						: [],
				route: "/bg",
			};
		});
}
