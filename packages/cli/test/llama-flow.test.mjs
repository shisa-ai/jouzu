import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { classicHostBuiltinOverrides } from "../dist/classic-host-policy.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { PiNativeRequests } from "../dist/flow-control/pi-native-requests.js";
import { preparePiProviderRoute } from "../dist/flow-control/pi-provider-route.js";
import { afterCleanup } from "./fixtures/cleanup.mjs";

const upstream = (
	await import(new URL("./extensions/llama/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")))
).default;

async function fixture(t, { overlay = false, raw = false } = {}) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-llama-flow-"));
	afterCleanup(t, () => rm(root, { recursive: true, force: true }));
	const requests = [];
	const server = createServer(async (request, response) => {
		if (request.url === "/models") {
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({ data: [{ id: "fixture", status: { value: "loaded", args: ["--ctx-size", "16384"] } }] }),
			);
			return;
		}
		if (request.url.startsWith("/props")) {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ chat_template: "enable_thinking" }));
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk;
		requests.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(
			'data: {"id":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	afterCleanup(
		t,
		() =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(resolve);
			}),
	);
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	await writeFile(
		join(root, "auth.json"),
		JSON.stringify({ "llama.cpp": { type: "api_key", key: "fixture-key", env: { LLAMA_BASE_URL: baseUrl } } }),
	);
	if (overlay)
		await writeFile(
			join(root, "models.json"),
			JSON.stringify({ providers: { "llama.cpp": { modelOverrides: { fixture: { contextWindow: 8192 } } } } }),
		);
	const runtime = await ModelRuntime.create({
		modelsPath: join(root, "models.json"),
		authPath: join(root, "auth.json"),
		refreshOnCreate: false,
	});
	// Provider registration starts a cache refresh without returning its promise.
	// Join every refresh before deleting files that its credential checks can write.
	const refreshes = new Set();
	const refresh = runtime.refresh.bind(runtime);
	runtime.refresh = (...args) => {
		const pending = refresh(...args);
		refreshes.add(pending);
		pending.then(
			() => refreshes.delete(pending),
			() => refreshes.delete(pending),
		);
		return pending;
	};
	afterCleanup(t, async () => {
		while (refreshes.size) await Promise.all([...refreshes]);
	});
	const extension = classicHostBuiltinOverrides().find((entry) => entry.name === "llama.cpp");
	if (!raw) assert.ok(extension, "Jouzu must install its bundled llama.cpp adapter");
	const commands = new Map();
	await (raw ? upstream : extension.factory)({
		registerProvider(provider) {
			runtime.registerNativeProvider(provider);
		},
		registerCommand(name, command) {
			commands.set(name, command);
		},
	});
	// Join the registration's cache-only refresh before requesting the live catalog.
	await runtime.refresh({ providers: ["llama.cpp"], allowNetwork: false });
	const refreshed = await runtime.refresh({
		providers: ["llama.cpp"],
		allowNetwork: true,
		signal: AbortSignal.timeout(5000),
	});
	assert.equal(refreshed.errors.size, 0);
	const model = runtime.getModel("llama.cpp", "fixture");
	assert.ok(model);
	return {
		root,
		runtime,
		model,
		requests,
		commands,
		context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
	};
}

test("bundled llama.cpp discovery and guarded inference retain auth, compatibility and payload admission", async (t) => {
	const f = await fixture(t);
	assert.ok(f.commands.has("llama"));
	assert.equal(f.model.contextWindow, 16384);
	assert.equal(f.model.compat.thinkingFormat, "qwen-chat-template");
	assert.equal(f.model.baseUrl.startsWith("http://127.0.0.1:"), true);
	let admitted = 0;
	const result = await f.runtime
		.streamSimple(f.model, f.context, {
			flowValidateProvider: preparePiProviderRoute(f.runtime, f.model, () => {}),
			maxTokens: 32,
			reasoning: "medium",
			transformHeaders: (headers) => ({ ...headers, "x-fixture": "prepared" }),
			onPayload: (payload) => {
				admitted++;
				return { ...payload, temperature: 0.25 };
			},
		})
		.result();
	assert.notEqual(result.stopReason, "error", result.errorMessage);
	assert.equal(admitted, 1);
	assert.equal(f.requests.length, 1);
	assert.equal(f.requests[0].url, "/v1/chat/completions");
	assert.equal(f.requests[0].headers.authorization, "Bearer fixture-key");
	assert.equal(f.requests[0].headers["x-fixture"], "prepared");
	assert.equal(f.requests[0].body.temperature, 0.25);
});

