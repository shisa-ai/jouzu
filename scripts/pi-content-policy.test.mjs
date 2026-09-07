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
