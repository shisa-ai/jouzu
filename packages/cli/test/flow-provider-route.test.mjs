import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { PiNativeRequests } from "../dist/flow-control/pi-native-requests.js";
import { preparePiProviderRoute } from "../dist/flow-control/pi-provider-route.js";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-route-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let requests = 0;
	const server = createServer((_request, response) => {
		requests++;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(
			'data: {"id":"test","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		modelsStorePath: join(root, "models.json"),
		authPath: join(root, "auth.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	const config = {
		api: "openai-completions",
		apiKey: "fixture-key",
		baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
		models: [
			{
				id: "fixture",
				name: "fixture",
				reasoning: false,
				input: ["text"],
				contextWindow: 4096,
				maxTokens: 256,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	};
	runtime.registerProvider("fixture", config);
	const model = runtime.getModel("fixture", "fixture");
	const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
	return { root, runtime, config, model, context, requests: () => requests };
}

test("qualified custom endpoint keeps Pi auth, header preparation, and converter dispatch", async (t) => {
	const f = await fixture(t);
	let checks = 0,
		headers = 0;
	const guard = preparePiProviderRoute(f.runtime, f.model, () => checks++);
	const result = await f.runtime
		.streamSimple(f.model, f.context, {
			flowValidateProvider: guard,
			transformHeaders: async (values) => {
				headers++;
				return values;
			},
		})
		.result();
	assert.notEqual(result.stopReason, "error", result.errorMessage);
	assert.equal(f.requests(), 1);
	assert.equal(headers, 1);
	assert.equal(checks, 2);
});

for (const replacement of ["unknown-api", "custom-handler", "native-provider", "runtime-stream"]) {
	test(`route guard rejects ${replacement} before dispatch`, async (t) => {
		const f = await fixture(t);
		let invoked = 0;
		const streamSimple = () => {
			invoked++;
			throw Error("must not invoke");
		};
		if (replacement === "unknown-api") f.model.api = "unqualified-api";
		if (replacement === "custom-handler") f.runtime.registerProvider("fixture", { ...f.config, streamSimple });
		if (replacement === "native-provider")
			f.runtime.registerNativeProvider({ ...f.runtime.getProvider("fixture"), streamSimple });
		if (replacement === "runtime-stream") f.runtime.streamSimple = streamSimple;
		assert.throws(() => preparePiProviderRoute(f.runtime, f.model, () => {}), { code: "identity" });
		assert.equal(invoked, 0);
		assert.equal(f.requests(), 0);
	});
}

for (const phase of ["auth", "headers"]) {
	test(`route change during ${phase} is held before either provider runs`, async (t) => {
		const f = await fixture(t);
		let invoked = 0;
		const change = () =>
			f.runtime.registerProvider("fixture", {
				...f.config,
				streamSimple: () => {
					invoked++;
					throw Error("must not invoke");
				},
			});
		const flowValidateProvider = preparePiProviderRoute(f.runtime, f.model, () => {});
		if (phase === "auth") {
			const getAuth = f.runtime.getAuth.bind(f.runtime);
			f.runtime.getAuth = async (...args) => {
				const result = await getAuth(...args);
				change();
				return result;
			};
		}
		const result = await f.runtime
			.streamSimple(f.model, f.context, {
				flowValidateProvider,
				transformHeaders: async (headers) => {
					if (phase === "headers") change();
					return headers;
				},
			})
			.result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /unsupported request handler/);
		assert.equal(invoked, 0);
		assert.equal(f.requests(), 0);
	});
}

test("attachment change holds only that runtime and qualified routes can be selected again", async (t) => {
	const first = await fixture(t),
		second = await fixture(t);
	let attached = true;
	const flowValidateProvider = preparePiProviderRoute(first.runtime, first.model, () => {
		if (!attached) throw Error("attachment changed");
	});
	const held = await first.runtime
		.streamSimple(first.model, first.context, {
			flowValidateProvider,
			transformHeaders: async (headers) => {
				attached = false;
				return headers;
			},
		})
		.result();
	assert.equal(held.stopReason, "error");
	assert.equal(first.requests(), 0);
	const allowed = await second.runtime
		.streamSimple(second.model, second.context, {
			flowValidateProvider: preparePiProviderRoute(second.runtime, second.model, () => {}),
		})
		.result();
	assert.notEqual(allowed.stopReason, "error", allowed.errorMessage);
	assert.equal(second.requests(), 1);
	attached = true;
	const resumed = await first.runtime
		.streamSimple(first.model, first.context, {
			flowValidateProvider: preparePiProviderRoute(first.runtime, first.model, () => {}),
		})
		.result();
	assert.notEqual(resumed.stopReason, "error", resumed.errorMessage);
	assert.equal(first.requests(), 1);
});

for (const scenario of ["qualified", "handler-replaced", "session-replaced"]) {
	test(`SDK native receipt guard: ${scenario}`, async (t) => {
		const f = await fixture(t);
		const loader = new DefaultResourceLoader({ cwd: f.root, agentDir: f.root, noExtensions: true, noSkills: true });
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
		const trustedStream = session.agent.streamFunction;
		const bridge = new PiNativeRequests(
			session,
			attachment.nativeRequests,
			100000,
			undefined,
			false,
			undefined,
			undefined,
			trustedStream,
		);
		t.after(async () => {
			await bridge.close();
			await attachment.close();
			await session.dispose();
		});
		let unknown = 0;
		const replacement = () => {
			unknown++;
			throw Error("must not invoke");
		};
		if (scenario === "handler-replaced")
			f.runtime.registerProvider("fixture", { ...f.config, streamSimple: replacement });
		if (scenario === "session-replaced") session.agent.streamFunction = replacement;
		let failed;
		try {
			await session.prompt("hello");
		} catch (error) {
			failed = error;
		}
		const records = await attachment.nativeRequests.snapshot();
		if (scenario === "qualified") {
			assert.equal(failed, undefined);
			assert.equal(f.requests(), 1);
			assert.equal(records.length, 1);
			assert.equal(records[0].outcome, "success");
		} else {
			assert.equal(f.requests(), 0);
			assert.equal(unknown, 0);
			assert.ok(session.agent.state.messages.some((message) => message.role === "user"));
			if (scenario === "handler-replaced") assert.equal(records[0].outcome, "withheld");
			if (scenario === "session-replaced") {
				await bridge.close();
				assert.throws(
					() =>
						new PiNativeRequests(
							session,
							attachment.nativeRequests,
							100000,
							undefined,
							false,
							undefined,
							undefined,
							trustedStream,
						),
					/request handler changed/,
				);
				assert.equal(session.agent.streamFunction, replacement);
			}
		}
	});
}
