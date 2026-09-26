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
			if (rows.length) assert.equal(rows.at(-1), "", "a blank line separates the panel from the Session Line");
			assert.ok(rows.every((row) => terminalTextWidth(row) <= width && !row.includes("\x1b") && !row.includes("\n")));
			// The section divider carries the full counts and route when rows are hidden.
			if (rows.length && width >= 48) assert.match(rows[0], /── Agents · 12 running · !12 · \/workflow ─/);
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
test("sections title their counts and rows follow marker, identity, status, elapsed, detail", () => {
	const unit = (id, state, extra = {}) => ({
		id,
		producer: "subagent",
		kind: "agent",
		owner: "s",
		state,
		label: "coder",
		createdAt: 0,
		attention: [],
		route: "/workflow",
		...extra,
	});
	const snapshot = {
		scope: { sessionId: "s", branchId: "b" },
		generation: 1,
		sequence: 1,
		sources: {
			subagent: {
				availability: "available",
				complete: true,
				units: [
					unit("a", "running", { detail: "bash · run tests" }),
					unit("b", "queued", { detail: "sleep" }),
					unit("c", "completed", { completedAt: 3_900_000 }),
					unit("d", "failed", { completedAt: 3_900_000 }),
					unit("e", "completed", { completedAt: 5_000, attention: [{ id: "r", type: "result" }] }),
				],
			},
		},
	};
	const rows = renderWorkDashboard(
		snapshot,
		{ mode: "expanded", terminalRows: 60, availableRows: 20, width: 80, now: 3_910_000 },
		styles,
	);
	const title = "── Agents · 1 running · 1 open · 1 done · 1 failed · !1 ";
	assert.deepEqual(rows, [
		title + "─".repeat(80 - title.length),
		"  ! coder · unread result · 5s",
		"  ⠋ coder · 1h 5m · bash · run tests",
		"  ○ coder · 1h 5m · sleep",
		"  ✔ coder · 1h 5m",
		"  ✗ coder · failed · 1h 5m",
		"",
	]);
	for (const width of [1, 2, 5, 12])
		for (const row of renderWorkDashboard(
			snapshot,
			{ mode: "compact", terminalRows: 60, availableRows: 20, width, now: 3_910_000 },
			styles,
		))
			assert.ok(terminalTextWidth(row) <= width, `width ${width}`);
});
test("attention with no other activity reads as a phrase and the label gives way first", () => {
	const snapshot = { model: { providerId: "local", modelId: "model" } };
	const line = renderSessionLine(snapshot, [], 60, styles, { text: "", active: false, attentionCount: 2 });
	assert.match(line, /^!2 attention +Local model$/);
	assert.equal(terminalTextWidth(line), 60);
	assert.doesNotMatch(
		renderSessionLine(snapshot, [], 18, styles, { text: "", active: false, attentionCount: 2 }),
		/attention/,
	);
});
