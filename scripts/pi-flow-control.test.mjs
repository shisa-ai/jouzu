import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { applyFlowControl } from "./apply-pi-flow-control.mjs";

const model = {
	id: "fixture",
	provider: "fixture",
	api: "openai-completions",
	name: "fixture",
	baseUrl: "",
	reasoning: false,
	input: ["text", "image"],
	contextWindow: 4096,
	maxTokens: 256,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const assistant = () => ({
	role: "assistant",
	content: [{ type: "text", text: "Done" }],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
});
const message = (text = "same") => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const doneStream = () => {
	const final = assistant();
	return {
		async *[Symbol.asyncIterator]() {
			yield { type: "done", partial: final };
		},
		result: async () => final,
	};
};
const deferred = () => {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
};
function agentFixture(flowCheckpoints = {}) {
	const requests = [];
	const agent = new Agent({
		initialState: { model, messages: [assistant()] },
		flowCheckpoints,
		streamFn: async (_model, context) => {
			requests.push(structuredClone(context.messages));
			return doneStream();
		},
	});
	return { agent, requests };
}

test("flow deviation locks exact bytes and both installed host trees are idempotent", async () => {
	const pin = JSON.parse(await readFile(new URL("../upstream/pi.lock.json", import.meta.url)));
	const bytes = await readFile(new URL("../upstream/pi-flow-control/patch.lock.json", import.meta.url));
	assert.deepEqual(
		pin.deviations.filter((item) => item.path === "upstream/pi-flow-control/patch.lock.json"),
		[{ path: "upstream/pi-flow-control/patch.lock.json", sha256: createHash("sha256").update(bytes).digest("hex") }],
	);
	for (const root of [
		resolve("."),
		resolve("packages/cli"),
		resolve("node_modules/@earendil-works/pi-coding-agent"),
		resolve("packages/cli/node_modules/@earendil-works/pi-coding-agent"),
	]) {
		assert.equal(await applyFlowControl(root, true), 0);
		assert.equal(await applyFlowControl(root), 0);
	}
});

test("unrecognized core bytes are refused without overwriting them", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-patch-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const core = join(root, "node_modules/@earendil-works/pi-agent-core");
	await mkdir(join(core, "dist"), { recursive: true });
	await writeFile(
		join(core, "package.json"),
		JSON.stringify({
			name: "@earendil-works/pi-agent-core",
			version: "0.85.1",
			exports: { "./package.json": "./package.json" },
		}),
	);
	await writeFile(join(core, "dist/agent.js"), "unrecognized");
	await assert.rejects(applyFlowControl(root), /hash mismatch/);
	assert.equal(await readFile(join(core, "dist/agent.js"), "utf8"), "unrecognized");
});

