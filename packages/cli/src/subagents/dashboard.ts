import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { fitTerminalText, sanitizeTerminalText } from "../terminal-layout.js";
import { type AgentRun, isActiveRun } from "./manager.js";

const WIDGET_KEY = "jouzu-subagents";

/** A small event-driven view; no polling timer competes with transcript rendering. */
export function renderSubagentDashboard(
	runs: readonly AgentRun[],
	width: number,
	terminalRows: number,
	theme: Pick<Theme, "fg">,
): string[] {
	if (!runs.length || width < 1) return [];
	const active = runs.filter(isActiveRun);
	const running = active.filter((run) => run.status !== "queued").length;
	const queued = active.length - running;
	const finished = runs.length - active.length;
	const maxLines = Math.max(2, Math.min(8, Math.floor(terminalRows / 4)));
	const display = [...active, ...runs.filter((run) => !isActiveRun(run))];
	const shown = display.slice(0, Math.max(0, Math.floor((maxLines - 2) / 2)));
	const lines = [
		theme.fg("customMessageLabel", `Subagents · ${running} active · ${queued} queued · ${finished} finished`),
	];
	for (const run of shown) {
		const status = `${run.status} · ${run.role.id} · ${run.model.provider}/${run.model.id}`;
		lines.push(
			theme.fg(run.status === "failed" ? "error" : isActiveRun(run) ? "accent" : "muted", sanitizeTerminalText(status)),
		);
		const activity = run.currentTool ? `${run.currentTool} · ` : "";
		lines.push(theme.fg("dim", sanitizeTerminalText(`  ${activity}${run.cwd}`)));
	}
	lines.push(
		theme.fg(
			"muted",
			`Details: /subagents · Hide: /subagents hide${display.length > shown.length ? ` · +${display.length - shown.length} more` : ""}`,
		),
	);
	return lines.map((line) => fitTerminalText(line, width, "…"));
}

export class SubagentDashboard {
	private context?: ExtensionContext;
	private visible = true;
	private installed = false;
	private runs: AgentRun[] = [];
	private render?: () => void;

	attach(ctx: ExtensionContext): void {
		this.dispose();
		this.context = ctx;
		this.visible = true;
	}
	setVisible(visible: boolean): void {
		this.visible = visible;
		this.refresh();
	}
	update(runs: AgentRun[]): void {
		this.runs = runs;
		this.refresh();
	}
	private refresh(): void {
		const ctx = this.context;
		if (!ctx || ctx.mode !== "tui" || !ctx.ui.setWidget) return;
		if (!this.visible || !this.runs.length) {
			if (this.installed) ctx.ui.setWidget(WIDGET_KEY, undefined);
			this.installed = false;
			this.render = undefined;
			return;
		}
		if (this.installed) {
			this.render?.();
			return;
		}
		this.installed = true;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				this.render = () => tui.requestRender();
				return {
					render: (width) => renderSubagentDashboard(this.runs, width, tui.terminal.rows, theme),
					invalidate() {},
				};
			},
			{ placement: "aboveEditor" },
		);
	}
	dispose(): void {
		if (this.installed) this.context?.ui.setWidget(WIDGET_KEY, undefined);
		this.installed = false;
		this.render = undefined;
		this.context = undefined;
		this.runs = [];
	}
}
