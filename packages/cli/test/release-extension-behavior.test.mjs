import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
	createExtensionRuntime,
	loadExtensions,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { inspectReleaseExtensions } from "../dist/release-extensions.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (result) => result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");

function fakeTheme() {
	return new Proxy(
		{ bold: (value) => value },
		{
			get(target, key) {
				return target[key] ?? ((_name, value) => value ?? _name);
			},
		},
	);
}

function createHarness(root) {
	const entries = [];
	const messages = [];
	const userMessages = [];
	const notifications = [];
	const rendered = [];
	const autocompleteProviders = [];
	let activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	const builtinTools = activeTools.map((name) => ({
		name,
		label: name,
		description: name,
		parameters: { type: "object", properties: {} },
		promptGuidelines: [],
		sourceInfo: { source: "builtin", path: "<builtin>" },
	}));
	const runtime = createExtensionRuntime();
	runtime.sendMessage = (message, options) => messages.push({ message, options });
	runtime.sendUserMessage = (content, options) => userMessages.push({ content, options });
	runtime.appendEntry = (customType, data) =>
		entries.push({ id: `custom-${entries.length + 1}`, type: "custom", customType, data });
	runtime.setSessionName = () => {};
	runtime.getSessionName = () => undefined;
	runtime.setLabel = () => {};
	runtime.getActiveTools = () => [...activeTools];
	runtime.getAllTools = () => builtinTools;
	runtime.setActiveTools = (tools) => {
		activeTools = [...tools];
	};
	runtime.getCommands = () => [];
	runtime.setModel = async () => false;
	runtime.getThinkingLevel = () => "off";
	runtime.setThinkingLevel = () => {};

	const sessionFile = join(root, "session.jsonl");
	writeFileSync(
		sessionFile,
		`${[
			JSON.stringify({
				type: "message",
				id: "m1",
				message: { role: "user", content: "extension qualification active lineage" },
			}),
			JSON.stringify({ type: "message", id: "m2", message: { role: "user", content: "off lineage secret" } }),
		].join("\n")}\n`,
	);
	entries.push({
		type: "message",
		id: "m1",
		message: { role: "user", content: "extension qualification active lineage" },
	});

	const ui = {
		notify: (message, level = "info") => notifications.push({ message, level }),
		setStatus: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setTitle: () => {},
		setEditorText: () => {},
		setWorkingMessage: () => {},
		addAutocompleteProvider: (provider) => autocompleteProviders.push(provider),
		select: async () => undefined,
		input: async () => undefined,
		editor: async () => undefined,
		confirm: async () => true,
		custom: async (factory) => {
			let doneValue;
			const component = factory({ requestRender() {} }, fakeTheme(), {}, (value) => {
				doneValue = value;
			});
			if (component?.render) rendered.push(...component.render(100));
			return doneValue;
		},
	};
	const sessionManager = {
		getSessionId: () => "qualification-session",
		getSessionFile: () => sessionFile,
		getEntries: () => entries,
		getBranch: () => entries,
		getLeafId: () => entries.at(-1)?.id,
		buildContextEntries: () => entries,
	};
	const ctx = {
		cwd: root,
		mode: "rpc",
		hasUI: true,
		ui,
		sessionManager,
		signal: undefined,
		model: undefined,
		modelRegistry: { getAvailable: () => [], getProvider: () => undefined },
		scopedModels: [],
		thinkingLevel: "off",
		isProjectTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		abort: () => {},
		compact: () => {},
		shutdown: () => {},
	};
	return { runtime, ctx, entries, messages, userMessages, notifications, rendered, autocompleteProviders, sessionFile };
}

async function invokeHandlers(extensions, eventName, event, ctx) {
	const outputs = [];
	for (const extension of extensions) {
		for (const handler of extension.handlers.get(eventName) ?? []) outputs.push(await handler(event, ctx));
	}
	return outputs;
}

