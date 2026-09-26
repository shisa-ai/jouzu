import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStrictJson } from "./model-catalog.js";
import type { JouzuPaths } from "./paths.js";
import { writeFilePrivateAtomic } from "./private-fs.js";

export type DashboardMode = "compact" | "expanded" | "hidden";
export const DASHBOARD_MODES: readonly DashboardMode[] = ["compact", "expanded", "hidden"];
export interface LoadedDashboardPolicy {
	mode: DashboardMode;
	error?: string;
}
export const dashboardPolicyPath = (paths: JouzuPaths): string => join(paths.configDir, "dashboard-policy.json");
export function loadDashboardPolicy(paths: JouzuPaths): LoadedDashboardPolicy {
	try {
		const path = dashboardPolicyPath(paths);
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192)
			throw new Error("Dashboard policy must be a regular file no larger than 8 KiB.");
		const value = parseStrictJson(readFileSync(path, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("Dashboard policy must be an object.");
		const record = value as Record<string, unknown>;
		if (Object.keys(record).some((key) => key !== "schemaVersion" && key !== "mode") || record.schemaVersion !== 1)
			throw new Error("Dashboard policy requires schemaVersion 1 and mode only.");
		if (!DASHBOARD_MODES.includes(record.mode as DashboardMode))
			throw new Error("Dashboard mode must be compact, expanded, or hidden.");
		return { mode: record.mode as DashboardMode };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: "compact" };
		return { mode: "compact", error: error instanceof Error ? error.message : String(error) };
	}
}
export function writeDashboardPolicy(paths: JouzuPaths, mode: DashboardMode): void {
	if (!DASHBOARD_MODES.includes(mode)) throw new Error("Dashboard mode must be compact, expanded, or hidden.");
	const loaded = loadDashboardPolicy(paths);
	if (loaded.error) throw new Error(`Cannot save dashboard policy: ${loaded.error}`);
	writeFilePrivateAtomic(
		dashboardPolicyPath(paths),
		`${JSON.stringify({ schemaVersion: 1, mode }, null, 2)}\n`,
		paths.configDir,
	);
}
/** Hide/show never writes the saved policy. Reset when the session attaches. */
export class DashboardVisibility {
	private hidden = false;
	reset(): void {
		this.hidden = false;
	}
	hide(): void {
		this.hidden = true;
	}
	show(): void {
		this.hidden = false;
	}
	mode(saved: DashboardMode): DashboardMode {
		return this.hidden ? "hidden" : saved;
	}
}
