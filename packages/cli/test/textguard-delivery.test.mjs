import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createTextGuardReviewExtension } from "../dist/textguard-review.js";
import { TextGuardRuntime } from "../dist/textguard-runtime.js";

test("registered review command releases checked skill bytes through reload to the provider", {
	timeout: 15000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-textguard-delivery-"));
	const guard = new TextGuardRuntime();
	let session;
	try {
		const skill = join(directory, "SKILL.md");
		const original = "---\nname: approval-fixture\ndescription: PRIVATE_DESCRIPTION\n---\nAPPROVED_BODY\u202e\n";
		await writeFile(skill, original);
		const modelRuntime = await ModelRuntime.create({
			credentials: {
				read: async () => undefined,
				list: async () => [],
				modify: async () => undefined,
				delete: async () => {},
			},
			modelsPath: null,
			modelsStorePath: join(directory, "models.json"),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const contexts = [];
		const model = {
			id: "fixture",
			name: "Fixture",
			provider: "fixture",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1",
			reasoning: false,
			input: ["text"],
			contextWindow: 32000,
			maxTokens: 256,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		modelRuntime.registerProvider("fixture", {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "fixture",
			models: [model],
			streamSimple(selected, context) {
				contexts.push(structuredClone({ systemPrompt: context.systemPrompt, messages: context.messages }));
				const message = {
					role: "assistant",
					content: [{ type: "text", text: "Done." }],
					api: selected.api,
					provider: selected.provider,
					model: selected.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				});
				return stream;
			},
		});
		const sessionManager = SessionManager.inMemory(directory);
		const policy = await guard.createPolicy({ cwd: directory, sessionId: sessionManager.getSessionId() });
		let allow = false;
		let reloads = 0;
		const dialogs = [];
		const errors = [];
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			noSkills: true,
			noExtensions: true,
			noPromptTemplates: true,
			noContextFiles: true,
			additionalSkillPaths: [skill],
			contentPolicy: policy,
			extensionFactories: [
				createTextGuardReviewExtension(guard, { terminal: () => ({ columns: 80, rows: 30, dumb: false }) }),
			],
		});
		await loader.reload();
		assert.equal(loader.getSkills().skills.length, 0);
		({ session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			modelRuntime,
			model,
			resourceLoader: loader,
			sessionManager,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			tools: ["read"],
		}));
		await session.bindExtensions({
			mode: "tui",
			uiContext: {
				notify() {},
				select: async (title, options) => {
					dialogs.push({ title, options });
					return allow && options.includes("Allow this content for this session")
						? "Allow this content for this session"
						: options[0];
				},
			},
			commandContextActions: {
				reload: async () => {
					reloads++;
					await session.reload();
				},
			},
			onError: (error) => errors.push(error),
		});
		await session.prompt("Hello");
		assert.equal(contexts.length, 1, JSON.stringify(session.agent.state.messages));
		assert.doesNotMatch(JSON.stringify(contexts[0]), /PRIVATE_DESCRIPTION|APPROVED_BODY/);
		await session.prompt("/textguard");
		assert.equal(contexts.length, 1);
		assert.equal(reloads, 0);
		assert.equal(policy.reviews().length, 1);
		allow = true;
		await session.prompt("/textguard");
		assert.deepEqual(errors, []);
		assert.equal(reloads, 1);
		assert.equal(contexts.length, 1);
		assert.equal(loader.getSkills().skills.length, 1);
		await session.prompt("/skill:approval-fixture");
		assert.equal(contexts.length, 2);
		assert.match(contexts[1].systemPrompt, /PRIVATE_DESCRIPTION/);
		const expanded = contexts[1].messages.find(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("APPROVED_BODY"),
		);
		assert.ok(expanded);
		assert.ok(JSON.stringify(expanded).includes("\u202e"));
		await writeFile(skill, original.replace("APPROVED_BODY", "CHANGED_BODY"));
		await session.reload();
		assert.equal(loader.getSkills().skills.length, 0);
		assert.equal(policy.reviews().length, 1);
		await session.prompt("/skill:approval-fixture");
		assert.doesNotMatch(JSON.stringify(contexts.at(-1)), /CHANGED_BODY/);
		assert.equal(dialogs.filter((dialog) => dialog.options.includes("Allow this content for this session")).length, 2);
	} finally {
		session?.dispose();
		await guard.close();
		await rm(directory, { recursive: true, force: true });
	}
});
