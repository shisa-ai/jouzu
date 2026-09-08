import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

export async function createFlowSession(t, { ingress, extensions = [], checkpoints, policy } = {}) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-session-"));
	let session;
	t.after(async () => {
		session?.dispose();
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
		model,
		sessionManager: SessionManager.inMemory(root),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		tools: [],
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
