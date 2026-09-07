import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { NativeContentPolicy } from "../packages/cli/dist/textguard-policy.js";
import { applyContentPolicy } from "./apply-pi-content-policy.mjs";

const withheld = { content: [{ type: "text", text: "WITHHELD" }], details: {}, isError: true };
const passthrough = () => ({
	async filterSkills(skills) {
		return skills;
	},
	async readSkill() {
		return undefined;
	},
	shouldInspectTool() {
		return true;
	},
	async filterToolResult() {
		return withheld;
	},
	async filterContext(messages) {
		return messages;
	},
});

test("patch manifest uses the release deviation schema and pins its exact bytes", async () => {
	const pin = JSON.parse(await readFile(new URL("../upstream/pi.lock.json", import.meta.url), "utf8"));
	const manifest = await readFile(new URL("../upstream/pi-content-policy/patch.lock.json", import.meta.url));
	assert.deepEqual(pin.deviations, [
		{
			path: "upstream/pi-content-policy/patch.lock.json",
			sha256: createHash("sha256").update(manifest).digest("hex"),
		},
	]);
});

test("patch is locked and idempotent; modified input never gets overwritten", async () => {
	const base = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/", import.meta.url));
	assert.equal(await applyContentPolicy(base, true), 0);
	assert.equal(await applyContentPolicy(base), 0);
	const directory = await mkdtemp(join(tmpdir(), "jouzu-policy-patch-"));
	try {
		await writeFile(
			join(directory, "package.json"),
			JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.1" }),
		);
		await mkdir(join(directory, "dist"));
		await writeFile(join(directory, "dist/main.js"), "unrecognized");
		await assert.rejects(applyContentPolicy(directory), /hash mismatch/);
		assert.equal(await readFile(join(directory, "dist/main.js"), "utf8"), "unrecognized");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("inventory publication waits for admission and exceptions withhold all metadata", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-policy-skills-"));
	try {
		const skill = join(directory, "SKILL.md");
		await writeFile(skill, "---\nname: fixture\ndescription: PRIVATE DESCRIPTION\n---\nPRIVATE BODY\n");
		let release;
		const policy = passthrough();
		policy.filterSkills = () =>
			new Promise((resolve) => {
				release = resolve;
			});
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			contentPolicy: policy,
			noExtensions: true,
		});
		const loading = loader.updateSkillsFromPaths([skill], new Map());
		assert.deepEqual(loader.getSkills().skills, []);
		release([]);
		await loading;
		assert.deepEqual(loader.getSkills().skills, []);
		policy.filterSkills = async () => {
			throw new Error("PRIVATE DESCRIPTION");
		};
		await loader.updateSkillsFromPaths([skill], new Map());
		assert.deepEqual(loader.getSkills(), { skills: [], diagnostics: [] });
		policy.filterSkills = async (skills) => skills;
		await loader.extendResources({
			skillPaths: [{ path: skill, metadata: { source: "fixture", scope: "temporary", origin: "top-level" } }],
		});
		assert.equal(loader.getSkills().skills[0].name, "fixture");
		const releases = [];
		policy.filterSkills = (skills) => new Promise((resolve) => releases.push(() => resolve(skills)));
		const stale = loader.updateSkillsFromPaths([skill], new Map());
		const latest = loader.updateSkillsFromPaths([], new Map());
		releases[1]();
		await latest;
		releases[0]();
		await stale;
		assert.deepEqual(loader.getSkills().skills, []);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("skill expansion injects checked bytes and awaits both queued paths", async () => {
	const policy = passthrough();
	policy.readSkill = async () => "CHECKED BODY";
	const loader = {
		contentPolicy: policy,
		getSkills: () => ({ skills: [{ name: "fixture", filePath: "nonexistent", baseDir: "/fixture" }] }),
	};
	const received = [];
	const fake = {
		resourceLoader: loader,
		promptTemplates: [],
		_throwIfExtensionCommand() {},
		_expandSkillCommand: AgentSession.prototype._expandSkillCommand,
		async _queueSteer(text) {
			received.push(text);
		},
		async _queueFollowUp(text) {
			received.push(text);
		},
	};
	await AgentSession.prototype.steer.call(fake, "/skill:fixture");
	await AgentSession.prototype.followUp.call(fake, "/skill:fixture");
	for (const text of received) assert.match(text, /CHECKED BODY/);
	policy.readSkill = async () => {
		throw new Error("PRIVATE BODY");
	};
	const rejected = await fake._expandSkillCommand("/skill:fixture");
	assert.equal(rejected.includes("PRIVATE BODY"), false);
	assert.match(rejected, /withheld/);
});

test("final tool policy sees extension output and errors remove text and structured details", async () => {
	const policy = passthrough();
	let seen;
	policy.filterToolResult = async (event) => {
		seen = event;
		throw new Error("PRIVATE BODY");
	};
	const fake = {
		agent: {},
		resourceLoader: { contentPolicy: policy },
		settingsManager: { getImageAutoResize: () => false },
		_extensionRunner: {
			hasHandlers: () => true,
			async emitToolResult() {
				return { content: [{ type: "text", text: "EXTENSION BODY" }], details: { secret: "EXTENSION DETAIL" } };
			},
		},
	};
	AgentSession.prototype._installAgentToolHooks.call(fake);
	const result = await fake.agent.afterToolCall({
		toolCall: { name: "web_fetch", id: "1" },
		args: { url: "https://example.com" },
		result: { content: [{ type: "text", text: "PRIVATE BODY" }], details: { secret: "PRIVATE DETAIL" } },
		isError: false,
	});
	assert.equal(seen.result.content[0].text, "EXTENSION BODY");
	assert.equal(seen.result.details.secret, "EXTENSION DETAIL");
	assert.deepEqual(result.details, {});
	assert.equal(result.isError, true);
	assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
});

test("SDK final context errors stop delivery after ordinary extension handlers", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-policy-context-"));
	const runtime = await ModelRuntime.create({
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
	const policy = passthrough();
	let seen;
	policy.filterContext = async (messages) => {
		seen = messages;
		throw new Error("PRIVATE BODY");
	};
	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		noExtensions: true,
		noSkills: true,
		contentPolicy: policy,
	});
	let session;
	try {
		await loader.reload();
		({ session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			resourceLoader: loader,
			modelRuntime: runtime,
			model: {
				id: "fixture",
				provider: "fixture",
				api: "openai-completions",
				reasoning: false,
				input: ["text"],
				contextWindow: 4096,
				maxTokens: 256,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			sessionManager: SessionManager.inMemory(directory),
			settingsManager: SettingsManager.inMemory(),
			tools: [],
		}));
		session._extensionRunner.emitContext = async () => [{ role: "user", content: "EXTENSION BODY", timestamp: 1 }];
		await assert.rejects(
			session.agent.transformContext([{ role: "user", content: "PRIVATE BODY", timestamp: 1 }]),
			/request withheld/,
		);
		assert.equal(seen[0].content, "EXTENSION BODY");
	} finally {
		session?.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const fixtureModel = {
	id: "fixture",
	provider: "fixture",
	api: "openai-completions",
	reasoning: false,
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 256,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const textguardScanner = () => ({
	async initialize() {
		return "a".repeat(64);
	},
	async scan(text) {
		if (!text.includes("PRIVATE")) {
			return {
				status: "clear",
				findings: [],
				findingCount: 0,
				severityCounts: { info: 0, warn: 0, error: 0 },
				decodeReasons: [],
			};
		}
		return {
			status: "findings",
			findings: [{ kind: "bidi", severity: "error", offset: 0, codepoint: "U+202E" }],
			findingCount: 1,
			severityCounts: { info: 0, warn: 0, error: 1 },
			decodeReasons: [],
		};
	},
	async close() {},
});
const assistantMessage = (text, stopReason = "stop") => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: fixtureModel.api,
	provider: fixtureModel.provider,
	model: fixtureModel.id,
	usage,
	stopReason,
	timestamp: Date.now(),
});
const doneStream = (final) => ({
	async *[Symbol.asyncIterator]() {
		yield { type: "done", partial: final };
	},
	result: async () => final,
});

test("aborted responses keep valid assistant messages for session stats and later prompts", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-policy-abort-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({
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
	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		noExtensions: true,
		noSkills: true,
		contentPolicy: new NativeContentPolicy({ cwd: directory, scanner: textguardScanner() }),
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		resourceLoader: loader,
		modelRuntime: runtime,
		model: fixtureModel,
		sessionManager: SessionManager.inMemory(directory),
		settingsManager: SettingsManager.inMemory(),
		tools: [],
	});
	t.after(() => session.dispose());
	session._modelRuntime.hasConfiguredAuth = () => true;
	session._modelRuntime.checkAuth = async () => "fixture-key";
	let calls = 0;
	let entered;
	const enteredPromise = new Promise((resolve) => {
		entered = resolve;
	});
	session.agent.streamFunction = async (_model, _context, options) => {
		calls++;
		if (calls > 1) return doneStream(assistantMessage("recovered answer"));
		const final = { ...assistantMessage("PARTIAL ANSWER"), stopReason: "aborted" };
		const signal = options.signal;
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: { ...final, content: [] } };
				entered();
				await new Promise((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				yield { type: "error", partial: final };
			},
			result: async () => final,
		};
	};
	const prompting = session.prompt("hello").catch(() => {});
	await enteredPromise;
	await session.abort();
	await prompting;
	const last = session.agent.state.messages.at(-1);
	assert.equal(last.role, "assistant");
	assert.equal(last.stopReason, "aborted");
	assert.equal(last.content[0].text, "PARTIAL ANSWER");
	assert.equal(last.usage.input, 10);
	assert.equal(last.api, "openai-completions");
	assert.equal(last.provider, "fixture");
	const stats = session.getSessionStats();
	assert.equal(stats.assistantMessages, 1);
	assert.ok(Number.isFinite(stats.tokens.total));
	await session.prompt("try again");
	assert.equal(session.agent.state.messages.at(-1).content[0].text, "recovered answer");
	assert.ok(Number.isFinite(session.getSessionStats().tokens.total));
});

test("message_end policy failures keep unscanned roles intact and fail closed with valid shapes", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-policy-message-end-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({
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
	const policy = passthrough();
	policy.filterContext = async () => {
		throw new Error("PRIVATE FAILURE");
	};
	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		noExtensions: true,
		noSkills: true,
		contentPolicy: policy,
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		resourceLoader: loader,
		modelRuntime: runtime,
		model: fixtureModel,
		sessionManager: SessionManager.inMemory(directory),
		settingsManager: SettingsManager.inMemory(),
		tools: [],
	});
	t.after(() => session.dispose());
	const assistant = assistantMessage("PROVIDER ANSWER");
	await session._handleAgentEvent({ type: "message_end", message: assistant });
	assert.equal(assistant.content[0].text, "PROVIDER ANSWER");
	assert.equal(assistant.stopReason, "stop");
	assert.equal(assistant.usage.input, 10);
	const toolResult = {
		role: "toolResult",
		toolCallId: "call1",
		toolName: "web_fetch",
		content: [{ type: "text", text: "PRIVATE WEB BODY" }],
		isError: false,
		timestamp: 3,
	};
	await session._handleAgentEvent({ type: "message_end", message: toolResult });
	assert.equal(toolResult.isError, true);
	assert.equal(toolResult.role, "toolResult");
	assert.equal(toolResult.toolCallId, "call1");
	assert.equal(JSON.stringify(toolResult).includes("PRIVATE"), false);
	const user = { role: "user", content: [{ type: "text", text: "PRIVATE ASK" }], timestamp: 4 };
	await session._handleAgentEvent({ type: "message_end", message: user });
	assert.equal(user.role, "user");
	assert.equal(user.timestamp, 4);
	assert.equal(JSON.stringify(user).includes("PRIVATE"), false);
	const custom = { role: "custom", customType: "note", content: "EXTENSION NOTE", display: true, timestamp: 5 };
	await session._handleAgentEvent({ type: "message_end", message: custom });
	assert.equal(custom.content, "EXTENSION NOTE");
	assert.equal(custom.customType, "note");
	const stats = session.getSessionStats();
	assert.ok(Number.isFinite(stats.tokens.total));
});

const restoredFixtureSession = async (t, directory, sessionManager) => {
	const runtime = await ModelRuntime.create({
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
	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: directory,
		noExtensions: true,
		noSkills: true,
		contentPolicy: new NativeContentPolicy({ cwd: directory, scanner: textguardScanner() }),
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: directory,
		resourceLoader: loader,
		modelRuntime: runtime,
		model: fixtureModel,
		sessionManager,
		settingsManager: SettingsManager.inMemory(),
		tools: [],
	});
	t.after(() => session.dispose());
	return session;
};

const appendWebTurn = (sessionManager) => {
	sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "please research" }], timestamp: 1 });
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call1", name: "web_fetch", arguments: { url: "https://example.com" } }],
		api: fixtureModel.api,
		provider: fixtureModel.provider,
		model: fixtureModel.id,
		usage,
		stopReason: "stop",
		timestamp: 2,
	});
	sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: "call1",
		toolName: "web_fetch",
		content: [{ type: "text", text: "PRIVATE WEB BODY" }],
		isError: false,
		timestamp: 3,
	});
	sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "continue" }], timestamp: 4 });
};

