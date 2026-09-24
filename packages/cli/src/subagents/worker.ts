import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createFlowControlRuntime, type FlowControlRuntime } from "../flow-control/flow-runtime.js";
import { TextGuardRuntime } from "../textguard-runtime.js";
import { inheritedContextText, parentContextTool } from "./context.js";
import type { WorkerCommand, WorkerEvent, WorkerLaunch } from "./protocol.js";
import { configureChildResources, expandedChildResourceLoader } from "./resources.js";
import { observeChildBackgroundExecution, settleChildWork } from "./settle.js";

export { expandedChildResourceLoader as childResourceLoader } from "./resources.js";

function boundedText(text: string, limit: number): string {
	return text.length > limit
		? `${text.slice(0, limit)}\n[Truncated; read the saved child session for the complete message.]`
		: text;
}
function send(event: WorkerEvent): void {
	if (process.connected) process.send?.(event);
}
export async function runWorker(
	launch: WorkerLaunch,
	onSession: (session: AgentSession) => void,
	signal: AbortSignal = new AbortController().signal,
): Promise<void> {
	const cancelledSchedules = configureChildResources(launch, (text) => send({ type: "schedule_warning", text }));
	if (cancelledSchedules) send({ type: "schedules_cancelled", count: cancelledSchedules });
	const failure = new AbortController();
	const stop = AbortSignal.any([signal, failure.signal]);
	const flow = createFlowControlRuntime({
		root: join(launch.directory, "flow"),
		onError: (error) => failure.abort(error),
	});
	const textguard = new TextGuardRuntime({
		cachePath: join(launch.directory, "textguard-scans.json"),
		files: launch.textguardFiles,
		...(launch.textguardMode ? { mode: launch.textguardMode } : {}),
	});
	try {
		await runGuardedWorker(launch, onSession, textguard, flow, stop, failure);
	} finally {
		try {
			await flow.dispose();
		} finally {
			await textguard.close();
		}
	}
}

