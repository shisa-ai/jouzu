import assert from "node:assert/strict";
import { test } from "node:test";
import { clampThinkingLevel, getCurrentSystemPrompt, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { createAstraCompatibilityExtension, withAstraMetadata } from "../dist/astra-compatibility.js";

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
	const selected = withAstraMetadata(model);
	assert.notEqual(selected, model);
	assert.equal(selected.provider, model.provider);
	assert.deepEqual(getSupportedThinkingLevels(selected), ["low", "medium", "high", "xhigh", "max"]);
	for (const effort of ["off", "minimal"]) assert.equal(clampThinkingLevel(selected, effort), "low");
	assert.equal(selected.contextWindow, model.contextWindow);
	assert.equal(selected.maxTokens, model.maxTokens);
	assert.equal(selected.cost, model.cost);
	assert.equal(selected.reasoning, true);
	assert.equal(selected.compat?.supportsExplicitPromptCacheMode, true);
	assert.equal(selected.samplingParams, undefined);
	assert.equal(model.thinkingLevelMap, undefined);
	const custom = { ...model, baseUrl: "https://custom.example/v1" };
	assert.equal(withAstraMetadata(custom), custom);
});

function astraHarness(registerProvider) {
	const handlers = new Map();
	const registrations = [];
	const pi = {
		on: (event, handler) => handlers.set(event, handler),
		registerProvider: (providerId, config) => {
			registrations.push({ providerId, config });
			registerProvider?.(providerId, config);
		},
		setThinkingLevel: () => {},
	};
	createAstraCompatibilityExtension().factory(pi);
	return { handlers, registrations, pi };
}

