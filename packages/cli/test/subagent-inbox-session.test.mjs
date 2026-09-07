import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createWorkflowIntegration } from "../dist/subagents/integration.js";

for (const scenario of ["observed", "redacted-read", "acknowledge", "reply", "stale", "mixed", "queued"]) {
	test(`real Pi subagent inbox request count: ${scenario}`, { timeout: 15000 }, async (t) => {
		t.mock.method(globalThis, "fetch", async () => {
			throw new Error("Network disabled in inbox fixture");
		});
		const root = await mkdtemp(join(tmpdir(), "jouzu-subagent-inbox-"));
		const workers = [];
		const integration = createWorkflowIntegration(
			{ configDir: join(root, "config"), stateDir: join(root, "state") },
			(launch, emit, exit) => {
				const worker = {
					launch,
					emit,
					exit,
					send() {},
					async stop() {
						exit(false);
					},
				};
				workers.push(worker);
				return worker;
			},
		);
		const roles = integration.service.roles();
		roles.config.maxConcurrent = 8;
		roles.config.roles = roles.config.roles.map((role) => ({ ...role, model: "child/test", tools: ["read"] }));
		integration.service.save(roles);
		const model = {
			id: "test",
			name: "Fixture",
			provider: "fixture",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1",
			reasoning: false,
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const modelRuntime = await ModelRuntime.create({
			credentials: {
				read: async () => undefined,
				list: async () => [],
				modify: async () => undefined,
				delete: async () => {},
			},
			modelsPath: null,
			modelsStorePath: join(root, "models.json"),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		modelRuntime.registerProvider("child", {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "fixture",
			models: [{ ...model, provider: "child" }],
		});
		let session;
		let requests = 0;
		let scriptFailure;
		const errors = [];
		const text = (value) => ({ type: "text", text: value });
		const tool = (name, args, id) => ({ type: "toolCall", name, arguments: args, id });
		async function response() {
			requests++;
			assert.ok(requests <= 8, "must not loop on completion");
			if (requests === 1)
				return Array.from({ length: 3 }, (_, i) =>
					tool("subagent", { op: "launch", role: "coder", task: `Fixture ${i}` }, `launch-${i}`),
				);
			if (requests === 2) {
				assert.equal(workers.length, 3);
				for (let i = 0; i < workers.length; i++) {
					workers[i].emit({ type: "result", status: i === 0 ? "failed" : "completed", text: `Result ${i}` });
					workers[i].exit(true);
				}
				// Busy longer than the preceding debounce: completions must remain retractable.
				await new Promise((resolve) => setTimeout(resolve, 150));
				return ["observed", "redacted-read"].includes(scenario)
					? integration.service.runs().map((run, i) => tool("subagent", { op: "read", id: run.id }, `read-${i}`))
					: [text("Initial work finished.")];
			}
			if (["observed", "redacted-read"].includes(scenario)) return [text("Read tools finished.")];
			if (requests === 3) {
				const entry = [...session.sessionManager.getBranch()]
					.reverse()
					.find((item) => item.type === "custom_message" && item.customType === "jouzu-subagent-result");
				assert.ok(entry, "receipt must precede the notification provider request");
				if (scenario === "reply") return [text("The failed child needs attention.")];
				if (scenario === "queued") await session.followUp("User work must survive");
				const calls = [
					tool(
						"subagent",
						{ op: "acknowledge", batchId: scenario === "stale" ? "stale" : entry.details.inbox.batchId },
						"ack",
					),
				];
				if (scenario === "mixed") calls.push(tool("fixture_aux", {}, "aux"));
				return calls;
			}
			return [text(scenario === "queued" ? "User work handled." : "Additional work handled.")];
		}
		modelRuntime.registerProvider("fixture", {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "fixture",
			models: [model],
			streamSimple() {
				const stream = createAssistantMessageEventStream();
				void (async () => {
					try {
						const content = await response();
						const message = {
							role: "assistant",
							content,
							api: model.api,
							provider: model.provider,
							model: model.id,
							stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
							timestamp: Date.now(),
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						};
						stream.push({ type: "done", reason: message.stopReason, message });
						stream.end(message);
					} catch (error) {
						scriptFailure = error;
						stream.end();
					}
				})();
				return stream;
			},
		});
		try {
			const loader = new DefaultResourceLoader({
				cwd: root,
				agentDir: root,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
				extensionFactories: [
					(pi) => {
						integration.register(pi, async () => false);
						if (scenario === "redacted-read")
							pi.on("tool_result", (event) =>
								event.toolName === "subagent" && event.details?.terminalRead
									? { content: [text("Read content removed by policy")] }
									: undefined,
							);
						pi.registerTool({
							name: "fixture_aux",
							label: "Auxiliary",
							description: "Non-terminating sibling",
							parameters: { type: "object", properties: {} },
							execute: async () => ({ content: [text("Auxiliary complete")], details: {} }),
						});
					},
				],
			});
			await loader.reload();
			({ session } = await createAgentSession({
				cwd: root,
				agentDir: root,
				modelRuntime,
				model,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(root),
				settingsManager: SettingsManager.inMemory({
					retry: { enabled: false },
					compaction: { enabled: false },
					followUpMode: "one-at-a-time",
				}),
				tools: ["subagent", "fixture_aux"],
			}));
			await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
			await session.prompt("Run child fixtures.");
			await new Promise((resolve) => setTimeout(resolve, 20));
			await session.agent.waitForIdle();
			await new Promise((resolve) => setTimeout(resolve, 20));
			if (scriptFailure) throw scriptFailure;
			assert.deepEqual(errors, []);
			assert.equal(requests, ["mixed", "stale", "queued", "redacted-read"].includes(scenario) ? 4 : 3);
			const batches = session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "jouzu-subagent-result");
			assert.equal(batches.length, scenario === "observed" ? 0 : 1);
			const prose = session.messages
				.filter((message) => message.role === "assistant")
				.flatMap((message) => message.content.filter((part) => part.type === "text").map((part) => part.text));
			if (scenario === "acknowledge") assert.deepEqual(prose, ["Initial work finished."]);
			if (scenario === "reply") assert.ok(prose.includes("The failed child needs attention."));
			if (scenario === "queued") assert.ok(prose.includes("User work handled."));
		} finally {
			await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session?.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});
}