async function runGuardedWorker(
	launch: WorkerLaunch,
	onSession: (session: AgentSession) => void,
	textguard: TextGuardRuntime,
	flow: FlowControlRuntime,
	signal: AbortSignal,
	failureController: AbortController,
): Promise<void> {
	const { model, auth, role } = launch;
	const customTools =
		launch.context?.parentLookup && launch.parentContextFile ? [parentContextTool(launch.parentContextFile)] : [];
	const tools = [...role.tools, ...customTools.map((tool) => tool.name)];
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
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		compaction: { enabled: true },
		...(launch.cacheWarming ? { cacheWarming: launch.cacheWarming } : {}),
	});
	const sessionManager = launch.sessionFile
		? SessionManager.open(launch.sessionFile, launch.directory, launch.cwd)
		: SessionManager.create(launch.cwd, launch.directory);
	if (!launch.sessionFile && launch.context) {
		const inherited = inheritedContextText(launch.context);
		if (inherited) sessionManager.appendCustomMessageEntry("jouzu-parent-context", inherited, true);
	}
	let turns = 0;
	let exhausted = false;
	const resources = await expandedChildResourceLoader(
		launch,
		await textguard.createPolicy({ cwd: launch.cwd, sessionId: sessionManager.getSessionId() }),
		[
			...flow.extensions,
			{
				name: "jouzu-child-lifecycle",
				factory(pi) {
					pi.on("before_agent_start", () => {
						if (turns >= role.maxTurns) {
							exhausted = true;
							failureController.abort(new Error("Agent limit reached. Work is incomplete."));
						}
					});
					pi.on("tool_result", async (event) => {
						if (!event.isError && ["bg_task", "bash", "powershell"].includes(event.toolName))
							await observeChildBackgroundExecution(ingress, event.details);
					});
				},
			},
		],
	);
	tools.push(...resources.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]));
	const ingress = await flow.flowIngressFactory({ cwd: launch.directory, sessionManager });
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
		resourceLoader: resources,
		flowIngress: ingress,
	});
	let unsubscribe = () => {};
	const abort = () => {
		void session.abort();
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		if (modelFallbackMessage) throw new Error("Model: the requested model could not be restored.");
		await session.bindExtensions({ mode: "print", onError: (error) => failureController.abort(error) });
		signal.throwIfAborted();
		session.setActiveToolsByName([
			...tools,
			...resources.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]),
		]);
		onSession(session);
		if (!process.connected && process.send) throw new Error("Parent disconnected.");
		let lastText = "";
		let lastStop = "";
		let lastError = "";
		let toolCount = 0;
		// Roles control tools; the working directory is not a filesystem sandbox.
		const previousBeforeToolCall = session.agent.beforeToolCall;
		session.agent.beforeToolCall = async (input, toolSignal) => {
			if (!session.getActiveToolNames().includes(input.toolCall.name))
				return { block: true, reason: "Access denied: tool is not enabled for this child session." };
			try {
				if (++toolCount > role.maxTurns * 20) {
					exhausted = true;
					return { block: true, reason: "Tool limit reached. Report remaining work." };
				}
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : "Access denied." };
			}
			return previousBeforeToolCall?.(input, toolSignal);
		};
		unsubscribe = session.subscribe((event) => {
			if (event.type === "turn_start" && turns >= role.maxTurns) {
				exhausted = true;
				failureController.abort(new Error("Agent limit reached. Work is incomplete."));
			}
			if (event.type === "entry_appended" && event.entry.type === "usage") {
				const usage = event.entry.usage;
				send({
					type: "usage",
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					cost: Number.isFinite(usage.cost?.total) && usage.cost.total > 0 ? usage.cost.total : null,
				});
			}
			if (event.type === "tool_execution_start") send({ type: "activity", tool: event.toolName });
			if (event.type === "message_end") {
				const message = event.message;
				if (message.role === "assistant") {
					lastText = message.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n");
					lastStop = message.stopReason;
					// A provider failure records its cause here and nowhere else the parent can reach.
					// Without it a dead endpoint is reported as a bare "(error)" with no cause at all.
					lastError = message.stopReason === "error" ? (message.errorMessage ?? "").trim() : "";
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
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Worker session file was not created before reporting readiness.");
		send({
			type: "ready",
			sessionFile,
			sessionId: sessionManager.getSessionId(),
		});
		try {
			await session.prompt(launch.task);
			if (!exhausted) await settleChildWork(session, ingress, resources.compaction, signal);
		} catch (error) {
			// Admission also observes aborts. Preserve the role-limit outcome when
			// its cancellation interrupts a final context check.
			if (!exhausted) throw error;
		}
		const failed = exhausted || lastStop !== "stop" || !lastText.trim();
		// The parent only ever sees this text, so every cause the run recorded has to appear here.
		const failure = [
			`Agent stopped without a complete answer (${lastStop || "no response"}).`,
			lastError ? `Provider error: ${lastError.slice(0, 2000)}` : "",
			lastText.trim() ? `Partial response: ${lastText.slice(0, 2000)}` : "",
		]
			.filter(Boolean)
			.join(" ");
		send({
			type: "result",
			status: failed ? "failed" : "completed",
			text: exhausted ? "Agent limit reached. Work is incomplete." : failed ? failure : lastText.slice(0, 32_000),
		});
	} finally {
		unsubscribe();
		signal.removeEventListener("abort", abort);
		try {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			await session.dispose();
		}
	}
}

// Importable by tests; execution requires a private Node IPC channel.
if (process.send) {
	process.umask(0o077);
	let session: AgentSession | undefined;
	let started = false;
	let cancelled = false;
	const cancellation = new AbortController();
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
			cancellation.abort(new Error("Agent cancelled."));
			void session?.abort();
			return;
		}
		if (raw.type === "steer") {
			try {
				if (!session?.isStreaming) throw new Error();
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
		void runWorker(
			raw.launch,
			(value) => {
				session = value;
				if (cancelled) {
					value.dispose();
					throw new Error("Agent cancelled before startup.");
				}
			},
			cancellation.signal,
		)
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
