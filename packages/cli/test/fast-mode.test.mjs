import assert from "node:assert/strict";
import { test } from "node:test";
import { createFastModeExtension, FAST_MODE_STATUS } from "../dist/fast-mode.js";
import { codexMessage, codexTransport } from "./fixtures/codex-transport.mjs";

const model = {
	id: "gpt-6.1-sol",
	name: "Sol",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 8192,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function harness(selected = model) {
	const handlers = new Map(),
		commands = new Map(),
		entries = [],
		statuses = new Map(),
		notices = [];
	const ctx = {
		model: selected,
		mode: "tui",
		sessionManager: { getBranch: () => entries },
		ui: {
			setStatus: (key, value) => (value === undefined ? statuses.delete(key) : statuses.set(key, value)),
			notify: (message, type) => notices.push({ message, type }),
		},
	};
	createFastModeExtension().factory({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
	});
	return {
		ctx,
		entries,
		statuses,
		notices,
		handlers,
		commands,
		command: (args = "") => commands.get("fast").handler(args, ctx),
		payload: (payload, requestModel = ctx.model) =>
			handlers.get("before_provider_request")({ payload, request: { model: requestModel } }, ctx) ?? payload,
	};
}

test("on/off is explicit, idempotent, persisted in the session, and independent of thinking", async () => {
	const h = harness();
	const payload = { model: model.id, reasoning: { effort: "high" }, input: [] };
	assert.equal(h.payload(payload), payload);
	await h.command();
	assert.match(h.notices.at(-1).message, /off/);
	assert.equal(h.entries.length, 0);
	await h.command("on");
	await h.command("on");
	assert.equal(h.entries.length, 1);
	assert.equal(h.statuses.get(FAST_MODE_STATUS), "on");
	assert.deepEqual(h.payload(payload), { ...payload, service_tier: "priority" });
	assert.equal(payload.service_tier, undefined);
	await h.command("off");
	assert.equal(h.statuses.has(FAST_MODE_STATUS), false);
	assert.equal(h.payload({ ...payload, service_tier: "priority" }).service_tier, "default");
	assert.deepEqual(
		h.entries.map((entry) => entry.data.enabled),
		[true, false],
	);
	assert.deepEqual(
		h.commands
			.get("fast")
			.getArgumentCompletions("o")
			.map((entry) => entry.value),
		["on", "off"],
	);
});

test("invalid arguments do not change the choice", async () => {
	const h = harness();
	for (const action of ["toggle", "on off", "yes"]) {
		await h.command(action);
		assert.equal(h.notices.at(-1).type, "warning");
	}
	assert.equal(h.entries.length, 0);
	assert.equal(h.statuses.size, 0);
});

test("an ineligible selection can save Fast mode for the next eligible request", async () => {
	const unsupported = { ...model, id: "claude-sonnet", api: "anthropic-messages" };
	const h = harness(unsupported);
	const payload = { input: [] };
	await h.command("on");
	assert.match(h.notices.at(-1).message, /inactive/);
	assert.equal(h.statuses.has(FAST_MODE_STATUS), false);
	assert.equal(h.payload(payload), payload);
	assert.equal(h.payload(payload, model).service_tier, "priority");
	await h.command("off");
	assert.equal(h.payload(payload, model).service_tier, "default");
});

test("resume, branch navigation, model switches, and shutdown restore the indicator", async () => {
	const h = harness();
	await h.command("on");
	const enabled = structuredClone(h.entries);
	await h.command("off");
	h.entries.splice(0, h.entries.length, ...enabled);
	await h.handlers.get("session_tree")({}, h.ctx);
	assert.equal(h.statuses.get(FAST_MODE_STATUS), "on");
	h.ctx.model = { ...model, id: "claude-sonnet", api: "anthropic-messages" };
	await h.handlers.get("model_select")({}, h.ctx);
	assert.equal(h.statuses.has(FAST_MODE_STATUS), false);
	await h.command();
	assert.match(h.notices.at(-1).message, /inactive/);
	h.ctx.model = model;
	await h.handlers.get("model_select")({}, h.ctx);
	assert.equal(h.statuses.get(FAST_MODE_STATUS), "on");
	await h.handlers.get("session_shutdown")({}, h.ctx);
	assert.equal(h.statuses.size, 0);
	await h.handlers.get("session_start")({}, h.ctx);
	assert.equal(h.statuses.get(FAST_MODE_STATUS), "on");
	h.entries.length = 0;
	await h.handlers.get("session_start")({}, h.ctx);
	assert.equal(h.statuses.size, 0);
});

test("only eligible prepared requests change, including gateway routes and routed model switches", async () => {
	const h = harness();
	await h.command("on");
	const payload = { model: model.id, input: [] };
	for (const api of ["openai-responses", "openai-codex-responses"]) {
		assert.equal(h.payload(payload, { ...model, api, provider: "catalog:example:codex" }).service_tier, "priority");
	}
	for (const selected of [
		{ ...model, api: "anthropic-messages" },
		{ ...model, id: "glm-5" },
	]) {
		assert.equal(h.payload(payload, selected), payload);
	}
	assert.equal(h.handlers.get("before_provider_request")({ payload }, h.ctx), undefined);
	for (const invalid of [null, "payload", []]) assert.equal(h.payload(invalid), invalid);
	h.ctx.model = { ...model, id: "router", api: "virtual" };
	assert.equal(h.payload(payload, model).service_tier, "priority");
});

for (const transport of ["sse", "websocket"]) {
	test(`Codex ${transport} sends priority then default across requests`, async (t) => {
		const h = harness();
		const fixture = codexTransport(t, { transport });
		for (const [action, tier] of [
			["on", "priority"],
			["off", "default"],
		]) {
			await h.command(action);
			const result = await fixture
				.stream(
					model,
					{
						messages: [{ role: "user", content: "Hello", timestamp: 1 }],
					},
					{ onPayload: (payload, selected) => h.payload(payload, selected) },
				)
				.result();
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(fixture.requests.at(-1).body.service_tier, tier);
			assert.equal(fixture.requests.at(-1).transport, transport);
		}
	});
}

test("busy Fast mode commands apply to the next OpenAI request and survive reload", async (t) => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-responses");
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const root = await mkdtemp(join(tmpdir(), "jouzu-fast-"));
	let session;
	t.after(async () => {
		session?.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const runtime = await ModelRuntime.create({
		credentials: {
			read: async () => undefined,
			list: async () => [],
			modify: async () => undefined,
			delete: async () => {},
		},
		modelsPath: null,
		modelsStorePath: join(root, "models.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const bodies = [];
	const firstRequest = Promise.withResolvers();
	const releaseFirstRequest = Promise.withResolvers();
	const selected = { ...model, provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
	runtime.registerProvider("openai", {
		api: selected.api,
		baseUrl: selected.baseUrl,
		apiKey: "sk-fixture",
		models: [selected],
		streamSimple(requestModel, context, options) {
			return streamSimple(requestModel, context, {
				...options,
				fetch: async (_url, init) => {
					bodies.push(JSON.parse(init.body));
					const index = bodies.length;
					let item = codexMessage(`msg_${index}`);
					if (index === 1) {
						firstRequest.resolve();
						await releaseFirstRequest.promise;
						item = {
							type: "function_call",
							id: "fc_step",
							call_id: "call_step",
							name: "step",
							arguments: "{}",
							status: "completed",
						};
					}
					const events = [
						{ type: "response.output_item.done", output_index: 0, item },
						{ type: "response.completed", response: { id: `response_${index}`, status: "completed", output: [item] } },
					];
					return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
						headers: { "content-type": "text/event-stream" },
					});
				},
			});
		},
	});
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		extensionFactories: [
			createFastModeExtension(),
			(pi) => {
				pi.registerTool({
					name: "step",
					label: "Step",
					description: "Return a fixture result.",
					parameters: { type: "object", properties: {} },
					async execute() {
						return { content: [{ type: "text", text: "Step done" }], details: {} };
					},
				});
			},
		],
	});
	await loader.reload();
	({ session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		modelRuntime: runtime,
		model: runtime.getModel("openai", model.id),
		resourceLoader: loader,
		tools: [],
		sessionManager: SessionManager.create(root, root),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
	}));
	await session.bindExtensions({
		mode: "rpc",
		onError: (error) => {
			throw error;
		},
	});
	await session.prompt("/fast off");
	assert.equal(bodies.length, 0);
	const active = session.prompt("Hello");
	try {
		await Promise.race([firstRequest.promise, active]);
		assert.equal(session.isIdle, false);
		for (const action of ["on", "off", "on"]) await session.prompt(`/fast ${action}`);
		assert.deepEqual(
			bodies.map((body) => body.service_tier),
			["default"],
		);
	} finally {
		releaseFirstRequest.resolve();
		await active;
	}
	assert.deepEqual(
		bodies.map((body) => body.service_tier),
		["default", "priority"],
	);
	assert.ok(bodies[1].input.some((item) => item.type === "function_call_output" && item.call_id === "call_step"));
	await session.reload();
	await session.prompt("Again");
	assert.equal(bodies.at(-1).service_tier, "priority");
	await session.prompt("/fast off");
	await session.prompt("Standard");
	assert.equal(bodies.at(-1).service_tier, "default");
});
