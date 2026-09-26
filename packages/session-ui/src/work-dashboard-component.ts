import type { Component } from "@earendil-works/pi-tui";
import { SESSION_ACTIVITY_TICK_MS } from "./session-line.js";
import type { SessionUiStyles } from "./styles.js";
import { WORK_DISPLAY_DEFAULTS } from "./work-dashboard.js";
import type { WorkDashboardController } from "./work-dashboard-controller.js";
import { renderWorkDashboard, type WorkDashboardLayout } from "./work-dashboard-renderer.js";

const TERMINAL: readonly string[] = ["completed", "failed", "cancelled"];
/** One stable registration; source changes and retention deadlines only request renders. */
export class WorkDashboardComponent implements Component {
	private frame = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private readonly unsubscribe: () => void;
	constructor(
		private readonly controller: WorkDashboardController,
		private readonly styles: SessionUiStyles,
		private readonly layout: (width: number) => Omit<WorkDashboardLayout, "width" | "now" | "frame">,
		private readonly requestRender: () => void,
		private readonly now: () => number = Date.now,
	) {
		this.unsubscribe = controller.subscribe(() => {
			if (!this.disposed) this.requestRender();
		});
	}
	render(width: number): string[] {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.disposed) return [];
		const snapshot = this.controller.getSnapshot();
		if (!snapshot) return [];
		const now = this.now();
		const layout = { ...this.layout(width), width, now, frame: this.frame };
		const rows = renderWorkDashboard(snapshot, layout, this.styles);
		const units = Object.values(snapshot.sources).flatMap((source) => source.units);
		const deadlines = units
			.filter((unit) => !unit.attention.length && TERMINAL.includes(unit.state) && unit.completedAt !== undefined)
			.map((unit) => (unit.completedAt ?? -Infinity) + WORK_DISPLAY_DEFAULTS.completionMs - now)
			.filter((delay) => delay > 0);
		const animating = layout.animate !== false && rows.length > 0 && units.some((unit) => unit.state === "running");
		if (animating) deadlines.push(SESSION_ACTIVITY_TICK_MS);
		// Elapsed time on unfinished rows advances once a second without producer events or animation.
		else if (rows.length && units.some((unit) => !TERMINAL.includes(unit.state) && unit.createdAt !== undefined))
			deadlines.push(1000);
		if (deadlines.length) {
			this.timer = setTimeout(
				() => {
					this.timer = undefined;
					if (this.disposed) return;
					if (animating) this.frame++;
					this.requestRender();
				},
				Math.min(...deadlines, 2_147_483_647),
			);
			this.timer.unref?.();
		}
		return rows;
	}
	invalidate(): void {}
	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.unsubscribe();
	}
}
