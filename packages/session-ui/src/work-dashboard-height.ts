import type { Component, TUI } from "@earendil-works/pi-tui";

type DockRoot = Component & { children?: Component[] };

/**
 * Pi's interactive root mounts document, pending messages, status, above widgets,
 * editor, below widgets, and footer in that order in both renderer modes.
 * Measure dock components, never transcript content. Returns `undefined` for an
 * unknown layout so callers fail closed; scripts/check-pi-contract.mjs fails when
 * the pinned Pi changes this order. `exclude` leaves one above-editor widget out.
 */
export function dockRows(tui: Pick<TUI, "children">, width: number, exclude?: Component): number | undefined {
	const roots = tui.children as DockRoot[];
	if (roots.length !== 7) return undefined;
	const above = roots[3];
	if (!Array.isArray(above.children)) return undefined;
	try {
		const dock = [...roots.slice(1, 3), ...above.children.filter((child) => child !== exclude), ...roots.slice(4)];
		return dock.reduce((sum, component) => sum + component.render(width).length, 0);
	} catch {
		return undefined;
	}
}

/** Rows left for the dashboard: the terminal height minus every other dock component. */
export function dashboardAvailableRows(
	tui: Pick<TUI, "children" | "terminal">,
	dashboard: Component,
	width: number,
): number {
	const above = (tui.children as DockRoot[])[3];
	if (!Array.isArray(above?.children) || !above.children.includes(dashboard)) return 0;
	const occupied = dockRows(tui, width, dashboard);
	return occupied === undefined ? 0 : Math.max(0, tui.terminal.rows - occupied);
}