test("native queue identities distinguish duplicate text and images and cancel exactly one", async () => {
	const { agent, requests } = agentFixture();
	const prompt = message();
	prompt.content.push({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
	const first = agent.followUp(prompt);
	const second = agent.followUp(prompt);
	assert.notEqual(first.id, second.id);
	prompt.content[0].text = "changed by caller";
	assert.deepEqual(agent.cancelQueuedMessage(first.id, first.revision), { kind: "cancelled" });
	assert.deepEqual(agent.cancelQueuedMessage(first.id, first.revision), { kind: "not-queued" });
	assert.equal(agent.inspectQueuedMessages()[0].id, second.id);
	await agent.continue();
	assert.equal(requests.length, 1);
	assert.equal(requests[0].at(-1).content[0].text, "same");
	assert.equal(requests[0].at(-1).content[1].data, "aGVsbG8=");
	assert.deepEqual(agent.inspectQueuedMessages(), []);
});

for (const action of ["cancel", "edit", "clear"]) {
	test(`${action} during awaited claim cannot deliver the stale queue revision`, async () => {
		const entered = deferred();
		const release = deferred();
		const { agent, requests } = agentFixture({
			beforeQueueClaim: async () => {
				entered.resolve();
				await release.promise;
				return true;
			},
		});
		const queued = agent.followUp(message());
		const running = agent.continue();
		await entered.promise;
		if (action === "cancel") assert.deepEqual(agent.cancelQueuedMessage(queued.id, 1), { kind: "cancelled" });
		if (action === "edit") {
			assert.deepEqual(agent.editQueuedMessage(queued.id, 1, message("edited")), { kind: "edited", revision: 2 });
			assert.deepEqual(agent.cancelQueuedMessage(queued.id, 1), { kind: "conflict", revision: 2 });
		}
		if (action === "clear") agent.clearAllQueues();
		release.resolve();
		await running;
		assert.equal(requests.length, 0);
		if (action === "edit") {
			agent.flowCheckpoints = {};
			await agent.continue();
			assert.equal(requests[0].at(-1).content[0].text, "edited");
		}
	});
}

test("queue claim owns the native run before awaiting and abort retains unconsumed input", async () => {
	const entered = deferred();
	const release = deferred();
	const { agent, requests } = agentFixture({
		beforeQueueClaim: async () => {
			entered.resolve();
			await release.promise;
			return true;
		},
	});
	const queued = agent.steer(message());
	const running = agent.continue();
	await entered.promise;
	await assert.rejects(agent.prompt("competing"), /already processing/);
	agent.abort();
	release.resolve();
	await running;
	assert.equal(requests.length, 0);
	assert.equal(agent.inspectQueuedMessages()[0].id, queued.id);
	agent.flowCheckpoints = {};
	await agent.continue();
	assert.equal(requests.length, 1);
});

test("cancelled automation cannot consume user input queued during its claim", async () => {
	const entered = deferred();
	const release = deferred();
	const { agent, requests } = agentFixture({
		beforeQueueClaim: async () => {
			entered.resolve();
			await release.promise;
			return true;
		},
	});
	const automated = agent.followUp(message("automation"));
	const running = agent.continue();
	await entered.promise;
	agent.cancelQueuedMessage(automated.id, 1);
	const user = agent.followUp(message("user"));
	release.resolve();
	await running;
	assert.equal(requests.length, 0);
	assert.equal(agent.inspectQueuedMessages()[0].id, user.id);
	agent.flowCheckpoints = {};
	await agent.continue();
	assert.equal(requests.length, 1);
	assert.equal(requests[0].at(-1).content[0].text, "user");
});

test("claim exceptions and holds preserve native pending membership", async () => {
	const { agent, requests } = agentFixture({
		beforeQueueClaim: () => {
			throw new Error("Claim unavailable");
		},
	});
	const item = agent.followUp(message());
	await agent.continue();
	assert.equal(requests.length, 0);
	assert.equal(agent.inspectQueuedMessages()[0].id, item.id);
	agent.flowCheckpoints = { beforeQueueClaim: () => false };
	await agent.continue();
	assert.equal(requests.length, 0);
	assert.equal(agent.inspectQueuedMessages()[0].id, item.id);
	assert.deepEqual(agent.cancelQueuedMessage(item.id, 1), { kind: "cancelled" });
});

test("default Pi queue behavior accepts renderer data and rejects empty assistant continuation", async () => {
	const agent = new Agent({ initialState: { model, messages: [assistant()] }, streamFn: doneStream });
	await assert.rejects(agent.continue(), /Cannot continue from message role: assistant/);
	const custom = { role: "custom", customType: "fixture", content: "context", details: { render: () => "local" } };
	assert.doesNotThrow(() => agent.followUp(custom));
	agent.clearAllQueues();
});

test("active native loops claim steering then follow-up and checkpoint each stream invocation", async () => {
	const entered = deferred();
	const release = deferred();
	const claims = [];
	const ids = [];
	let calls = 0;
	const agent = new Agent({
		initialState: { model },
		flowCheckpoints: {
			beforeQueueClaim: (items) => {
				claims.push(items);
				return true;
			},
			beforeRequest: ({ requestId }) => {
				ids.push(requestId);
			},
		},
		streamFn: async () => {
			calls++;
			if (calls === 1) {
				entered.resolve();
				await release.promise;
			}
			return doneStream();
		},
	});
	const running = agent.prompt("initial");
	await entered.promise;
	const followUp = agent.followUp(message("follow-up"));
	const steer = agent.steer(message("steering"));
	release.resolve();
	await running;
	assert.equal(calls, 3);
	assert.equal(new Set(ids).size, 3);
	assert.deepEqual(
		claims.map((items) => items[0].id),
		[steer.id, followUp.id],
	);
	assert.deepEqual(agent.inspectQueuedMessages(), []);
});

async function sessionFixture(t, flowCheckpoints, policy) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-host-"));
	const runtime = await ModelRuntime.create({
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
	const loader = new DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		noExtensions: true,
		noSkills: true,
		contentPolicy: policy,
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		resourceLoader: loader,
		modelRuntime: runtime,
		model,
		sessionManager: SessionManager.inMemory(root),
		settingsManager: SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: { enabled: false },
			images: { blockImages: true },
		}),
		tools: [],
		flowCheckpoints,
	});
	runtime.hasConfiguredAuth = () => true;
	runtime.checkAuth = async () => "fixture-key";
	const requests = [];
	session.agent.streamFunction = async (_model, context) => {
		requests.push(structuredClone(context.messages));
		return doneStream();
	};
	t.after(async () => {
		session.dispose();
		await rm(root, { recursive: true, force: true });
	});
	return { session, requests };
}

