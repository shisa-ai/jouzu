import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionUiExtension, WorkDashboardController } from "../dist/index.js";
import { dashboardAvailableRows, dockRows } from "../dist/work-dashboard-height.js";

const block = (rows) => ({ render: () => Array(rows).fill(""), invalidate() {} });

// The resolved catalog the extension reads its own text from.
const catalog = {
	format: (id) =>
		({
			"jouzu.cli.session.line.noModel": "no model",
			"jouzu.cli.session.line.attention": "attention",
			"jouzu.cli.session.status.health": "! status",
			"jouzu.cli.session.status.contextUnknown": "ctx ?",
			"jouzu.cli.session.status.detached": "detached",
			"jouzu.cli.session.dashboard.section.agent": "Agents",
			"jouzu.cli.session.dashboard.section.job": "Jobs",
			"jouzu.cli.session.dashboard.section.task": "Tasks",
			"jouzu.cli.session.dashboard.section.loop": "Loops",
			"jouzu.cli.session.dashboard.section.goal": "Goals",
			"jouzu.cli.session.dashboard.section.prompt": "Scheduled",
			"jouzu.cli.session.dashboard.section.flow": "Flow",
			"jouzu.cli.session.dashboard.attention.result": "unread result",
			"jouzu.cli.session.dashboard.attention.input": "needs input",
			"jouzu.cli.session.dashboard.attention.recovery": "needs recovery",
			"jouzu.cli.session.dashboard.attention.authority": "needs decision",
		})[id],
};
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
	assert.equal(dockRows(tui, 80, dashboard), 16, "every dock component except the excluded widget");
	assert.equal(dockRows(tui, 80), undefined, "a component that fails to render fails closed");
	editorRows = 20;
	assert.equal(dashboardAvailableRows(tui, dashboard, 80), 0);
	tui.children.pop();
	assert.equal(dashboardAvailableRows(tui, dashboard, 80), 0);
	assert.equal(dockRows(tui, 80), undefined, "an unknown layout is not measured");
});
test("dashboard registers once per attachment above the editor-hosted Session Line and tree changes do not move it", async () => {
	const handlers = new Map();
	const widgets = [];
	const attachments = [];
	const controller = new WorkDashboardController();
	const extension = createSessionUiExtension({
		catalog,
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
		ui: {
			theme: { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
			setWidget: (...args) => widgets.push(args),
			setFooter() {},
			setEditorComponent() {},
		},
	};
	try {
		await handlers.get("session_start")({}, ctx);
		assert.deepEqual(
			widgets.map(([key]) => key),
			["jouzu-work-dashboard"],
		);
		await handlers.get("session_tree")({}, ctx);
		assert.equal(widgets.length, 1);
		assert.deepEqual(attachments, [true, false]);
		await handlers.get("session_shutdown")({}, ctx);
		assert.equal(controller.getSnapshot(), undefined);
		assert.deepEqual(widgets.at(-1), ["jouzu-work-dashboard", undefined]);
		await handlers.get("session_start")({}, { ...ctx, mode: "rpc" });
		assert.equal(attachments.length, 2);
	} finally {
		await handlers.get("session_shutdown")({}, ctx);
	}
});
