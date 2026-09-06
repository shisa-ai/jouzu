import {
	type AgentSession,
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { inheritedContextText, parentContextTool } from "./context.js";
import type { WorkerCommand, WorkerEvent, WorkerLaunch } from "./protocol.js";
import { childResourceLoader, configureChildResources } from "./resources.js";
import { resolveWorkspace } from "./workspace.js";

export { childResourceLoader } from "./resources.js";

class WorkerSetupError extends Error {}

function boundedText(text: string, limit: number): string {
	return text.length > limit
		? `${text.slice(0, limit)}\n[Truncated; read the saved child session for the complete message.]`
		: text;
}
function send(event: WorkerEvent): void {
	if (process.connected) process.send?.(event);
}
export async function runWorker(launch: WorkerLaunch, onSession: (session: AgentSession) => void): Promise<void> {
	const { model, auth, role } = launch;
	try {
		launch.cwd = resolveWorkspace(launch.cwd);
	} catch (error) {
		throw new WorkerSetupError((error as Error).message);
	}
	configureChildResources(launch);
	let resourceLoader: Awaited<ReturnType<typeof childResourceLoader>>;
	try {
		resourceLoader = await childResourceLoader(launch);
	} catch {
		throw new WorkerSetupError(
			"Resources: child capabilities could not load. Run jz doctor and repair the Jouzu installation.",
		);
	}
	const customTools =
		launch.context?.parentLookup && launch.parentContextFile ? [parentContextTool(launch.parentContextFile)] : [];
	const tools = [
		...new Set([
			...role.tools,
			...resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]),
			...customTools.map((tool) => tool.name),
		]),
	];
	// A closed credential store prevents discovery or mutation of the user's auth.json.
	const credentials = {
		read: async () => undefined,
		list: async () => [],
		modify: async () => undefined,
		delete: async () => {},
	};
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		modelsStorePath: `${launch.directory}/models-cache.json`,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	runtime.registerProvider(model.provider, {
		api: model.api,
		baseUrl: auth.baseUrl ?? model.baseUrl,
		headers: { ...model.headers, ...auth.headers },
		models: [{ ...model, headers: { ...model.headers, ...auth.headers }, baseUrl: auth.baseUrl ?? model.baseUrl }],
	});
	if (auth.apiKey) await runtime.setRuntimeApiKey(model.provider, auth.apiKey);
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true } });
	const sessionManager = launch.sessionFile
		? SessionManager.open(launch.sessionFile, launch.directory, launch.cwd)
		: SessionManager.create(launch.cwd, launch.directory);
	if (!launch.sessionFile && launch.context) {
		const inherited = inheritedContextText(launch.context);
		if (inherited) sessionManager.appendCustomMessageEntry("jouzu-parent-context", inherited, true);
	}
	const { session, modelFallbackMessage } = await createAgentSession({
		cwd: launch.cwd,
		agentDir: launch.directory,
		modelRuntime: runtime,
		model: { ...model, headers: { ...model.headers, ...auth.headers }, baseUrl: auth.baseUrl ?? model.baseUrl },
		thinkingLevel: role.thinking,
		tools,
		customTools,
		sessionManager,
		settingsManager,
		resourceLoader,
		sessionStartEvent: { type: "session_start", reason: launch.sessionFile ? "resume" : "startup" },
	});
	if (modelFallbackMessage) {
		session.dispose();
		throw new WorkerSetupError(
			"Model: the requested model could not be restored. Choose an available model in Workflow.",
		);
	}
	onSession(session);
	if (!process.connected && process.send) {
		session.dispose();
		throw new Error("Parent disconnected.");
	}
	let turns = 0;
	let exhausted = false;
	let lastText = "";
	let lastStop = "";
	let toolCount = 0;
	// Compose with Pi's hook: replacing it would bypass extension tool-call events.
	const beforeToolCall = session.agent.beforeToolCall;
	session.agent.beforeToolCall = async (call, signal) => {
		if (!tools.includes(call.toolCall.name))
			return { block: true, reason: "Tool unavailable: this child role does not enable it." };
		if (++toolCount > role.maxTurns * 20) {
			exhausted = true;
			return { block: true, reason: "Tool limit reached. Report remaining work.", terminate: true };
		}
		return beforeToolCall?.(call, signal);
	};
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "compaction_end")
			send({
				type: "diagnostic",
				category: "compaction",
				text: event.result
					? "Compaction completed."
					: event.aborted
						? "Compaction cancelled."
						: event.errorMessage?.includes("Nothing to compact")
							? "Compaction skipped: the session is too small."
							: "Compaction failed. Check the selected model and provider before retrying.",
			});
		if (event.type === "tool_execution_start") send({ type: "activity", tool: event.toolName });
		if (event.type === "message_end") {
			const message = event.message;
			if (message.role === "assistant") {
				lastText = message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				lastStop = message.stopReason;
				send({
					type: "message",
					role: "assistant",
					text: boundedText(lastText, 32_000),
					entryId: sessionManager.getLeafId() ?? undefined,
				});
				const usage = message.usage;
				send({
					type: "usage",
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					cost: Number.isFinite(usage.cost?.total) && usage.cost.total > 0 ? usage.cost.total : null,
				});
			}
			if (message.role === "toolResult") {
				send({
					type: "message",
					role: `tool:${message.toolName}`,
					text: message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n")
						.slice(0, 16_000),
					entryId: sessionManager.getLeafId() ?? undefined,
				});
			}
		}
		if (
			event.type === "turn_end" &&
			++turns >= role.maxTurns &&
			event.message.role === "assistant" &&
			event.message.content.some((part) => part.type === "toolCall")
		) {
			exhausted = true;
			void session.abort();
		}
	});
	try {
		await session.bindExtensions({
			mode: "print",
			onError: () =>
				send({
					type: "diagnostic",
					category: "extension",
					text: "An extension hook failed. Inspect child tool results and run jz doctor if capabilities are unavailable.",
				}),
		});
		send({
			type: "ready",
			sessionFile: sessionManager.getSessionFile()!,
			sessionId: sessionManager.getSessionId(),
			tools: session.getActiveToolNames(),
			skills: resourceLoader.getSkills().skills.map((skill) => skill.name),
		});
		await session.prompt(launch.task, { expandPromptTemplates: false });
		// A compact_context request can start a new run after prompt() resolves.
		do {
			await resourceLoader.compaction.waitForIdle();
			await session.waitForIdle();
		} while (resourceLoader.compaction.getState() !== "idle" || !session.isIdle);
		const failed = exhausted || lastStop !== "stop" || !lastText.trim();
		send({
			type: "result",
			status: failed ? "failed" : "completed",
			text: exhausted
				? "Agent limit reached. Work is incomplete."
				: failed
					? `Agent stopped without a complete answer (${lastStop || "no response"}). ${lastText.slice(0, 2000)}`
					: lastText.slice(0, 32_000),
		});
	} finally {
		unsubscribe();
		try {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			session.dispose();
		}
	}
}

