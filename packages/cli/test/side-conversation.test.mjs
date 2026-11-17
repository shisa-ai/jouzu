import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { resolveCatalog } from "../dist/locale-catalog.js";
import { captureSideContext, prepareSideContext, sideContextFor } from "../dist/side-context.js";
import { createSideConversationExtension, SideConversationComponent } from "../dist/side-conversation.js";
import { SubagentManager } from "../dist/subagents/manager.js";
import { defaultAgentConfig } from "../dist/subagents/roles.js";
import { fixture } from "./fixtures/flow-session-ingress.mjs";

test("side context is admitted-only, text-only, immutable and bound to its branch and destination", () => {
	const branch = [{ id: "a" }];
	const session = {
		sessionId: "parent",
		sessionManager: { getLeafId: () => branch.at(-1)?.id, getBranch: () => branch },
	};
	const model = { provider: "fixture", id: "model", api: "openai-completions", baseUrl: "http://localhost/v1" };
	assert.equal(sideContextFor(session, model), undefined);
	const messages = [
		{
			role: "user",
			content: [
				{ type: "text", text: "ADMITTED" },
				{ type: "image", data: "SECRET_IMAGE" },
			],
		},
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "SECRET_THINKING" },
				{ type: "text", text: "Evidence" },
			],
		},
	];
	captureSideContext(session, model, messages);
	messages[0].content[0].text = "MUTATED";
	const snapshot = sideContextFor(session, model);
	assert.match(snapshot.text, /ADMITTED|Evidence/);
	assert.doesNotMatch(snapshot.text, /SECRET|MUTATED/);
	branch.push({ id: "b" });
	assert.ok(sideContextFor(session, model));
	assert.equal(sideContextFor(session, { ...model, baseUrl: "http://other/v1" }), undefined);
	branch.splice(0, branch.length, { id: "other" });
	assert.equal(sideContextFor(session, model), undefined);
});

test("side context prepares saved history before any main request and fails closed", async () => {
	let leaf = "saved";
	const messages = [
		{ role: "user", content: "SAVED_HISTORY", timestamp: 1 },
		{ role: "compactionSummary", summary: "SAVED_SUMMARY", tokensBefore: 100, timestamp: 2 },
	];
	const session = {
		sessionId: "resumed-side",
		sessionManager: {
			getLeafId: () => leaf,
			getBranch: () => [{ id: leaf }],
			buildSessionProjection: () => ({ messages }),
		},
	};
	const model = { provider: "fixture", id: "model", api: "openai-completions", baseUrl: "http://localhost" };
	assert.equal(sideContextFor(session, model), undefined);
	const result = await prepareSideContext(session, model, async (id, input) => {
		assert.equal(id, session.sessionId);
		assert.equal(input[0].content, "SAVED_HISTORY");
		input[0].content = "FILTERED_HISTORY";
		return input;
	});
	assert.match(result.text, /FILTERED_HISTORY/);
	assert.match(result.text, /SAVED_SUMMARY/);
	assert.doesNotMatch(result.text, /SAVED_HISTORY/);
	assert.equal(messages[0].content, "SAVED_HISTORY");
	await assert.rejects(
		prepareSideContext(session, model, async () => {
			throw new Error("policy failed");
		}),
		/policy failed/,
	);
	await assert.rejects(
		prepareSideContext(session, model, async () => {
			leaf = "other";
			return [];
		}),
		/branch changed/,
	);
});