test("manual compaction filters restored blocked tool results before hooks and serialization", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-policy-compact-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sessionManager = SessionManager.inMemory(directory);
	appendWebTurn(sessionManager);
	const session = await restoredFixtureSession(t, directory, sessionManager);
	session.settingsManager.getCompactionSettings = () => ({ enabled: true, reserveTokens: 512, keepRecentTokens: 0 });
	const requests = [];
	session.agent.streamFunction = async (_model, context) => {
		requests.push(context);
		return doneStream(assistantMessage("SUMMARY"));
	};
	const hooks = [];
	session._extensionRunner.hasHandlers = (type) => type === "session_before_compact";
	session._extensionRunner.emit = async (event) => {
		if (event.type === "session_before_compact") hooks.push(event);
		return undefined;
	};
	const result = await session.compact();
	assert.match(result.summary, /SUMMARY/);
	assert.equal(requests.length, 1);
	const serialized = JSON.stringify(requests[0]);
	assert.equal(serialized.includes("PRIVATE"), false);
	assert.match(serialized, /TextGuard withheld this content pending user review/);
	assert.ok(hooks.length > 0);
	assert.equal(JSON.stringify(hooks[0].preparation.messagesToSummarize).includes("PRIVATE"), false);
	assert.equal(JSON.stringify(hooks[0].branchEntries).includes("PRIVATE"), false);
	const stored = sessionManager
		.getEntries()
		.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
	assert.equal(stored.message.content[0].text, "PRIVATE WEB BODY");
});

