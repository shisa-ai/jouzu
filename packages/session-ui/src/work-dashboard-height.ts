import type { Component, TUI } from "@earendil-works/pi-tui";

/**
 * Pi's interactive root mounts document, pending messages, status, above widgets,
 * editor, below widgets, and footer in that order in both renderer modes.
 * Measure dock components, never transcript content. Unknown layouts fail closed, and
 * scripts/check-pi-contract.mjs fails when the pinned Pi changes this order.
 */
export function dashboardAvailableRows(
	tui: Pick<TUI, "children" | "terminal">,
	dashboard: Component,
	width: number,
): number {
	const roots = tui.children;
	if (roots.length !== 7) return 0;
	const above = roots[3] as Component & { children?: Component[] };
	if (!Array.isArray(above.children) || !above.children.includes(dashboard)) return 0;
	try {
		const dock = [...roots.slice(1, 3), ...above.children.filter((child) => child !== dashboard), ...roots.slice(4)];
		const occupied = dock.reduce((sum, component) => sum + component.render(width).length, 0);
		return Math.max(0, tui.terminal.rows - occupied);
	} catch {
		return 0;
	}
}
