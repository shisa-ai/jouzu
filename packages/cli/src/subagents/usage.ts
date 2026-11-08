import { catalogText, defaultCatalog } from "../cli-messages.js";
import type { CatalogBundle } from "../locale-catalog.js";

export type CostSource = "provider" | "estimate" | "mixed";
export interface WorkerCost {
	total: number;
	source: "provider" | "estimate";
}
export interface WorkerUsage {
	type: "usage";
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: WorkerCost | null;
}
export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Known partial sum, even when some requests have no accounting. */
	cost: number | null;
	costComplete?: boolean;
	/** Absent on legacy records, whose provenance cannot be recovered. */
	costSource?: CostSource;
}

/** Forward Pi's figure, preserving authoritative zero but not placeholder zero. */
export function projectWorkerUsage(
	usage: Omit<WorkerUsage, "type" | "cost"> & { cost?: { total?: number; totalFromProvider?: boolean } },
): WorkerUsage {
	const total = usage.cost?.total;
	const valid = typeof total === "number" && Number.isFinite(total) && total >= 0;
	const cost: WorkerCost | null =
		valid && (usage.cost?.totalFromProvider === true || total > 0)
			? { total, source: usage.cost?.totalFromProvider === true ? "provider" : "estimate" }
			: null;
	return {
		type: "usage",
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cost,
	};
}

/** Unknown events mark an incomplete sum without discarding known charges. */
export function addWorkerUsage(usage: RunUsage, event: WorkerUsage): void {
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const)
		usage[field] += Math.max(0, event[field] || 0);
	if (event.cost === null) {
		usage.costComplete = false;
		return;
	}
	const previous = usage.cost;
	usage.cost = (previous ?? 0) + event.cost.total;
	// A legacy accumulated amount has no known provenance; do not label it billed.
	if (previous !== null && usage.costSource === undefined) return;
	usage.costSource =
		usage.costSource === undefined || usage.costSource === event.cost.source ? event.cost.source : "mixed";
}

/** Shared by tool results and Workflow; missing provenance retains legacy display. */
export function formatUsageCost(
	usage: { cost?: unknown; costComplete?: unknown; costSource?: unknown },
	catalog: CatalogBundle = defaultCatalog(),
): string | null {
	if (typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0) return null;
	const amount = `${usage.costComplete === false ? "≥ " : ""}$${usage.cost.toFixed(4)}`;
	const id =
		usage.costSource === "provider"
			? "jouzu.cli.subagent.costBilled"
			: usage.costSource === "estimate"
				? "jouzu.cli.subagent.costEstimated"
				: usage.costSource === "mixed"
					? "jouzu.cli.subagent.costMixed"
					: undefined;
	return id ? catalogText(catalog, id, { amount }) : amount;
}