test("auto compaction gives extensions policy-checked history and honors extension summaries", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-policy-auto-compact-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sessionManager = SessionManager.inMemory(directory);
	appendWebTurn(sessionManager);
	const session = await restoredFixtureSession(t, directory, sessionManager);
	session.settingsManager.getCompactionSettings = () => ({ enabled: true, reserveTokens: 512, keepRecentTokens: 0 });
	let providerCalls = 0;
	session.agent.streamFunction = async () => {
		providerCalls++;
		return doneStream(assistantMessage("SUMMARY"));
	};
	let hook;
	session._extensionRunner.hasHandlers = (type) => type === "session_before_compact";
	session._extensionRunner.emit = async (event) => {
		if (event.type !== "session_before_compact") return undefined;
		hook = event;
		return {
			compaction: {
				summary: "EXTENSION SUMMARY",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		};
	};
	await session._runAutoCompaction("threshold", false);
	assert.ok(hook);
	assert.equal(JSON.stringify(hook.preparation.messagesToSummarize).includes("PRIVATE"), false);
	assert.equal(JSON.stringify(hook.branchEntries).includes("PRIVATE"), false);
	assert.equal(providerCalls, 0);
	const compaction = sessionManager.getEntries().find((entry) => entry.type === "compaction");
	assert.equal(compaction.summary, "EXTENSION SUMMARY");
});

