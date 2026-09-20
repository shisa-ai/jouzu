import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { createFlowStatusExtension } from "../dist/flow-control/flow-status-extension.js";
import { createReleaseExtensionDiagnostics } from "../dist/release-extensions.js";
import { createRuntimeDiagnostics } from "../dist/runtime-diagnostics.js";

const metadata = { displayVersion: "test-build", piVersion: "test-pi", lock: { deviations: [] } };
test("native session report appends the host runtime line after the existing statistics", () => {
	initTheme("dark");
	for (const footer of [undefined, () => "Runtime: Jouzu startup-build · Pi test-pi"]) {
		const components = [];
		InteractiveMode.prototype.handleSessionCommand.call({
			options: { sessionInfoFooter: footer },
			session: {
				getSessionStats: () => ({
					sessionId: "session",
					sessionFile: "session.jsonl",
					totalMessages: 3,
					userMessages: 1,
					assistantMessages: 2,
					toolCalls: 0,
					toolResults: 0,
					tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, total: 15 },
					cost: 0,
				}),
			},
			sessionManager: { getSessionName: () => undefined, getEntries: () => [] },
			chatContainer: { addChild: (child) => components.push(child) },
			ui: { requestRender() {} },
		});
		const text = stripVTControlCharacters(components.flatMap((component) => component.render(160)).join("\n"));
		assert.match(text, /Session Info/);
		assert.match(text, /Total: 15/);
		if (footer) {
			assert.ok(text.indexOf("Runtime:") > text.indexOf("Total: 15"));
			assert.match(text, /Jouzu startup-build/);
		} else assert.doesNotMatch(text, /Runtime:/);
	}
});
test("runtime identity uses resolved files and preserves startup evidence after replacement", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-runtime-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "adapter.ts");
	await writeFile(path, "patched");
	const hash = createHash("sha256").update("patched").digest("hex");
	let installed = structuredClone(metadata);
	const diagnostics = createRuntimeDiagnostics(
		metadata,
		{ tasks: root },
		{
			readMetadata: () => installed,
			readPatches: () => [{ package: "tasks", files: { "adapter.ts": hash } }],
		},
	);
	assert.deepEqual(diagnostics.warnings(), []);
	assert.ok(diagnostics.report().includes(root));
	await writeFile(path, "pristine");
	installed = { ...metadata, displayVersion: "next-build" };
	assert.match(diagnostics.report(), /Running Jouzu test-build/);
	assert.match(diagnostics.report(), /Installed Jouzu next-build/);
	assert.ok(diagnostics.report().includes(hash));
	assert.equal(diagnostics.warnings().length, 1);
	assert.equal(diagnostics.summary(), "Runtime: Jouzu test-build · Pi test-pi · restart available");
	assert.match(diagnostics.about(), /Running Jouzu test-build/);
	assert.match(diagnostics.about(), /Installed Jouzu next-build/);
	assert.doesNotMatch(diagnostics.about(), /adapter\.ts|SHA-256/);
	const restarted = createRuntimeDiagnostics(
		installed,
		{ tasks: root },
		{
			readMetadata: () => installed,
			readPatches: () => [{ package: "tasks", files: { "adapter.ts": hash, "missing.ts": hash } }],
		},
	);
	assert.equal(restarted.warnings().length, 2);
	assert.match(restarted.warnings()[0], /required flow patch differs/);
});
test("unreadable build metadata never blocks diagnostics and does not claim an upgrade", () => {
	const diagnostics = createRuntimeDiagnostics(
		metadata,
		{},
		{
			readMetadata: () => {
				throw new Error("partial rebuild");
			},
			readPatches: () => [],
		},
	);
	assert.deepEqual(diagnostics.warnings(), []);
	assert.match(diagnostics.report(), /Installed Jouzu unavailable/);
	assert.equal(diagnostics.summary(), "Runtime: Jouzu test-build · Pi test-pi");
	assert.match(diagnostics.about(), /Installed Jouzu unavailable/);
});
test("runtime warnings are once per session and use stderr outside the UI", async (t) => {
	const handlers = new Map(),
		notices = [];
	let changed = false;
	createReleaseExtensionDiagnostics(
		{ degradedExtensions: [] },
		{ warnings: () => (changed ? ["Restart Jouzu"] : []) },
	).factory({ on: (name, handler) => handlers.set(name, handler) });
	const ctx = { hasUI: true, ui: { notify: (text) => notices.push(text) } };
	await handlers.get("session_start")({}, ctx);
	changed = true;
	await handlers.get("agent_end")({}, ctx);
	await handlers.get("agent_end")({}, ctx);
	assert.deepEqual(notices, ["Restart Jouzu"]);
	const stderr = [];
	t.mock.method(console, "error", (text) => stderr.push(text));
	await handlers.get("session_start")({}, { ...ctx, hasUI: false });
	assert.deepEqual(stderr, ["Jouzu warning: Restart Jouzu"]);
});
test("flow runtime reports without needing working admission or adding a model message", async () => {
	let command;
	const notices = [];
	createFlowStatusExtension({
		ingress: () => {
			throw new Error("broken ingress");
		},
		runtimeReport: () => "Running build",
	}).factory({
		on() {},
		registerMessageRenderer() {},
		registerCommand: (_name, value) => {
			command = value;
		},
	});
	await command.handler("runtime", { ui: { notify: (text) => notices.push(text) } });
	assert.deepEqual(notices, ["Running build"]);
});
