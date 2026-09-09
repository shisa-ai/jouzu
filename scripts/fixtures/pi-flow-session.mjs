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
/** One scripted assistant turn issuing the tool calls a model would otherwise choose. */
export function assistantToolCalls(...calls) {
	return { toolCalls: calls };
}
function sseFor(reply) {
	const frames = [];
	if (reply?.toolCalls?.length) {
		frames.push({
			id: "fixture",
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: reply.toolCalls.map((call, index) => ({
							index,
							id: call.id ?? `call-${index}`,
							type: "function",
							function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
						})),
					},
					finish_reason: null,
				},
			],
		});
		frames.push({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
	} else {
		frames.push({
			id: "fixture",
			choices: [{ index: 0, delta: { content: reply?.text ?? "Done" }, finish_reason: "stop" }],
		});
	}
	return `${frames.map((frame) => `data: ${JSON.stringify(frame)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
}

export async function createQualifiedFlowSession(
	t,
	{ ingress, extensions = [], sessionManager, root: fixtureRoot, script, persist = false, settings = {} } = {},
) {
	const root = fixtureRoot ?? (await mkdtemp(join(tmpdir(), "jouzu-flow-qualified-")));
	const bodies = [];
	const replies = Array.isArray(script) ? [...script] : undefined;
	const server = createServer((request, response) => {
		let raw = "";
		request.on("data", (chunk) => {
			raw += chunk;
		});
		request.on("end", async () => {
			const body = JSON.parse(raw);
			bodies.push(body);
			// A script may return a promise, so a test can hold one request open and observe the
			// session while it is retrying or compacting.
			const reply = await (replies
				? replies.shift()
				: typeof script === "function"
					? script(body, bodies.length - 1)
					: undefined);
			// `httpStatus` drives Pi's own retry path; every other reply is a normal stream.
			if (reply?.httpStatus) {
				response.writeHead(reply.httpStatus, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "fixture failure" } }));
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(sseFor(reply));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	let session;
	let shutdownCalled = false;
	/**
	 * The teardown `AgentSessionRuntime` performs, in its order: settle the active turn, tell
	 * extensions the session is ending, then dispose (which disposes the flow ingress). Extensions
	 * that own child processes, such as the background task runner, only stop them on this event.
	 * Reason "resume" with a target file is the reopen path; "quit" is process exit.
	 */
	async function shutdown(reason = "quit", targetSessionFile) {
		if (shutdownCalled || !session) return;
		shutdownCalled = true;
		await session.abort();
		await session.extensionRunner.emit({
			type: "session_shutdown",
			reason,
			...(targetSessionFile ? { targetSessionFile } : {}),
		});
		await session.dispose();
	}
	t.after(async () => {
		await shutdown("quit");
		// Pi keeps its HTTP connections alive, so close() alone never resolves.
		server.closeAllConnections?.();
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
		sessionManager:
			sessionManager ??
			(persist ? cliPi.SessionManager.create(root, join(root, "history")) : cliPi.SessionManager.inMemory(root)),
		settingsManager: cliPi.SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: { enabled: false },
			...settings,
		}),
		flowIngress: ingress,
	}));
	// Not inspected by the route guard, which checks provider and handler identity only.
	runtime.hasConfiguredAuth = () => true;
	runtime.checkAuth = async () => "fixture-key";
	// The launcher emits this; extensions that connect their flow host on session_start, such as
	// multiloop, stay unattached without it.
	await session.extensionRunner.emit({ type: "session_start" });
	return { session, runtime, root, bodies, shutdown };
}
