import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderSubagentDashboard, SubagentDashboard } from "../dist/subagents/dashboard.js";

const theme = { fg: (_role, text) => text };
const run = (status, id = status) => ({
	id,
	status,
	role: { id: `専門家-${id}` },
	model: { provider: "fixture", id: "model" },
	cwd: "/workspace/日本語",
	currentTool: status === "running" ? "read" : undefined,
});

test("subagent pane prioritizes active runs, shows state/workspace, and fits terminal bounds", () => {
	const runs = [run("completed"), run("running"), run("queued"), run("failed")];
	const lines = renderSubagentDashboard(runs, 80, 32, theme);
	assert.match(lines[0], /1 active · 1 queued · 2 finished/);
	assert.match(lines[1], /running · 専門家/);
	assert.match(lines[2], /read · \/workspace\/日本語/);
	assert.match(lines[3], /queued/);
	assert.match(lines.at(-1), /Details: \/subagents/);
	for (const width of [1, 8, 24, 48, 80, 120])
		for (const rows of [8, 16, 24, 40]) {
			const rendered = renderSubagentDashboard(runs, width, rows, theme);
			assert.ok(rendered.length <= Math.max(2, Math.min(8, Math.floor(rows / 4))));
			for (const line of rendered) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		}
	assert.deepEqual(renderSubagentDashboard([], 48, 24, theme), []);
	const sanitized = renderSubagentDashboard([run("failed", "bad\x1b[31m\x07name")], 80, 32, theme).join("\n");
	assert.equal(sanitized.includes("\x1b"), false);
	assert.equal(sanitized.includes("\x07"), false);
});

test("pane updates on events without reinstalling and clears on hide/session shutdown", () => {
	const widgets = [];
	let renders = 0;
	let component;
	const ctx = {
		mode: "tui",
		ui: {
			setWidget(key, factory, options) {
				widgets.push({ key, factory, options });
				component = factory?.(
					{
						requestRender() {
							renders++;
						},
						terminal: { rows: 24 },
					},
					theme,
				);
			},
		},
	};
	const dashboard = new SubagentDashboard();
	dashboard.attach(ctx);
	dashboard.update([]);
	assert.equal(widgets.length, 0);
	dashboard.update([run("queued")]);
	assert.equal(widgets.length, 1);
	assert.equal(widgets[0].options.placement, "aboveEditor");
	dashboard.update([run("running")]);
	assert.equal(widgets.length, 1);
	assert.equal(renders, 1);
	assert.match(component.render(80).join("\n"), /running/);
	dashboard.setVisible(false);
	assert.equal(component, undefined);
	dashboard.update([run("completed")]);
	assert.equal(widgets.length, 2);
	dashboard.setVisible(true);
	assert.match(component.render(80).join("\n"), /completed/);
	dashboard.dispose();
	assert.equal(component, undefined);
	dashboard.update([run("failed")]);
	assert.equal(widgets.length, 4);
	dashboard.attach({ ...ctx, mode: "print" });
	dashboard.update([run("running")]);
	assert.equal(widgets.length, 4);
	dashboard.dispose();
});
