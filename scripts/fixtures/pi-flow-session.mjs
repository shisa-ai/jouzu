import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const model = {
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
export const assistant = () => ({
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
export const message = (text = "same") => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
export const tick = () => new Promise((resolve) => setImmediate(resolve));
export function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export async function createFlowSession(
	t,
	{
		ingress,
		extensions = [],
		checkpoints,
		policy,
		persist = false,
		shutdownExtensions = false,
		root: fixtureRoot,
		sessionManager,
		tools = [],
		model: selectedModel = model,
	} = {},
) {
	const root = fixtureRoot ?? (await mkdtemp(join(tmpdir(), "jouzu-flow-session-")));
	let session;
	t.after(async () => {
		if (session && shutdownExtensions) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		await session?.dispose();
		await rm(root, { recursive: true, force: true });
	});
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
		extensionFactories: extensions,
	});
	await loader.reload();
	({ session } = await createAgentSession({
		cwd: root,
		agentDir: root,
		resourceLoader: loader,
		modelRuntime: runtime,
		model: selectedModel,
		sessionManager:
			sessionManager ?? (persist ? SessionManager.create(root, join(root, "history")) : SessionManager.inMemory(root)),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		tools,
		flowIngress: ingress,
		flowCheckpoints: checkpoints,
	}));
	runtime.hasConfiguredAuth = () => true;
	runtime.checkAuth = async () => "fixture-key";
	const requests = [];
	session.agent.streamFunction = async (_model, context) => {
		requests.push(structuredClone(context.messages));
		const final = assistant();
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "done", partial: final };
			},
			result: async () => final,
		};
	};
	return { session, requests };
}

// The CLI bundle resolves its own Pi tree. The route guard compares runtime methods against
// ModelRuntime.prototype, so the fixture must build its runtime from that same module instance.
const cliPi = await import(
	pathToFileURL(
		join(import.meta.dirname, "../../packages/cli/node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
	).href
);

/**
 * A session whose provider route passes flow control's qualification: a real builtin
 * openai-completions provider over a local server, with Pi's own stream left in place so
 * `qualifyProviderRoute` observes the transport it captured at attach.
 */
export async function createQualifiedFlowSession(
	t,
	{ ingress, extensions = [], sessionManager, root: fixtureRoot } = {},
) {
	const root = fixtureRoot ?? (await mkdtemp(join(tmpdir(), "jouzu-flow-qualified-")));
	const bodies = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => {
			raw += chunk;
		});
		request.on("end", () => {
			bodies.push(JSON.parse(raw));
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
			);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	let session;
	t.after(async () => {
		await session?.dispose();
		await new Promise((resolve) => server.close(resolve));
		if (!fixtureRoot) await rm(root, { recursive: true, force: true });
	});
	const runtime = await cliPi.ModelRuntime.create({
		modelsPath: null,
		modelsStorePath: join(root, "models.json"),
		authPath: join(root, "auth.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	runtime.registerProvider("fixture", {
		api: "openai-completions",
		apiKey: "fixture-key",
		baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
		models: [
			{
				id: "fixture",
				name: "fixture",
				reasoning: false,
				input: ["text", "image"],
				contextWindow: 4096,
				maxTokens: 256,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	});
	const loader = new cliPi.DefaultResourceLoader({
		cwd: root,
		agentDir: root,
		noExtensions: true,
		noSkills: true,
		extensionFactories: extensions,
	});
	await loader.reload();
	({ session } = await cliPi.createAgentSession({
		cwd: root,
		agentDir: root,
		resourceLoader: loader,
		modelRuntime: runtime,
		model: runtime.getModel("fixture", "fixture"),
		sessionManager: sessionManager ?? cliPi.SessionManager.inMemory(root),
		settingsManager: cliPi.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		flowIngress: ingress,
	}));
	// Not inspected by the route guard, which checks provider and handler identity only.
	runtime.hasConfiguredAuth = () => true;
	runtime.checkAuth = async () => "fixture-key";
	return { session, runtime, root, bodies };
}
