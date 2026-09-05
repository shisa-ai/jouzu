import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	createExtensionRuntime,
	loadProjectContextFiles,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { WorkerCommand, WorkerEvent, WorkerLaunch } from "./protocol.js";

function boundedText(text: string, limit: number): string {
	return text.length > limit
		? `${text.slice(0, limit)}\n[Truncated; read the saved child session for the complete message.]`
		: text;
}
function send(event: WorkerEvent): void {
	if (process.connected) process.send?.(event);
}
/** Resolve existing ancestors too, so a new file cannot escape through a symlink. */
export function requireWorkspacePath(cwd: string, path: string): void {
	const root = realpathSync(cwd);
	let target = resolve(cwd, path);
	while (!existsSync(target)) {
		const parent = dirname(target);
		if (parent === target) break;
		target = parent;
	}
	const rel = relative(root, realpathSync(target));
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
		throw new Error("Access denied: the path is outside the assigned workspace.");
}
export function childResourceLoader(launch: WorkerLaunch): ResourceLoader {
	const entries = launch.role.judging ? [] : loadProjectContextFiles({ cwd: launch.cwd, agentDir: launch.directory });
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: entries }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [launch.role.instructions],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}
export async function runWorker(launch: WorkerLaunch, onSession: (session: AgentSession) => void): Promise<void> {
	const { model, auth, role } = launch;
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
	const { session, modelFallbackMessage } = await createAgentSession({
		cwd: launch.cwd,
		agentDir: launch.directory,
		modelRuntime: runtime,
		model: { ...model, headers: { ...model.headers, ...auth.headers }, baseUrl: auth.baseUrl ?? model.baseUrl },
		thinkingLevel: role.thinking,
		tools: role.tools,
		sessionManager,
		settingsManager,
		resourceLoader: childResourceLoader(launch),
	});
	if (modelFallbackMessage) throw new Error("Model: the requested model could not be restored.");
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
	// The child has no extensions. Enforce file-tool paths at the execution boundary.
	session.agent.beforeToolCall = async ({ toolCall, args }) => {
		if (!role.tools.includes(toolCall.name as (typeof role.tools)[number]))
			return { block: true, reason: "Access denied: tool is not in the role definition." };
		try {
			const path = (args as { path?: unknown })?.path;
			if (typeof path === "string") requireWorkspacePath(launch.cwd, path);
			if (++toolCount > role.maxTurns * 20) {
				exhausted = true;
				return { block: true, reason: "Tool limit reached. Report remaining work." };
			}
		} catch (error) {
			return { block: true, reason: error instanceof Error ? error.message : "Access denied." };
		}
		return undefined;
	};
	const unsubscribe = session.subscribe((event) => {
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
	send({ type: "ready", sessionFile: sessionManager.getSessionFile()!, sessionId: sessionManager.getSessionId() });
	try {
		await session.prompt(launch.task);
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
		session.dispose();
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
			.catch(() => {
				// Provider exceptions may contain headers or URLs. Keep diagnostics out of IPC/storage.
				send({
					type: "result",
					status: cancelled ? "cancelled" : "failed",
					text: cancelled
						? "Agent cancelled."
						: "Agent failed. Check the selected model and provider authentication, then retry.",
				});
			})
			.finally(() => {
				finished = true;
				process.disconnect?.();
			});
	});
}
