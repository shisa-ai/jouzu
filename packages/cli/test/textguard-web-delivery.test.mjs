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
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { createTextGuardReviewExtension } from "../dist/textguard-review.js";
import { TextGuardRuntime } from "../dist/textguard-runtime.js";

const identityTheme = { fg: (_role, value) => value, bg: (_role, value) => value, bold: (value) => value };
/** Drive the review overlay: open the item, then approve or cancel. */
async function driveReview(factory, allow) {
	let resolveDone;
	const donePromise = new Promise((resolve) => (resolveDone = resolve));
	const component = factory(
		{ terminal: { rows: 30, columns: 80 } },
		identityTheme,
		new KeybindingsManager(TUI_KEYBINDINGS),
		(result) => resolveDone(result),
	);
	const render = () => stripTerminalSequences(component.render(80).join("\n"));
	component.handleInput("\r");
	if (allow) {
		for (let step = 0; step < 4 && !render().includes("> Allow for this session"); step++)
			component.handleInput("\x1b[A");
		if (render().includes("> Allow for this session")) component.handleInput("\r");
	} else {
		component.handleInput("\x1b");
		component.handleInput("\x1b");
	}
	return donePromise;
}

for (const variant of ["text", "image"]) {
	test(`registered web approval binds the complete payload: ${variant}`, { timeout: 15000 }, async () => {
		const directory = await mkdtemp(join(tmpdir(), "jouzu-web-delivery-"));
		const guard = new TextGuardRuntime({ mode: "strict" });
		let session;
		try {
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
				input: ["text", "image"],
				contextWindow: 32000,
				maxTokens: 256,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			let call = 0;
			modelRuntime.registerProvider("fixture", {
				api: model.api,
				baseUrl: model.baseUrl,
				apiKey: "fixture",
				models: [model],
				streamSimple(selected, context) {
					contexts.push(structuredClone({ systemPrompt: context.systemPrompt, messages: context.messages }));
					const tool = context.messages.at(-1)?.role === "user";
					const message = {
						role: "assistant",
						content: tool
							? [
									{
										type: "toolCall",
										id: `fetch-${++call}`,
										name: "aio-webfetch",
										arguments: { url: "https://example.test/page" },
									},
								]
							: [{ type: "text", text: "Done." }],
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
						stopReason: tool ? "toolUse" : "stop",
						timestamp: Date.now(),
					};
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "done", reason: message.stopReason, message });
						stream.end(message);
					});
					return stream;
				},
			});
			const payload = {
				content: [{ type: "text", text: "APPROVED_WEB_BODY\u202e" }],
				details: { nested: { markdown: "APPROVED_WEB_DETAILS" } },
			};
			if (variant === "image") payload.content.push({ type: "image", mimeType: "image/png", data: "APPROVED_IMAGE" });
			const sessionManager = SessionManager.inMemory(directory);
			const policy = await guard.createPolicy({ cwd: directory, sessionId: sessionManager.getSessionId() });
			const loader = new DefaultResourceLoader({
				cwd: directory,
				agentDir: directory,
				noSkills: true,
				noExtensions: true,
				noPromptTemplates: true,
				noContextFiles: true,
				contentPolicy: policy,
				extensionFactories: [
					createTextGuardReviewExtension(guard, { terminal: () => ({ columns: 80, rows: 30, dumb: false }) }),
					(pi) =>
						pi.registerTool({
							name: "aio-webfetch",
							label: "Fixture fetch",
							description: "Fixture",
							parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
							execute: async () => structuredClone(payload),
						}),
				],
			});
			await loader.reload();
			({ session } = await createAgentSession({
				cwd: directory,
				agentDir: directory,
				modelRuntime,
				model,
				resourceLoader: loader,
				sessionManager,
				settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
			}));
			let allow = false;
			let reloads = 0;
			const errors = [];
			await session.bindExtensions({
				mode: "tui",
				uiContext: {
					notify() {},
					custom: async (factory) => driveReview(factory, allow),
				},
				commandContextActions: {
					reload: async () => {
						reloads++;
						await session.reload();
					},
				},
				onError: (error) => errors.push(error),
			});
			const latest = () =>
				contexts
					.at(-1)
					.messages.filter((message) => message.role === "toolResult")
					.at(-1);
			await session.prompt("Fetch the page");
			assert.equal(contexts.length, 2);
			assert.equal(latest().isError, true);
			assert.ok(policy.reviews().length > 0, JSON.stringify(latest()));
			assert.equal(policy.reviews()[0].evidence.status, variant === "image" ? "unavailable" : "findings");
			assert.doesNotMatch(JSON.stringify(contexts), /APPROVED_WEB|APPROVED_IMAGE/);
			await session.prompt("/textguard");
			assert.equal(reloads, 0);
			allow = true;
			await session.prompt("/textguard");
			assert.deepEqual(errors, []);
			assert.equal(reloads, 1);
			await session.prompt("Fetch the page again");
			assert.equal(contexts.length, 4);
			assert.deepEqual(latest().content, payload.content);
			assert.equal(latest().isError, false);
			const saved = session.agent.state.messages.filter((message) => message.role === "toolResult").at(-1);
			assert.deepEqual(saved.details, payload.details);
			// Only metadata changes: the prior approval must not admit the new result.
			payload.details.nested.markdown = "CHANGED_WEB_DETAILS";
			await session.prompt("Fetch once more");
			assert.equal(contexts.length, 6);
			assert.equal(latest().isError, true);
			assert.match(latest().content[0].text, /withheld/);
			assert.doesNotMatch(JSON.stringify(contexts), /CHANGED_WEB_DETAILS/);
			assert.doesNotMatch(JSON.stringify(session.agent.state.messages), /CHANGED_WEB_DETAILS/);
		} finally {
			session?.dispose();
			await guard.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
}