async function request(selected, options = {}, simple = true) {
	const bodies = [];
	const sessionModel = withAstraMetadata(selected);
	const handlers = astraHarness().handlers;
	const p = provider([sessionModel]);
	await p[simple ? "streamSimple" : "stream"](sessionModel, context, {
		apiKey: "fixture",
		maxTokens: 2048,
		sessionId: "fixture",
		...options,
		onPayload: async (payload, requestModel) => {
			const chained = (await options.onPayload?.(payload, requestModel)) ?? payload;
			const replaced = handlers.get("before_provider_request")({ payload: chained }, { model: sessionModel });
			return replaced ?? chained;
		},
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

test("registry overlay keeps the contract across provider refresh and auxiliary requests", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const dir = await mkdtemp(join(tmpdir(), "jouzu-astra-overlay-"));
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
		const bodies = [];
		runtime.registerProvider("openai", {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "fixture",
			models: [{ ...model, samplingParams: { temperature: 0.5 } }],
		});
		const { handlers, registrations } = astraHarness((providerId, config) =>
			runtime.registerProvider(providerId, config),
		);
		await handlers.get("session_start")(
			{},
			{
				modelRegistry: runtime,
				sessionManager: { getBranch: () => [] },
				model: undefined,
				thinkingLevel: undefined,
			},
		);
		assert.equal(registrations.length, 1);
		assert.equal(registrations[0].providerId, "openai");
		assert.equal(registrations[0].config.streamSimple, undefined);
		assert.equal(runtime.getRegisteredNativeProvider("openai"), undefined);
		assert.equal(runtime.getRegisteredProviderConfig("openai")?.streamSimple, undefined);
		const adapted = runtime.getModel("openai", model.id);
		assert.deepEqual(getSupportedThinkingLevels(adapted), ["low", "medium", "high", "xhigh", "max"]);
		assert.equal(adapted.compat?.supportsExplicitPromptCacheMode, true);
		assert.equal(adapted.samplingParams, undefined);
		// Auxiliary summaries never run before_provider_request, so the adapted model
		// alone must keep explicit cache disable and drop unsupported sampling.
		await runtime
			.streamSimple(adapted, context, {
				apiKey: "fixture",
				cacheRetention: "none",
				sessionId: "fixture",
				fetch: async (_url, init) => {
					bodies.push(JSON.parse(init.body));
					return new Response(JSON.stringify({ error: { message: "fixture capture complete" } }), {
						status: 400,
						headers: { "content-type": "application/json" },
					});
				},
			})
			.result();
		assert.deepEqual(bodies[0].prompt_cache_options, { mode: "explicit" });
		assert.equal(bodies[0].prompt_cache_key, undefined);
		assert.equal(bodies[0].temperature, undefined);
		// A registry refresh republishes extension models; the contract must survive it.
		await runtime.refresh({ allowNetwork: false });
		assert.equal(runtime.getModel("openai", model.id).thinkingLevelMap?.max, "max");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
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
		const other = {
			...model,
			id: "other",
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
		};
		const probeConfig = {
			api: "openai-completions",
			apiKey: "fixture",
			baseUrl: "https://probe.example/v1",
			models: [
				{
					id: "probe-model",
					name: "probe-model",
					reasoning: false,
					input: ["text"],
					contextWindow: 4096,
					maxTokens: 256,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		};
		let probe;
		const probeExtension = {
			name: "probe",
			factory: (pi) => {
				probe = {
					register: (providerId, config) => pi.registerProvider(providerId, config),
					unregister: (providerId) => pi.unregisterProvider(providerId),
				};
			},
		};
		const delivered = [];
		const bodies = [];
		runtime.registerProvider("openai", {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "fixture",
			models: [model, other],
			streamSimple(selected, context, options) {
				delivered.push(getCurrentSystemPrompt(context.messages));
				return streamSimple(selected, context, {
					...options,
					fetch: async (_url, init) => {
						bodies.push(JSON.parse(init.body));
						return new Response('{"error":{"message":"fixture"}}', {
							status: 400,
							headers: { "content-type": "application/json" },
						});
					},
				});
			},
		});
		const presentation = (await import("../dist/presentation.js")).createJouzuPresentationExtension({}, {});
		// Each session binds its own extension instances, matching Pi's reload-on-replace path.
		const createLoader = async () => {
			const loader = new DefaultResourceLoader({
				cwd: dir,
				agentDir: dir,
				noExtensions: true,
				noSkills: true,
				noContextFiles: true,
				noPromptTemplates: true,
				extensionFactories: [createAstraCompatibilityExtension(), presentation, probeExtension],
			});
			await loader.reload();
			return loader;
		};
		const manager = SessionManager.create(dir, dir);
		const create = async (sessionManager, thinkingLevel) => {
			const created = await createAgentSession({
				cwd: dir,
				agentDir: dir,
				modelRuntime: runtime,
				model: runtime.getModel("openai", model.id),
				thinkingLevel,
				resourceLoader: await createLoader(),
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
		assert.match(delivered[0], /carry authorized work through implementation/);
		assert.equal(session.thinkingLevel, "low");
		assert.equal(runtime.getRegisteredNativeProvider("openai"), undefined);
		assert.equal(
			runtime.getRegisteredProviderConfig("openai")?.models?.find((entry) => entry.id === model.id)?.thinkingLevelMap
				?.max,
			"max",
		);
		assert.equal(runtime.getModel("openai", model.id).thinkingLevelMap?.max, "max");
		assert.equal(bodies.length, 1);
		assert.equal(bodies[0].temperature, undefined);
		assert.deepEqual(bodies[0].prompt_cache_options, { ttl: "30m" });
		assert.equal(bodies[0].reasoning?.effort, "low");
		assert.deepEqual(getSupportedThinkingLevels(session.model), ["low", "medium", "high", "xhigh", "max"]);
		for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
			session.setThinkingLevel(effort);
			assert.equal(session.thinkingLevel, effort);
		}
		// A switch from a max-capable model keeps max because the registry already serves adapted metadata.
		await session.setModel(runtime.getModel("openai", "other"));
		session.setThinkingLevel("max");
		assert.equal(session.thinkingLevel, "max");
		await session.setModel(runtime.getModel("openai", model.id));
		assert.equal(session.thinkingLevel, "max");
		// Re-selecting the active row replaces the model object without model_select.
		await session.setModel(runtime.getModel("openai", model.id));
		assert.equal(session.thinkingLevel, "max");
		assert.deepEqual(getSupportedThinkingLevels(session.model), ["low", "medium", "high", "xhigh", "max"]);
		// A provider register/unregister refresh re-reads the current model from the registry.
		probe.register("probe", probeConfig);
		probe.unregister("probe");
		probe.register("openai", {});
		assert.equal(session.model.thinkingLevelMap?.max, "max");
		assert.equal(session.thinkingLevel, "max");
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