test("AgentSession request checkpoint runs after extension transforms, content policy and image conversion", async (t) => {
	const inputs = [];
	const policy = {
		filterSkills: async (items) => items,
		filterContext: async (items) =>
			items.map((item) => ({
				...item,
				content: item.content.map((part) =>
					part.type === "text" ? { ...part, text: part.text === "extension" ? "policy" : part.text } : part,
				),
			})),
	};
	const { session, requests } = await sessionFixture(
		t,
		{
			beforeRequest: (input) => {
				inputs.push(structuredClone(input));
				input.modelMessages[0].content = "ignored mutation";
			},
		},
		policy,
	);
	session._extensionRunner.emitContext = async (items) =>
		items.map((item) => ({
			...item,
			content: [
				{ type: "text", text: "extension" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
		}));
	await session.sendCustomMessage(
		{ customType: "fixture", content: [{ type: "text", text: "source" }], display: false, details: { id: "result" } },
		{ triggerTurn: true },
	);
	assert.equal(requests.length, 1);
	assert.equal(inputs.length, 1);
	assert.equal(inputs[0].sourceMessages[0].content[0].text, "source");
	assert.equal(inputs[0].transformedMessages[0].content[0].text, "policy");
	assert.equal(inputs[0].transformedMessages[0].content[1].type, "image");
	assert.equal(inputs[0].modelMessages[0].role, "user");
	assert.equal(inputs[0].modelMessages[0].details, undefined);
	assert.equal(inputs[0].modelMessages[0].content[1].text, "Image reading is disabled.");
	assert.deepEqual(requests[0], inputs[0].modelMessages);
});

test("AgentSession checkpoint rejection leaves history separate from transport admission", async (t) => {
	const { session, requests } = await sessionFixture(t, {
		beforeRequest: () => {
			throw new Error("Flow required input was filtered.");
		},
	});
	await session.sendCustomMessage({ customType: "fixture", content: "required", display: true }, { triggerTurn: true });
	assert.equal(requests.length, 0);
	assert.ok(
		session.sessionManager.getBranch().some((entry) => entry.type === "custom_message" && entry.content === "required"),
	);
	assert.equal(session.agent.state.messages.at(-1).stopReason, "error");
});

test("abort during final admission prevents a transport call and separate sessions have independent queues", async (t) => {
	const entered = deferred();
	const release = deferred();
	const first = await sessionFixture(t, {
		beforeRequest: async () => {
			entered.resolve();
			await release.promise;
		},
	});
	const second = await sessionFixture(t, {});
	const running = first.session.prompt("first");
	await entered.promise;
	const aborting = first.session.abort();
	await second.session.prompt("second");
	release.resolve();
	await running;
	await aborting;
	assert.equal(first.requests.length, 0);
	assert.equal(second.requests.length, 1);
});
