import assert from "node:assert/strict";
import { test } from "node:test";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { withAstraCompatibility, withAstraMetadata } from "../dist/astra-compatibility.js";

const model = {
	id: "gpt-6-astra",
	name: "Account Astra",
	provider: "openai",
	api: "openai-responses",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 400000,
	maxTokens: 12000,
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
};
const provider = (models = [model]) => ({
	id: "openai",
	name: "Account provider",
	auth: { apiKey: {} },
	getModels: () => models,
	stream,
	streamSimple,
});
const context = { messages: [{ role: "user", content: "Hello", timestamp: 1 }] };

test("metadata-free entries expose five efforts and preserve account limits and provider ownership", () => {
	const base = provider();
	const wrapped = withAstraCompatibility(base);
	assert.equal(wrapped.auth, base.auth);
	assert.equal(wrapped.name, base.name);
	const selected = wrapped.getModels()[0];
	assert.equal(wrapped.getModels()[0], selected);
	assert.deepEqual(getSupportedThinkingLevels(selected), ["low", "medium", "high", "xhigh", "max"]);
	for (const effort of ["off", "minimal"]) assert.equal(clampThinkingLevel(selected, effort), "low");
	assert.equal(selected.contextWindow, model.contextWindow);
	assert.equal(selected.maxTokens, model.maxTokens);
	assert.equal(selected.cost, model.cost);
	assert.equal(model.thinkingLevelMap, undefined);
	assert.equal(withAstraCompatibility(provider([])).getModels().length, 0);
});

async function request(selected, options = {}, simple = true) {
	const bodies = [];
	const p = withAstraCompatibility(provider([selected]));
	await p[simple ? "streamSimple" : "stream"](selected, context, {
		apiKey: "fixture",
		maxTokens: 2048,
		...options,
		fetch: async (_url, init) => {
			bodies.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ error: { message: "fixture capture complete" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			});
		},
	}).result();
	assert.equal(bodies.length, 1);
	return bodies[0];
}

test("Pi serialization transmits all five efforts unchanged and repairs disabled effort", async () => {
	for (const reasoning of ["low", "medium", "high", "xhigh", "max", undefined, "minimal"]) {
		const body = await request(model, { reasoning });
		assert.equal(body.reasoning.effort, reasoning === undefined || reasoning === "minimal" ? "low" : reasoning);
		assert.equal(body.max_output_tokens, 2048);
		assert.deepEqual(body.prompt_cache_options, { ttl: "30m" });
		assert.equal(body.prompt_cache_retention, undefined);
	}
});

test("final transmitted body is normalized after sampling and subsequent extension transforms", async () => {
	const body = await request(model, {
		reasoning: "high",
		temperature: 0.7,
		samplingParams: { top_p: 0.9, top_logprobs: 3, logprobs: true },
		onPayload(payload) {
			return {
				...payload,
				temperature: 1,
				reasoning: { effort: "none", summary: "concise" },
				include: ["reasoning.encrypted_content", "message.output_text.logprobs"],
				prompt_cache_retention: "24h",
			};
		},
	});
	for (const key of ["temperature", "top_p", "top_logprobs", "logprobs", "prompt_cache_retention"])
		assert.equal(body[key], undefined);
	assert.deepEqual(body.reasoning, { effort: "low", summary: "concise" });
	assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
	assert.deepEqual(body.prompt_cache_options, { ttl: "30m" });
});

test("cache disable and auxiliary complete requests preserve explicit settings", async () => {
	const disabled = await request(model, { cacheRetention: "none", sessionId: "fixture" });
	assert.deepEqual(disabled.prompt_cache_options, { mode: "explicit" });
	assert.equal(disabled.prompt_cache_key, undefined);
	const auxiliary = await request(model, { reasoningEffort: "max", cacheRetention: "long" }, false);
	assert.equal(auxiliary.reasoning.effort, "max");
	assert.deepEqual(auxiliary.prompt_cache_options, { ttl: "30m" });
});

test("custom endpoints, provider aliases, and Codex retain their metadata and payload settings", async () => {
	for (const overrides of [
		{ baseUrl: "https://custom.example/v1" },
		{ provider: "custom" },
		{ api: "openai-codex-responses" },
		{ id: "gpt-6-astra-preview" },
	])
		assert.equal(withAstraMetadata({ ...model, ...overrides }).thinkingLevelMap, undefined);
	const custom = await request(
		{ ...model, baseUrl: "https://custom.example/v1" },
		{ temperature: 0.8, cacheRetention: "long" },
	);
	assert.equal(custom.temperature, 0.8);
	assert.equal(custom.prompt_cache_retention, "24h");
	assert.equal(custom.prompt_cache_options, undefined);
});

test("registered extension normalizes startup, switches, and restored session effort", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const { createAstraCompatibilityExtension } = await import("../dist/astra-compatibility.js");
	const dir = await mkdtemp(join(tmpdir(), "jouzu-astra-session-"));
	let session;
	try {
		const runtime = await ModelRuntime.create({
			credentials: {
				read: async () => undefined,
				list: async () => [],
				modify: async () => undefined,
				delete: async () => {},
			},
			modelsPath: null,
			modelsStorePath: join(dir, "models.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const other = { ...model, id: "other" };
		const delivered = [];
		runtime.registerProvider("openai", {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "fixture",
			models: [model, other],
			streamSimple(selected, context, options) {
				delivered.push(context.systemPrompt);
				return streamSimple(selected, context, {
					...options,
					fetch: async () =>
						new Response('{"error":{"message":"fixture"}}', {
							status: 400,
							headers: { "content-type": "application/json" },
						}),
				});
			},
		});
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			noExtensions: true,
			noSkills: true,
			noContextFiles: true,
			noPromptTemplates: true,
			extensionFactories: [
				createAstraCompatibilityExtension(),
				(await import("../dist/presentation.js")).createJouzuPresentationExtension({}, {}),
			],
		});
		await loader.reload();
		const manager = SessionManager.create(dir, dir);
		const create = async (sessionManager, thinkingLevel) => {
			const created = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				modelRuntime: runtime,
				model: runtime.getModel("openai", model.id),
				thinkingLevel,
				resourceLoader: loader,
				sessionManager,
				settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
				tools: [],
			});
			session = created.session;
			await session.bindExtensions({
				mode: "rpc",
				onError: (error) => {
					throw error;
				},
			});
		};
		await create(manager, "off");
		await session.prompt("Can you finish the assigned edit?");
		assert.match(delivered[0], /Carry authorized work through implementation/);
		assert.equal(session.thinkingLevel, "low");
		assert.deepEqual(getSupportedThinkingLevels(session.model), ["low", "medium", "high", "xhigh", "max"]);
		for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
			session.setThinkingLevel(effort);
			assert.equal(session.thinkingLevel, effort);
		}
		await session.setModel(runtime.getModel("openai", "other"));
		session.setThinkingLevel("off");
		await session.setModel(runtime.getModel("openai", model.id));
		session.setThinkingLevel("minimal");
		assert.equal(session.thinkingLevel, "low");
		session.setThinkingLevel("max");
		// Persist a conversation before reopening, as Pi does on the first response.
		manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Done" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			timestamp: 2,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const path = manager.getSessionFile();
		session.dispose();
		session = undefined;
		await create(SessionManager.open(path, dir, dir), undefined);
		assert.equal(session.thinkingLevel, "max");
	} finally {
		session?.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});
