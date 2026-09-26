import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionUiExtension, WorkDashboardController } from "../dist/index.js";
import { dashboardAvailableRows } from "../dist/work-dashboard-height.js";

const block = (rows) => ({ render: () => Array(rows).fill(""), invalidate() {} });
test("dock measurement reserves native widgets, multiline editor, status and footer without rendering transcript", () => {
	const dashboard = {
		render() {
			throw new Error("recursive dashboard render");
		},
	};
	let editorRows = 3;
	const tui = {
		terminal: { rows: 24 },
		children: [
			{
				render() {
					throw new Error("transcript read");
				},
			},
			block(1),
			block(2),
			{ children: [block(1), block(1), dashboard, block(5)] },
			{ render: () => Array(editorRows).fill("") },
			block(2),
			block(1),
		],
	};
	assert.equal(dashboardAvailableRows(tui, dashboard, 80), 8);
	editorRows = 20;
	assert.equal(dashboardAvailableRows(tui, dashboard, 80), 0);
	tui.children.pop();
	assert.equal(dashboardAvailableRows(tui, dashboard, 80), 0);
});
test("dashboard registration follows Session Line once per attachment and tree changes do not move it", async () => {
	const handlers = new Map();
	const widgets = [];
	const attachments = [];
	const controller = new WorkDashboardController();
	const extension = createSessionUiExtension({
		dashboard: {
			controller,
			mode: () => "hidden",
			attach: (_ctx, reset) => {
				attachments.push(reset);
				controller.attach({ sessionId: "s", branchId: "b" }, []);
			},
		},
	});
	extension.factory({
		on: (name, handler) => handlers.set(name, handler),
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	});
	const ctx = {
		mode: "tui",
		cwd: process.cwd(),
		scopedModels: [],
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		getContextUsage: () => undefined,
		ui: { setWidget: (...args) => widgets.push(args), setFooter() {}, setEditorComponent() {} },
	};
	try {
		await handlers.get("session_start")({}, ctx);
		assert.deepEqual(
			widgets.map(([key]) => key),
			["jouzu-session-line", "jouzu-work-dashboard"],
		);
		await handlers.get("session_tree")({}, ctx);
		assert.equal(widgets.length, 2);
		assert.deepEqual(attachments, [true, false]);
		await handlers.get("session_shutdown")({}, ctx);
		assert.equal(controller.getSnapshot(), undefined);
		assert.equal(widgets.at(-2)[0], "jouzu-work-dashboard");
		assert.equal(widgets.at(-2)[1], undefined);
		await handlers.get("session_start")({}, { ...ctx, mode: "rpc" });
		assert.equal(attachments.length, 2);
	} finally {
		await handlers.get("session_shutdown")({}, ctx);
	}
});
