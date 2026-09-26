import { fitTerminalText, sanitizeTerminalText, terminalTextWidth } from "./layout.js";
import { sessionActivityGlyph } from "./session-line.js";
import type { SessionUiStyleRole, SessionUiStyles } from "./styles.js";
import {
	selectWork,
	WORK_DISPLAY_DEFAULTS,
	type WorkDashboardSnapshot,
	type WorkUnit,
	workIdentity,
} from "./work-dashboard.js";

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
const INDENT = "  ";
/** Row markers match the Session Line so one glyph means one thing on both surfaces; only the marker is colored. */
function rowMarker(unit: WorkUnit, frame = 0): { marker: string; role: SessionUiStyleRole } {
	if (unit.attention.length) return { marker: "!", role: "session.hint.warning" };
	if (unit.state === "running")
		return { marker: sessionActivityGlyph({ active: true, text: "" }, frame), role: "session.activity" };
	if (unit.state === "completed") return { marker: "✔", role: "session.hint.success" };
	if (unit.state === "failed" || unit.state === "cancelled") return { marker: "✗", role: "session.hint.error" };
	return { marker: sessionActivityGlyph({ active: false, text: "" }), role: "session.activity.idle" };
}
/** Compact elapsed time: 45s, 12m, 1h 5m. */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}
/** Fit plain segments, each with its own style, into one terminal row. */
function styledRow(parts: [string, SessionUiStyleRole][], width: number, styles: SessionUiStyles): string {
	let remaining = width;
	let row = "";
	for (const [raw, role] of parts) {
		if (remaining <= 0) break;
		const text = sanitizeTerminalText(raw);
		const fitted = fitTerminalText(text, remaining, "…");
		remaining -= terminalTextWidth(fitted);
		row += styles.apply(role, fitted);
		if (fitted !== text) break;
	}
	return row;
}
const SECTIONS: Record<WorkUnit["kind"], string> = {
	agent: "Agents",
	job: "Jobs",
	task: "Tasks",
	loop: "Loops",
	goal: "Goals",
	prompt: "Scheduled",
	flow: "Flow",
};
const SECTION_ORDER = Object.keys(SECTIONS) as WorkUnit["kind"][];
const isTerminal = (unit: WorkUnit) =>
	unit.state === "completed" || unit.state === "failed" || unit.state === "cancelled";
/** Section counts cover every unit of the kind, so a collapsed section still summarizes it. */
function sectionTitle(kind: WorkUnit["kind"], units: WorkUnit[], shown: WorkUnit[], now: number): string {
	const running = units.filter((unit) => unit.state === "running").length;
	const open = units.filter((unit) => !isTerminal(unit) && unit.state !== "running").length;
	// Producers without completion times (tasks) report their finished checklist; others only recent finishes.
	const finished = (state: WorkUnit["state"][]) =>
		units.filter(
			(unit) =>
				state.includes(unit.state) &&
				!unit.attention.length &&
				(unit.completedAt === undefined || now < unit.completedAt + WORK_DISPLAY_DEFAULTS.completionMs),
		).length;
	const done = finished(["completed"]);
	const failed = finished(["failed", "cancelled"]);
	const attention = units.filter((unit) => unit.attention.length).length;
	const hidden = units.some((unit) => !shown.includes(unit) && (!isTerminal(unit) || unit.attention.length));
	return [
		SECTIONS[kind],
		...(running ? [`${running} running`] : []),
		...(open ? [`${open} open`] : []),
		...(done ? [`${done} done`] : []),
		...(failed ? [`${failed} failed`] : []),
		...(attention ? [`!${attention}`] : []),
		...(hidden && units[0] ? [units[0].route] : []),
	].join(" · ");
}
const ATTENTION_TEXT: Record<WorkUnit["attention"][number]["type"], string> = {
	result: "unread result",
	input: "needs input",
	recovery: "needs recovery",
	authority: "needs decision",
};
/** The marker already says running, queued, and done; words appear only where they add meaning. */
function rowStatus(unit: WorkUnit): string {
	const reason = unit.attention[0];
	if (reason) return ` · ${ATTENTION_TEXT[reason.type]}`;
	return ["failed", "cancelled", "waiting", "paused"].includes(unit.state) ? ` · ${unit.state}` : "";
}
function divider(title: string, width: number, styles: SessionUiStyles): string {
	const lead = "── ";
	const label = `${title} `;
	return styledRow(
		[
			[lead, "prompt.border"],
			[label, "session.hint.muted"],
			["─".repeat(Math.max(0, width - terminalTextWidth(lead) - terminalTextWidth(label))), "prompt.border"],
		],
		width,
		styles,
	);
}
/**
 * The panel sits above the Session Line as one titled divider per producer kind with indented rows
 * beneath. Dividers carry each section's counts, so when the budget runs out a section collapses to
 * its divider and still summarizes its work. Attention rows come first within the whole budget.
 */
export function renderWorkDashboard(
	snapshot: WorkDashboardSnapshot,
	layout: WorkDashboardLayout,
	styles: SessionUiStyles,
): string[] {
	const budget = dashboardLineBudget(layout);
	if (!budget || layout.width < 1) return [];
	const candidates = selectWork(snapshot, layout.now, Number.MAX_SAFE_INTEGER).details;
	// A blank line separates the panel from the Session Line and prompt when the budget allows it.
	const gap = budget >= 3 ? 1 : 0;
	const sections = SECTION_ORDER.filter((kind) => candidates.some((unit) => unit.kind === kind)).slice(0, budget - gap);
	if (!sections.length) return [];
	let spare = budget - gap - sections.length;
	const shown = candidates.filter((unit) => sections.includes(unit.kind) && spare-- > 0);
	const all = [
		...new Map(
			Object.values(snapshot.sources)
				.flatMap((source) => source.units)
				.map((unit) => [workIdentity(unit), unit]),
		).values(),
	];
	const rows: string[] = [];
	for (const kind of sections) {
		const members = shown.filter((unit) => unit.kind === kind);
		rows.push(
			divider(
				sectionTitle(
					kind,
					all.filter((unit) => unit.kind === kind),
					members,
					layout.now,
				),
				layout.width,
				styles,
			),
		);
		for (const unit of members) {
			const { marker, role } = rowMarker(unit, layout.frame);
			const stale = snapshot.sources[unit.producer]?.availability === "stale" ? " [stale]" : "";
			const elapsed =
				unit.createdAt === undefined ? "" : ` · ${formatElapsed((unit.completedAt ?? layout.now) - unit.createdAt)}`;
			rows.push(
				styledRow(
					[
						[INDENT, "session.hint.muted"],
						[marker, role],
						[" ", "session.hint.muted"],
						[
							unit.label,
							unit.state === "running" || unit.attention.length ? "session.hint.text" : "session.hint.muted",
						],
						[`${rowStatus(unit)}${stale}${elapsed}${unit.detail ? ` · ${unit.detail}` : ""}`, "session.hint.muted"],
					],
					layout.width,
					styles,
				),
			);
		}
	}
	if (gap) rows.push("");
	return rows;
}