test("branch summaries filter restored blocked skill expansions before summarization", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-policy-branch-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sessionManager = SessionManager.inMemory(directory);
	const targetId = sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "start work" }],
		timestamp: 1,
	});
	sessionManager.appendMessage({
		role: "user",
		content: [
			{
				type: "text",
				text: '<skill name="leaked" location="/tmp/leaked/SKILL.md">\nPRIVATE SKILL BODY\n</skill>\n\nuse this',
			},
		],
		timestamp: 2,
	});
	const session = await restoredFixtureSession(t, directory, sessionManager);
	const requests = [];
	session.agent.streamFunction = async (_model, context) => {
		requests.push(context);
		return doneStream(assistantMessage("BRANCH SUMMARY"));
	};
	await session.navigateTree(targetId, { summarize: true });
	assert.equal(requests.length, 1);
	const serialized = JSON.stringify(requests[0]);
	assert.equal(serialized.includes("PRIVATE"), false);
	assert.match(serialized, /TextGuard withheld this content pending user review/);
	const summary = sessionManager.getEntries().find((entry) => entry.type === "branch_summary");
	assert.match(summary.summary, /BRANCH SUMMARY/);
});

test("branch admission failure releases summarization state and permits retry", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-policy-branch-failure-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const manager = SessionManager.inMemory(directory);
	const target = manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
	manager.appendMessage({ role: "user", content: "continue", timestamp: 2 });
	const session = await restoredFixtureSession(t, directory, manager);
	const policy = session.resourceLoader.contentPolicy;
	const filter = policy.filterContext.bind(policy);
	policy.filterContext = async () => {
		throw new Error("PRIVATE FAILURE");
	};
	let calls = 0;
	session.agent.streamFunction = async () => {
		calls++;
		return doneStream(assistantMessage("SUMMARY"));
	};
	await assert.rejects(session.navigateTree(target, { summarize: true }), /history; branch summary withheld/);
	assert.equal(calls, 0);
	assert.equal(session._branchSummaryAbortController, undefined);
	policy.filterContext = filter;
	await session.navigateTree(target, { summarize: true });
	assert.equal(calls, 1);
});