// Importable by tests; execution requires a private Node IPC channel.
if (process.send) {
	process.umask(0o077);
	let session: AgentSession | undefined;
	let started = false;
	let cancelled = false;
	let finished = false;
	process.on("disconnect", () => {
		if (finished) return;
		cancelled = true;
		const fallback = setTimeout(() => process.exit(1), 2500);
		void (session?.abort() ?? Promise.resolve()).finally(() => {
			clearTimeout(fallback);
			process.exit(1);
		});
	});
	process.on("message", (raw: WorkerCommand) => {
		if (raw.type === "stop") {
			cancelled = true;
			void session?.abort();
			return;
		}
		if (raw.type === "steer") {
			try {
				if (!session || !session.isStreaming) throw new Error();
				void session.steer(raw.text).then(
					() => send({ type: "control", id: raw.id, status: "queued" }),
					() => send({ type: "control", id: raw.id, status: "rejected" }),
				);
			} catch {
				send({ type: "control", id: raw.id, status: "rejected" });
			}
			return;
		}
		if (raw.type !== "start" || started) return;
		started = true;
		void runWorker(raw.launch, (value) => {
			session = value;
			if (cancelled) {
				value.dispose();
				throw new Error("Agent cancelled before startup.");
			}
		})
			.catch((error: unknown) => {
				// Provider exceptions may contain headers or URLs. Keep diagnostics out of IPC/storage.
				send({
					type: "result",
					status: cancelled ? "cancelled" : "failed",
					text: cancelled
						? "Agent cancelled."
						: error instanceof WorkerSetupError
							? error.message
							: "Model/provider: the child request failed. Check the selected model, endpoint, and authentication, then retry. Provider details are withheld because they may contain credentials.",
				});
			})
			.finally(() => {
				finished = true;
				process.disconnect?.();
			});
	});
}
