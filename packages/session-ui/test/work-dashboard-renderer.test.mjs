import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalTextWidth } from "../dist/layout.js";
import { renderSessionLine } from "../dist/session-line.js";
import { dashboardLineBudget, renderWorkDashboard } from "../dist/work-dashboard-renderer.js";

const styles = { apply: (_role, text) => text };
test("attention survives long identities at every width that fits its badge", () => {
	const snapshot = { model: { providerId: "very-long-provider".repeat(5), modelId: "long-model".repeat(10) } };
	for (let width = 3; width <= 200; width++) {
		const row = renderSessionLine(snapshot, [], width, styles, {
			text: "activity".repeat(10),
			active: true,
			attentionCount: 12,
		});
		assert.ok(row.startsWith("!12"), `width ${width}`);
		assert.equal(terminalTextWidth(row), width);
		if (width >= 8 && width < 40) assert.ok(row.endsWith("…"), `width ${width} marks the shortened model`);
	}
});
test("dashboard obeys aggregate mode, terminal, and remaining-space budgets with Unicode", () => {
	const units = Array.from({ length: 12 }, (_, index) => ({
		id: String(index),
		producer: "subagent",
		kind: "agent",
		owner: "s",
		state: "running",
		label: "日本語 é 👨‍👩‍👧‍👦",
		detail: "\x1b[31munsafe\ntext",
		attention: [{ id: "r", type: "result" }],
		route: "/workflow",
	}));
	const snapshot = {
		scope: { sessionId: "s", branchId: "b" },
		generation: 1,
		sequence: 1,
		sources: { subagent: { availability: "stale", complete: false, units } },
	};
	const before = JSON.stringify(snapshot);
	for (const width of [24, 48, 80, 120, 200]) {
		for (const mode of ["compact", "expanded", "hidden"]) {
			const layout = { width, mode, terminalRows: 18, availableRows: 4, now: 0 };
			const rows = renderWorkDashboard(snapshot, layout, styles);
			assert.equal(rows.length, mode === "hidden" ? 0 : 4);
			assert.ok(rows.every((row) => terminalTextWidth(row) <= width && !row.includes("\x1b") && !row.includes("\n")));
			if (rows.length) assert.match(rows.at(-1), /\+9 \(!9\)/);
		}
	}
	assert.equal(dashboardLineBudget({ mode: "expanded", terminalRows: 18, availableRows: 100 }), 6);
	assert.equal(dashboardLineBudget({ mode: "compact", terminalRows: 100, availableRows: 100 }), 5);
	assert.equal(JSON.stringify(snapshot), before);
	assert.deepEqual(
		renderWorkDashboard(
			{ ...snapshot, sources: {} },
			{ width: 80, mode: "compact", terminalRows: 24, availableRows: 8, now: 0 },
			styles,
		),
		[],
	);
});