for (const phase of ["initial", "auth", "headers"]) {
	for (const replacement of phase === "initial"
		? ["stream", "streamSimple", "provider", "api"]
		: ["stream", "streamSimple", "provider"]) {
		test(`bundled llama.cpp rejects ${replacement} replacement during ${phase}`, async (t) => {
			const f = await fixture(t);
			let invoked = 0;
			const invalid = () => {
				invoked++;
				throw Error("must not dispatch");
			};
			const replace = () => {
				const native = f.runtime.getRegisteredNativeProvider("llama.cpp");
				if (replacement === "provider")
					f.runtime.registerNativeProvider({ ...native, stream: invalid, streamSimple: invalid });
				else if (replacement === "api") f.model.api = "anthropic-messages";
				else native[replacement] = invalid;
			};
			if (phase === "initial") {
				replace();
				assert.throws(() => preparePiProviderRoute(f.runtime, f.model, () => {}), /unsupported request handler/);
			} else {
				const guard = preparePiProviderRoute(f.runtime, f.model, () => {});
				if (phase === "auth") {
					const getAuth = f.runtime.getAuth.bind(f.runtime);
					f.runtime.getAuth = async (...args) => {
						const result = await getAuth(...args);
						replace();
						return result;
					};
				}
				const result = await f.runtime
					.streamSimple(f.model, f.context, {
						flowValidateProvider: guard,
						transformHeaders: (headers) => {
							if (phase === "headers") replace();
							return headers;
						},
					})
					.result();
				assert.equal(result.stopReason, "error");
				assert.match(result.errorMessage, /unsupported request handler/);
			}
			assert.equal(invoked, 0);
			assert.equal(f.requests.length, 0);
		});
	}
}

test("an upstream native provider is not qualified by its llama.cpp name", async (t) => {
	const f = await fixture(t, { raw: true });
	assert.throws(() => preparePiProviderRoute(f.runtime, f.model, () => {}), /unsupported request handler/);
	assert.equal(f.requests.length, 0);
});

for (const scenario of ["overlay", "clamp", "refresh"]) {
	test(`bundled llama.cpp keeps qualification through ${scenario}`, async (t) => {
		const f = await fixture(t, { overlay: scenario === "overlay" });
		if (scenario === "clamp") {
			const native = f.runtime.getRegisteredNativeProvider("llama.cpp");
			f.runtime.registerNativeProvider({
				...native,
				getModels: () => native.getModels().map((model) => ({ ...model, contextWindow: 8192 })),
			});
		}
		await f.runtime.refresh({ providers: ["llama.cpp"], allowNetwork: true, signal: AbortSignal.timeout(5000) });
		const model = f.runtime.getModel("llama.cpp", "fixture");
		assert.equal(model.contextWindow, scenario === "refresh" ? 16384 : 8192);
		const response = await f.runtime
			.streamSimple(model, f.context, { flowValidateProvider: preparePiProviderRoute(f.runtime, model, () => {}) })
			.result();
		assert.notEqual(response.stopReason, "error", response.errorMessage);
		assert.equal(f.requests.length, 1);
	});
}

for (const scenario of ["success", "capacity", "cancelled", "payload-error"]) {
	test(`bundled llama.cpp native receipt: ${scenario}`, async (t) => {
		const f = await fixture(t);
		const loader = new DefaultResourceLoader({
			cwd: f.root,
			agentDir: f.root,
			noExtensions: true,
			noSkills: true,
			noContextFiles: true,
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: f.root,
			agentDir: f.root,
			modelRuntime: f.runtime,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(f.root),
			model: f.model,
			tools: [],
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		});
		const attachment = await PiFlowAttachment.open(join(f.root, "flow"), {
			sessionId: session.sessionId,
			branchId: "main",
		});
		const bridge = new PiNativeRequests(
			session,
			attachment.nativeRequests,
			scenario === "capacity" ? 1 : 100000,
			undefined,
			false,
			undefined,
			undefined,
			session.agent.streamFunction,
		);
		afterCleanup(t, async () => {
			await bridge.close();
			await attachment.close();
			await session.dispose();
		});
		if (scenario === "cancelled")
			session.agent.onPayload = () => {
				session.agent.abort();
			};
		if (scenario === "payload-error")
			session.agent.onPayload = () => {
				throw Error("payload fixture rejection");
			};
		try {
			await session.prompt("hello");
		} catch (error) {
			if (scenario === "success") throw error;
		}
		const records = await attachment.nativeRequests.snapshot();
		assert.equal(records.length, 1);
		assert.equal(records[0].outcome, scenario === "success" ? "success" : "withheld");
		assert.equal(f.requests.length, scenario === "success" ? 1 : 0);
	});
}

for (const disabled of [false, true]) {
	test(`bundled llama.cpp loader respects disabled=${disabled}`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "jouzu-llama-loader-"));
		afterCleanup(t, () => rm(root, { recursive: true, force: true }));
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			noSkills: true,
			noContextFiles: true,
			settingsManager: SettingsManager.inMemory(),
			extensionFactories: classicHostBuiltinOverrides(),
			disabledBuiltinExtensions: disabled ? ["llama.cpp", "mcp", "codemode"] : ["mcp", "codemode"],
		});
		await loader.reload();
		const extensions = loader.getExtensions();
		assert.deepEqual(extensions.errors, []);
		const registrations = extensions.runtime.pendingNativeProviderRegistrations.filter(
			({ provider }) => provider.id === "llama.cpp",
		);
		assert.equal(registrations.length, disabled ? 0 : 1);
		assert.equal(
			extensions.extensions.some((entry) => entry.commands.has("llama")),
			!disabled,
		);
	});
}