function getTool(extensions, name) {
	for (const extension of extensions) {
		const registered = extension.tools.get(name);
		if (registered) return registered.definition;
	}
	throw new Error(`Missing tool ${name}`);
}

function getCommand(extensions, name) {
	for (const extension of extensions) {
		const command = extension.commands.get(name);
		if (command) return command;
	}
	throw new Error(`Missing command ${name}`);
}

async function execute(tool, params, ctx, signal = new AbortController().signal) {
	return tool.execute(`qualification-${tool.name}`, params, signal, () => {}, ctx);
}

test(
	"release extensions execute stateful workflows and clean up lifecycle resources",
	{ timeout: 120_000 },
	async () => {
		const root = mkdtempSync(join(tmpdir(), "jouzu-extension-behavior-"));
		const previousCwd = process.cwd();
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousTasks = process.env.PI_TASKS;
		const previousVccConfig = process.env.PI_VCC_CONFIG_PATH;
		let extensions = [];
		let harness;
		let backgroundPid;
		try {
			process.chdir(root);
			process.env.PI_CODING_AGENT_DIR = join(root, "agent");
			process.env.PI_TASKS = "off";
			process.env.PI_VCC_CONFIG_PATH = join(root, "pi-vcc-config.json");
			mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
			writeFileSync(
				process.env.PI_VCC_CONFIG_PATH,
				JSON.stringify({ overrideDefaultCompaction: true, continueAfterThresholdCompact: true, debug: false }),
			);

			harness = createHarness(root);
			const status = inspectReleaseExtensions();
			const loaded = await loadExtensions(status.resolvedExtensionPaths, root, createEventBus(), harness.runtime);
			assert.deepEqual(loaded.errors, []);
			extensions = loaded.extensions;
			await invokeHandlers(extensions, "session_start", { type: "session_start", reason: "startup" }, harness.ctx);

			const taskCreate = await execute(
				getTool(extensions, "TaskCreate"),
				{ subject: "Qualify", description: "Exercise task state" },
				harness.ctx,
			);
			assert.match(textOf(taskCreate), /Task #1 created/u);
			await execute(getTool(extensions, "TaskUpdate"), { taskId: "1", status: "in_progress" }, harness.ctx);
			const taskList = await execute(getTool(extensions, "TaskList"), {}, harness.ctx);
			assert.match(textOf(taskList), /Qualify/u);

			const goal = getCommand(extensions, "goal");
			await goal.handler("Complete extension qualification", harness.ctx);
			const goalResult = await execute(getTool(extensions, "get_goal"), {}, harness.ctx);
			assert.match(textOf(goalResult), /Complete extension qualification/u);
			await execute(getTool(extensions, "TaskUpdate"), { taskId: "1", status: "completed" }, harness.ctx);
			const completeGoal = await execute(getTool(extensions, "update_goal"), { status: "complete" }, harness.ctx);
			assert.match(textOf(completeGoal), /complete/u);

			const scheduleTool = getTool(extensions, "schedule_prompt");
			const scheduled = await execute(
				scheduleTool,
				{ action: "add", schedule: "+1h", prompt: "qualification", type: "once", name: "qualification" },
				harness.ctx,
			);
			assert.match(textOf(scheduled), /Created cron job/u);
			const jobId = scheduled.details.jobId;
			assert.ok(jobId);
			assert.match(textOf(await execute(scheduleTool, { action: "list" }, harness.ctx)), /qualification/u);
			assert.match(textOf(await execute(scheduleTool, { action: "remove", jobId }, harness.ctx)), /Removed cron job/u);

			const startLoop = await execute(
				getTool(extensions, "multiloop_start"),
				{
					lane: "qualification",
					mode: "research",
					goal: "Exercise lifecycle",
					verifyCommand: 'node -e "console.log(1)"',
				},
				harness.ctx,
			);
			assert.match(textOf(startLoop), /qualification/u);
			await execute(
				getTool(extensions, "multiloop_iterate"),
				{ lane: "qualification", hypothesis: "state records" },
				harness.ctx,
			);
			await execute(
				getTool(extensions, "multiloop_measure"),
				{ lane: "qualification", measurements: [1], checks: [{ name: "fixture", passed: true, kind: "mechanical" }] },
				harness.ctx,
			);
			assert.match(
				textOf(
					await execute(
						getTool(extensions, "multiloop_log"),
						{ lane: "qualification", action: "log", metric: 1, note: "passed" },
						harness.ctx,
					),
				),
				/logged|recorded|iteration/iu,
			);
			assert.ok(existsSync(join(root, ".multiloop")));

			const recall = await execute(getTool(extensions, "vcc_recall"), { query: "qualification" }, harness.ctx);
			assert.match(textOf(recall), /active lineage|qualification/iu);
			const compactionEntries = [
				{ id: "c1", type: "message", message: { role: "user", content: "first goal" } },
				{ id: "c2", type: "message", message: { role: "assistant", content: "first result" } },
				{ id: "c3", type: "message", message: { role: "user", content: "second goal" } },
				{ id: "c4", type: "message", message: { role: "assistant", content: "second result" } },
			];
			const compactionResults = await invokeHandlers(
				extensions,
				"session_before_compact",
				{
					type: "session_before_compact",
					reason: "threshold",
					willRetry: false,
					branchEntries: compactionEntries,
					preparation: {
						previousSummary: undefined,
						fileOps: { read: [], written: [], edited: [] },
						tokensBefore: 1000,
					},
					signal: new AbortController().signal,
				},
				harness.ctx,
			);
			assert.ok(compactionResults.some((result) => result?.compaction?.summary));

			const skillInput = await invokeHandlers(
				extensions,
				"input",
				{ type: "input", text: "$jouzu-core check", images: [], source: "rpc" },
				harness.ctx,
			);
			assert.ok(
				skillInput.some((result) => result?.action === "transform" && result.text === "/skill:jouzu-core check"),
			);
			assert.ok(harness.autocompleteProviders.length > 0);

			const writeTool = getTool(extensions, "write");
			const writePath = join(root, "preview.txt");
			const writeResult = await execute(writeTool, { path: writePath, content: "preview\n" }, harness.ctx);
			assert.equal(readFileSync(writePath, "utf8"), "preview\n");
			const writeComponent = writeTool.renderResult?.(writeResult, { expanded: true }, fakeTheme(), {
				toolCallId: "qualification-write",
				args: { path: writePath, content: "preview\n" },
				state: {},
				isError: false,
				invalidate() {},
			});
			assert.ok(writeComponent?.render(100).length > 0);
			await getCommand(extensions, "code-preview-health").handler("", harness.ctx);
			assert.ok(harness.rendered.some((line) => line.includes("Code preview health")));

			const invalidFetch = await execute(getTool(extensions, "web_fetch"), { url: "ftp://example.com" }, harness.ctx);
			assert.match(textOf(invalidFetch), /Error|invalid|http/iu);
			const invalidBatch = await execute(
				getTool(extensions, "batch_web_fetch"),
				{ requests: [{ url: "ftp://example.com" }] },
				harness.ctx,
			);
			assert.match(textOf(invalidBatch), /error|failed|invalid/iu);

			const bgTool = getTool(extensions, "bg_task");
			const spawned = await execute(
				bgTool,
				{
					action: "spawn",
					command: `${process.execPath} -e "setTimeout(() => {}, 60000)"`,
					cwd: root,
					notifyOnExit: true,
				},
				harness.ctx,
			);
			backgroundPid = spawned.details.task.pid;
			assert.ok(backgroundPid > 0);
			assert.match(textOf(await execute(bgTool, { action: "list" }, harness.ctx)), /running/iu);

			await invokeHandlers(extensions, "session_shutdown", { type: "session_shutdown", reason: "reload" }, harness.ctx);
			await sleep(100);
			await invokeHandlers(
				extensions,
				"session_start",
				{ type: "session_start", reason: "reload", previousSessionFile: harness.sessionFile },
				harness.ctx,
			);
			await invokeHandlers(extensions, "session_shutdown", { type: "session_shutdown", reason: "new" }, harness.ctx);
			await invokeHandlers(
				extensions,
				"session_start",
				{ type: "session_start", reason: "new", previousSessionFile: harness.sessionFile },
				harness.ctx,
			);
			await invokeHandlers(extensions, "session_shutdown", { type: "session_shutdown", reason: "quit" }, harness.ctx);
			await sleep(300);
			assert.throws(() => process.kill(backgroundPid, 0), /ESRCH/u);
			backgroundPid = undefined;
		} finally {
			if (extensions.length > 0 && harness) {
				try {
					await invokeHandlers(
						extensions,
						"session_shutdown",
						{ type: "session_shutdown", reason: "quit" },
						harness.ctx,
					);
				} catch {}
			}
			if (backgroundPid) {
				try {
					process.kill(backgroundPid, "SIGKILL");
				} catch {}
			}
			process.chdir(previousCwd);
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousTasks === undefined) delete process.env.PI_TASKS;
			else process.env.PI_TASKS = previousTasks;
			if (previousVccConfig === undefined) delete process.env.PI_VCC_CONFIG_PATH;
			else process.env.PI_VCC_CONFIG_PATH = previousVccConfig;
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test(
	"release web extensions fetch and search through their exact clients",
	{
		skip: process.env.JOUZU_EXTENSION_NETWORK !== "1",
		timeout: 600_000,
	},
	async () => {
		const root = mkdtempSync(join(tmpdir(), "jouzu-extension-network-"));
		const previousCwd = process.cwd();
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		let extensions = [];
		let harness;
		try {
			process.chdir(root);
			process.env.PI_CODING_AGENT_DIR = join(root, "agent");
			mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
			harness = createHarness(root);
			const status = inspectReleaseExtensions();
			const loaded = await loadExtensions(status.resolvedExtensionPaths, root, createEventBus(), harness.runtime);
			assert.deepEqual(loaded.errors, []);
			extensions = loaded.extensions;
			await invokeHandlers(extensions, "session_start", { type: "session_start", reason: "startup" }, harness.ctx);

			const fetched = await execute(
				getTool(extensions, "web_fetch"),
				{ url: "https://example.com/", format: "markdown", maxChars: 10_000, timeoutMs: 30_000 },
				harness.ctx,
			);
			assert.match(textOf(fetched), /Example Domain/u);

			const batch = await execute(
				getTool(extensions, "batch_web_fetch"),
				{
					requests: [
						{ url: "https://example.com/", format: "markdown", maxChars: 10_000 },
						{ url: "https://www.iana.org/help/example-domains", format: "markdown", maxChars: 20_000 },
					],
				},
				harness.ctx,
			);
			assert.doesNotMatch(textOf(batch), /Unexpected batch_web_fetch failure/u);
			assert.equal(batch.details.batchResult.total, 2);
			assert.equal(batch.details.batchResult.succeeded, 2);
			assert.equal(batch.details.batchResult.failed, 0);

			const browserFetch = await execute(
				getTool(extensions, "tff-fetch_url"),
				{
					url: "https://example.com/",
					render_mode: "static",
					format: "markdown",
					timeout_ms: 60_000,
				},
				harness.ctx,
			);
			assert.equal(browserFetch.details.status, 200);
			assert.match(browserFetch.details.markdown, /Example Domain/u);

			const browserSearch = await execute(
				getTool(extensions, "tff-search_web"),
				{ query: "IANA example domains", max_results: 3, timeout_ms: 60_000 },
				harness.ctx,
			);
			assert.match(textOf(browserSearch), /IANA|Example Domains/iu);
		} finally {
			if (extensions.length > 0 && harness) {
				try {
					await invokeHandlers(
						extensions,
						"session_shutdown",
						{ type: "session_shutdown", reason: "quit" },
						harness.ctx,
					);
				} catch {}
			}
			process.chdir(previousCwd);
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	},
);
