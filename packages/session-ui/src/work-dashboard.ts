/** Serializable work data. Producer identities and revisions are opaque. */
export interface WorkScope {
	sessionId: string;
	branchId: string;
}
export type WorkKind = "agent" | "loop" | "goal" | "job" | "task" | "prompt" | "flow";
export type WorkState = "queued" | "running" | "waiting" | "paused" | "completed" | "failed" | "cancelled";
export type WorkAttentionType = "result" | "input" | "recovery" | "authority";
export interface WorkAttention {
	id: string;
	type: WorkAttentionType;
	since?: number;
	route: string;
}
export interface WorkUnit {
	id: string;
	producer: string;
	owner: string;
	kind: WorkKind;
	state: WorkState;
	label: string;
	detail?: string;
	revision?: string;
	createdAt?: number;
	completedAt?: number;
	attention: WorkAttention[];
	route: string;
}
export interface WorkSourceSnapshot {
	availability: "available" | "stale" | "unknown";
	complete: boolean;
	revision?: string;
	units: WorkUnit[];
}
export interface WorkDashboardSnapshot {
	scope: WorkScope;
	generation: number;
	sequence: number;
	sources: Record<string, WorkSourceSnapshot>;
}
/** Subscribe before reading; notifications invalidate a full snapshot, not a delta. */
export interface WorkDashboardSource {
	id: string;
	/** Session members survive branch navigation; branch members do not. */
	membership?: "session" | "branch";
	read(scope: WorkScope, signal: AbortSignal): WorkSourceSnapshot | Promise<WorkSourceSnapshot>;
	subscribe(changed: () => void): () => void;
	pollIntervalMs?: number;
}
export const WORK_DISPLAY_DEFAULTS = { completionMs: 30_000, detailCapacity: 100 } as const;
export interface WorkDisplayPolicy {
	completionMs: number;
	detailCapacity: number;
	filter?: (unit: WorkUnit) => boolean;
}
export interface WorkSelection {
	attentionCount: number;
	activeCount: number;
	details: WorkUnit[];
	omittedAttention: number;
	omittedCount: number;
	routes: string[];
}
export function workIdentity(unit: WorkUnit): string {
	return JSON.stringify([unit.producer, unit.id]);
}
export function groupWork(units: WorkUnit[], keys: (unit: WorkUnit) => string[]): Map<string, WorkUnit[]> {
	const groups = new Map<string, Map<string, WorkUnit>>();
	for (const unit of units)
		for (const key of keys(unit)) {
			const group = groups.get(key) ?? new Map<string, WorkUnit>();
			group.set(workIdentity(unit), unit);
			groups.set(key, group);
		}
	return new Map([...groups].map(([key, members]) => [key, [...members.values()]]));
}
const terminal = (unit: WorkUnit) => ["completed", "failed", "cancelled"].includes(unit.state);
const onset = (unit: WorkUnit) => Math.min(...unit.attention.map((reason) => reason.since ?? Infinity));
/** Filtering and retention affect detail only; attention is counted first. */
export function selectWork(
	snapshot: WorkDashboardSnapshot,
	now: number,
	lines: number,
	policy: WorkDisplayPolicy = WORK_DISPLAY_DEFAULTS,
): WorkSelection {
	const units = [
		...new Map(
			Object.values(snapshot.sources)
				.flatMap((source) => source.units)
				.map((unit) => [workIdentity(unit), unit]),
		).values(),
	];
	const attention = units.filter((unit) => unit.attention.length > 0);
	const eligible = units.filter(
		(unit) =>
			unit.attention.length ||
			!terminal(unit) ||
			(unit.completedAt !== undefined && now < unit.completedAt + policy.completionMs),
	);
	const candidates = eligible
		.filter((unit) => policy.filter?.(unit) ?? true)
		.sort(
			(a, b) =>
				Number(b.attention.length > 0) - Number(a.attention.length > 0) ||
				(onset(a) < onset(b) ? -1 : onset(a) > onset(b) ? 1 : 0) ||
				Number(terminal(a)) - Number(terminal(b)) ||
				(b.completedAt ?? b.createdAt ?? 0) - (a.completedAt ?? a.createdAt ?? 0) ||
				workIdentity(a).localeCompare(workIdentity(b)),
		)
		.slice(0, Math.max(0, Math.floor(policy.detailCapacity)));
	const budget = Math.max(0, Math.floor(lines));
	const needsSummary = eligible.length > Math.min(budget, candidates.length);
	const details = candidates.slice(0, Math.max(0, budget - Number(needsSummary)));
	const shown = new Set(details.map(workIdentity));
	return {
		attentionCount: attention.length,
		activeCount: units.filter((unit) => unit.state === "running").length,
		details,
		omittedAttention: attention.filter((unit) => !shown.has(workIdentity(unit))).length,
		omittedCount: eligible.length - details.length,
		routes: [...new Set(eligible.filter((unit) => !shown.has(workIdentity(unit))).map((unit) => unit.route))].sort(),
	};
}