test("user-only child results never create parent completion records or callbacks", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-side-delivery-"));
	const cwd = join(root, "workspace");
	mkdirSync(cwd);
	let emit, exit;
	const callbacks = [];
	const manager = new SubagentManager(
		{ stateDir: join(root, "state") },
		"parent",
		1,
		(_launch, send, done) => {
			emit = send;
			exit = done;
			return {
				send() {},
				async stop() {
					exit(false);
				},
			};
		},
		(run) => callbacks.push(run),
	);
	try {
		const role = { ...defaultAgentConfig().roles.find((r) => r.id === "coder"), tools: [] };
		const run = manager.launch({
			purpose: "side-conversation",
			role,
			model: { provider: "fixture", id: "model" },
			auth: {},
			cwd,
			task: "Question",
		});
		emit({ type: "result", status: "completed", text: "Answer" });
		exit(true);
		assert.equal(manager.get(run.id).purpose, "side-conversation");
		assert.equal(manager.get(run.id).completion, undefined);
		assert.deepEqual(callbacks, []);
		const restored = new SubagentManager({ stateDir: join(root, "state") }, "parent", 1);
		assert.equal(restored.get(run.id).completion, undefined);
		await restored.dispose();
	} finally {
		await manager.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

async function waitForRun(manager, id) {
	const run = manager.get(id);
	if (!["queued", "starting", "running"].includes(run.status)) return run;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error("Side worker did not finish"));
		}, 45000);
		const off = manager.subscribe(() => {
			const next = manager.get(id);
			if (["queued", "starting", "running"].includes(next.status)) return;
			clearTimeout(timer);
			off();
			resolve(next);
		});
	});
}

