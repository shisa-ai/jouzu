import { fitTerminalText, sanitizeTerminalText } from "./layout.js";
import { sessionActivityGlyph } from "./session-line.js";
import type { SessionUiStyles } from "./styles.js";
import { selectWork, type WorkDashboardSnapshot } from "./work-dashboard.js";

export interface WorkDashboardLayout {
	mode: "compact" | "expanded" | "hidden";
	terminalRows: number;
	/** Space left after the editor and other dock components have been budgeted. */
	availableRows: number;
	width: number;
	now: number;
	frame?: number;
	animate?: boolean;
}
export function dashboardLineBudget(layout: WorkDashboardLayout): number {
	if (layout.mode === "hidden") return 0;
	return Math.max(
		0,
		Math.floor(Math.min(layout.mode === "compact" ? 5 : 10, layout.terminalRows / 3, layout.availableRows)),
	);
}
export function renderWorkDashboard(
	snapshot: WorkDashboardSnapshot,
	layout: WorkDashboardLayout,
	styles: SessionUiStyles,
): string[] {
	const budget = dashboardLineBudget(layout);
	if (!budget || layout.width < 1) return [];
	const selected = selectWork(snapshot, layout.now, budget);
	const rows = selected.details.map((unit) => {
		const active = unit.state === "running";
		const marker = unit.attention.length ? "!" : sessionActivityGlyph({ active, text: "" }, layout.frame);
		const stale = snapshot.sources[unit.producer]?.availability === "stale" ? " [stale]" : "";
		const text = `${marker} ${unit.label} · ${unit.state}${stale}${unit.detail ? ` · ${unit.detail}` : ""}`;
		return styles.apply(
			unit.attention.length ? "session.hint.warning" : active ? "session.activity" : "session.activity.idle",
			fitTerminalText(sanitizeTerminalText(text), layout.width, "…"),
		);
	});
	if (selected.omittedCount && rows.length < budget) {
		const text = `+${selected.omittedCount}${selected.omittedAttention ? ` (!${selected.omittedAttention})` : ""} · ${selected.routes.join(" ")}`;
		rows.push(styles.apply("session.hint.muted", fitTerminalText(text, layout.width, "…")));
	}
	return rows;
}