test("real side workers have no tools or project resources and resume only side Q&A with fresh references", {
	timeout: 120000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-side-worker-"));
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	writeFileSync(join(workspace, "AGENTS.md"), "RAW_PROJECT_SECRET");
	const requests = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = JSON.parse(Buffer.concat(chunks).toString());
		requests.push(body);
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		res.end(
			`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: `Side answer ${requests.length}` }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\ndata: [DONE]\n\n`,
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const model = {
		id: "fixture",
		name: "Fixture",
		provider: "fixture",
		api: "openai-completions",
		baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 256,
	};
	const callbacks = [];
	const manager = new SubagentManager({ stateDir: join(root, "state") }, "parent", 1, undefined, (run) =>
		callbacks.push(run),
	);
	const role = {
		...defaultAgentConfig().roles[1],
		tools: ["bash", "write"],
		thinking: "off",
		maxTurns: 1,
		timeoutSeconds: 45,
	};
	const context = {
		sessionId: "parent",
		entryId: "entry",
		destination: "same-endpoint",
		capturedAt: new Date().toISOString(),
		text: "FIRST_REFERENCE",
		truncated: false,
	};
	const launch = {
		purpose: "side-conversation",
		sideContext: context,
		role,
		model,
		auth: { apiKey: "fixture" },
		cwd: workspace,
		task: "First side question",
	};
	try {
		const first = await waitForRun(manager, manager.launch(launch).id);
		assert.equal(first.status, "completed", first.result);
		const second = await waitForRun(
			manager,
			manager.launch(
				{ ...launch, task: "Second side question", sideContext: { ...context, text: "SECOND_REFERENCE" } },
				undefined,
				first.id,
			).id,
		);
		assert.equal(second.status, "completed", second.result);
		assert.equal(second.sessionFile, first.sessionFile);
		assert.deepEqual(callbacks, []);
		assert.equal(second.completion, undefined);
		assert.ok(second.usage.input > 0);
		for (const body of requests) {
			assert.equal(body.tools?.length ?? 0, 0);
			assert.doesNotMatch(JSON.stringify(body), /RAW_PROJECT_SECRET|parent_context|TaskCreate|schedule_prompt/);
		}
		assert.match(JSON.stringify(requests[0]), /FIRST_REFERENCE/);
		assert.match(JSON.stringify(requests[1]), /SECOND_REFERENCE/);
		assert.match(JSON.stringify(requests[1]), /First side question/);
		assert.match(JSON.stringify(requests[1]), /Side answer 1/);
		assert.doesNotMatch(JSON.stringify(requests[1]), /FIRST_REFERENCE/);
		assert.match(readFileSync(second.sessionFile, "utf8"), /context_edit/);
	} finally {
		await manager.dispose();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		rmSync(root, { recursive: true, force: true });
	}
});

test("filtered exports follow final context transforms, not raw transcript or changed provider payloads", async (t) => {
	let redact = false;
	const f = await fixture(t, {
		provider: true,
		extensions: [
			{
				name: "redact",
				factory(pi) {
					pi.on("context", (event) => ({
						messages: event.messages.map((message) =>
							redact && message.role === "user" && JSON.stringify(message.content).includes("RAW_SECRET")
								? { ...message, content: "ADMITTED_ONLY" }
								: message,
						),
					}));
				},
			},
		],
	});
	await f.session.prompt("RAW_SECRET");
	redact = true;
	await f.session.prompt("Current question");
	const snapshot = sideContextFor(f.session, f.session.model);
	assert.ok(snapshot, JSON.stringify({ model: f.session.model, sent: f.sent, state: f.session.agent.state }));
	assert.match(snapshot.text, /ADMITTED_ONLY/);
	assert.doesNotMatch(snapshot.text, /RAW_SECRET/);
	const changed = await fixture(t, {
		provider: true,
		extensions: [
			{
				name: "payload-redact",
				factory(pi) {
					pi.on("before_provider_request", () => ({ messages: [{ role: "user", content: "PAYLOAD_ONLY" }] }));
				},
			},
		],
	});
	await changed.session.prompt("RAW_SECRET");
	assert.equal(sideContextFor(changed.session, changed.session.model), undefined);
	await f.ingress.suspend();
	assert.equal(sideContextFor(f.session, f.session.model), undefined, "flow off withdraws the snapshot");
});

test("first-party side handoff uses scoped user receipts and rejects other inline identities", async (t) => {
	const f = await fixture(t);
	const bindingHost = f.session._flowBinding;
	const adapter = await bindingHost.registerUserInputAdapter("<inline:jouzu-side-conversation>", {
		id: "jouzu-btw",
		label: "Side conversation",
	});
	const binding = await adapter.bind();
	const receipt = await adapter.submit({
		binding,
		messageId: "side-input",
		text: "User instruction",
		deliverAs: "followUp",
	});
	assert.ok(["retained", "queued", "consumed", "held"].includes(receipt.state));
	assert.equal((await adapter.lookup({ target: binding.target, messageId: "side-input" })).messageId, "side-input");
	await assert.rejects(bindingHost.registerUserInputAdapter("<inline:other>", { id: "jouzu-btw", label: "Other" }), {
		code: "unauthorized",
	});
});

test("side panel keeps text keys in Pi input and actions reachable with rebound selection keys", async () => {
	for (const locale of ["en", "ja"]) {
		const sent = [],
			stopped = [];
		const keys = {
			"tui.select.confirm": ["CONFIRM"],
			"tui.input.submit": ["SUBMIT"],
			"tui.select.cancel": ["CANCEL"],
			"tui.select.up": ["UP"],
			"tui.select.down": ["DOWN"],
			"tui.select.pageUp": ["PAGEUP"],
			"tui.select.pageDown": ["PAGEDOWN"],
		};
		const component = new SideConversationComponent(
			{
				catalog: resolveCatalog(locale).bundle,
				tui: { terminal: { rows: 40 }, requestRender() {} },
				theme: { bold: (text) => text, fg: (_role, text) => text, bg: (_role, text) => text },
				keybindings: {
					matches: (data, action) => keys[action]?.includes(data),
					getKeys: (action) => keys[action] ?? [],
				},
				close() {
					stopped.push("closed");
				},
			},
			{
				async ask(text) {
					sent.push(text);
				},
				bring() {},
				async send() {},
				async stop() {
					stopped.push("stop");
				},
				fresh() {},
				runs: () => [],
				subscribe: () => () => {},
			},
		);
		component.focused = true;
		component.handleInput("CONFIRM");
		component.handleInput("s n 日本語");
		assert.deepEqual(stopped, []);
		component.handleInput("SUBMIT");
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(sent, ["s n 日本語"]);
		for (const width of [24, 48, 80]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
		component.handleInput("CANCEL");
		assert.deepEqual(stopped, ["closed"]);
		component.dispose();
	}
});

test("/btw registers for user commands only, preserves drafts, and reports noninteractive mode without launching", async () => {
	const commands = new Map(),
		handlers = new Map(),
		runs = [],
		asks = [],
		drafts = [],
		notices = [];
	let component;
	const modelRun = {
		id: "side",
		parentSessionId: "parent",
		role: { id: "side" },
		task: "Side question",
		status: "completed",
		result: "Side answer",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: null },
		model: { id: "fixture" },
	};
	const service = {
		sideRuns: () => runs,
		sessionId: () => "parent",
		subscribe: () => () => {},
		async askSide(text) {
			asks.push(text);
			runs.push(modelRun);
			return modelRun;
		},
	};
	const pi = {
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, command) => commands.set(name, command),
	};
	createSideConversationExtension(service).factory(pi);
	const keys = {
		"tui.select.confirm": ["CONFIRM"],
		"tui.input.submit": ["SUBMIT"],
		"tui.select.cancel": ["CANCEL"],
		"tui.select.up": ["UP"],
		"tui.select.down": ["DOWN"],
	};
	const ctx = {
		mode: "tui",
		sessionManager: { getSessionId: () => "parent" },
		ui: {
			notify: (...args) => notices.push(args),
			getEditorText: () => "EXISTING_DRAFT",
			pasteToEditor: (text) => drafts.push(text),
			async custom(factory) {
				component = factory(
					{ terminal: { rows: 40 }, requestRender() {} },
					{ bold: (s) => s, fg: (_role, s) => s, bg: (_role, s) => s },
					{ matches: (data, action) => keys[action]?.includes(data), getKeys: (action) => keys[action] ?? [] },
					() => {},
				);
				component.handleInput("DOWN");
				component.handleInput("CONFIRM");
			},
		},
	};
	handlers.get("session_start")({}, ctx);
	await commands.get("btw").handler("Side question", ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(asks, ["Side question"]);
	assert.ok(drafts[0], JSON.stringify(notices));
	assert.match(drafts[0], /Side conversation evidence.*\nQuestion: Side question\nAnswer: Side answer/);
	assert.ok(drafts[0].startsWith("\n\n"));
	component.dispose();
	await commands.get("btw").handler("Do not launch", { ...ctx, mode: "rpc" });
	assert.equal(asks.length, 1);
	assert.match(notices.at(-1)[0], /interactive terminal/);
});

test("opening /btw does not take main automatic-work priority or release an existing pause", async (t) => {
	const f = await fixture(t);
	f.ingress.pauseAutomated("Keep main paused");
	let sawPriority;
	await f.ingress.runCommand({ args: ["/btw"], version: 1 }, async () => {
		sawPriority = f.ingress.activeUserInput;
	});
	assert.equal(sawPriority, 0);
	assert.equal(f.ingress.automatedPause(), "Keep main paused");
});

test("side controls remain within a short terminal and keep selection visible", () => {
	for (const locale of ["en", "ja"]) {
		const component = new SideConversationComponent(
			{
				catalog: resolveCatalog(locale).bundle,
				tui: { terminal: { rows: 12 }, requestRender() {} },
				theme: { bold: (text) => text, fg: (_role, text) => text, bg: (_role, text) => text },
				keybindings: { matches: (data, action) => data === action, getKeys: () => ["enter"] },
				close() {},
			},
			{
				async ask() {},
				bring() {},
				async send() {},
				async stop() {},
				fresh() {},
				runs: () => [],
				subscribe: () => () => {},
			},
		);
		for (let index = 0; index < 7; index++) {
			const lines = component.render(24);
			assert.ok(lines.length <= 10, `${locale}: ${lines.join("\n")}`);
			assert.ok(lines.every((line) => visibleWidth(line) <= 24));
			assert.ok(lines.some((line) => line.includes("→")));
			component.handleInput("tui.select.down");
		}
		component.dispose();
	}
});

test("first-party handoff identity is supplied by the actual inline loader", async (t) => {
	let adapter;
	const f = await fixture(t, {
		extensions: [
			{
				name: "jouzu-side-conversation",
				factory(pi) {
					pi.on("session_start", async () => {
						adapter = await pi.registerUserInputAdapter({ id: "jouzu-btw", label: "Side" });
					});
				},
			},
		],
	});
	await f.session.bindExtensions({ mode: "print" });
	assert.ok(adapter);
	const binding = await adapter.bind();
	const receipt = await adapter.submit({
		binding,
		messageId: "from-loader",
		text: "Actual user instruction",
		deliverAs: "steer",
	});
	assert.ok(["retained", "queued", "consumed", "held"].includes(receipt.state));
});
