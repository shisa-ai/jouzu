import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { JouzuPaths } from "../paths.js";
import { resolveProfileSelection } from "../runtime.js";
import { captureChildContext, type LaunchOptions } from "./context.js";
import { SubagentDashboard } from "./dashboard.js";
import { type AgentRun, SubagentManager, type WorkerFactory } from "./manager.js";
import { CHILD_EXTRA_TOOLS } from "./resources.js";
import {
	type AgentModel,
	type AgentRole,
	AgentRoleStore,
	digest,
	parseAgentConfig,
	type RoleSnapshot,
	resolveAgentModel,
} from "./roles.js";
import { readSessionTrace, type TraceQuery } from "./trace.js";
import { resolveWorkspace } from "./workspace.js";

export interface WorkflowService {
	roles(): RoleSnapshot;
	save(snapshot: RoleSnapshot): void;
	models(): AgentModel[];
	runs(): AgentRun[];
	read(id: string, offset?: number): { text: string; nextOffset: number | null; totalBytes: number };
	launch(roleId: string, task: string, options?: LaunchOptions): Promise<AgentRun>;
	trace(id?: string, options?: TraceQuery): Promise<unknown>;
	resume(id: string, task: string): Promise<AgentRun>;
	steer(id: string, text: string): string;
	stop(id: string): Promise<void>;
	activate(roleId: string): Promise<void>;
	activeRole(): string | undefined;
	subscribe(callback: () => void): () => void;
}
export function createWorkflowIntegration(
	paths: JouzuPaths,
	workerFactory?: WorkerFactory,
): {
	service: WorkflowService;
	register(pi: ExtensionAPI, open: (section?: "agents" | "runs") => Promise<boolean>): void;
} {
	const store = new AgentRoleStore(paths);
	const dashboard = new SubagentDashboard();
	let ctx: ExtensionContext | undefined;
	let api: ExtensionAPI | undefined;
	let manager: SubagentManager | undefined;
	let mainRole: AgentRole | undefined;
	const listeners = new Set<() => void>();
	let unsubscribe: (() => void) | undefined;
	let completionTimer: ReturnType<typeof setTimeout> | undefined;
	let completed: AgentRun[] = [];
	const summary = (run: AgentRun) => ({
		id: run.id,
		role: run.role.id,
		model: run.model,
		status: run.status,
		workspace: run.cwd,
		currentTool: run.currentTool,
		context: run.context,
		tools: run.tools,
		skills: run.skills,
		review: run.review,
		usage: run.usage,
		previousRunId: run.previousRunId,
		childSessionId: run.childSessionId,
		sessionFile: run.sessionFile,
	});
	const notify = () => {
		dashboard.update(manager?.list() ?? []);
		for (const listener of listeners) listener();
	};
	const context = () => {
		if (!ctx) throw new Error("Workflow requires an active session.");
		return ctx;
	};
	const controller = () => {
		if (!manager) throw new Error("Workflow requires an active session.");
		return manager;
	};
	const roles = () => store.load();
	const roleById = (id: string) => {
		const role = roles().config.roles.find((item) => item.id === id);
		if (!role) throw new Error("Agent definition was not found.");
		return role;
	};
	const dispatch = async (
		role: AgentRole,
		task: string,
		previousRunId?: string,
		modelSelector?: string,
		options: LaunchOptions = {},
	) => {
		const active = context();
		const targetManager = controller();
		// Validate routing before provider authentication or worker/model startup.
		const cwd = resolveWorkspace(active.cwd, previousRunId ? targetManager.get(previousRunId).cwd : options.workspace);
		const parentEntryId = active.sessionManager.getLeafId() ?? undefined;
		const childContext = previousRunId
			? undefined
			: captureChildContext(
					options,
					role.judging,
					active.sessionManager.getSessionId(),
					active.sessionManager.getBranch(),
					parentEntryId,
				);
		const model = resolveAgentModel(modelSelector ?? role.model, active.modelRegistry.getAvailable());
		const registered = active.modelRegistry.getRegisteredProviderConfig(model.provider);
		if (registered?.streamSimple)
			throw new Error(
				"Model: this provider uses an in-process extension. Choose a provider with a built-in API for child agents.",
			);
		const auth = await active.modelRegistry.getApiKeyAndHeaders(model);
		if (ctx !== active || manager !== targetManager)
			throw new Error("Session changed before the agent could start. Retry in this session.");
		if (!auth.ok) throw new Error("Authentication: sign in to the selected agent provider and retry.");
		if (auth.env && Object.keys(auth.env).length)
			throw new Error("Authentication: choose an API-key or token provider for child agents.");
		return targetManager.launch(
			{
				role,
				model,
				auth: {
					apiKey: auth.apiKey,
					headers: auth.headers as Record<string, string> | undefined,
					baseUrl: auth.baseUrl,
				},
				cwd,
				userAgentDir: paths.agentDir,
				runtimeStateDir: paths.stateDir,
				profile: resolveProfileSelection(paths).id,
				context: childContext,
				task,
			},
			parentEntryId,
			previousRunId,
		);
	};
	const service: WorkflowService = {
		roles,
		save(snapshot) {
			store.save(snapshot.config, snapshot.revision);
			notify();
		},
		models: () => context().modelRegistry.getAvailable(),
		runs: () => manager?.list() ?? [],
		read: (id, offset) => controller().read(id, offset),
		launch: (id, task, options) => dispatch(roleById(id), task, undefined, undefined, options),
		trace: (id, options) => {
			if (id) return controller().trace(id, options);
			const file = context().sessionManager.getSessionFile();
			if (!file) throw new Error("Trace: the parent session has no saved transcript yet.");
			return readSessionTrace(file, options);
		},
		resume(id, task) {
			const previous = controller().get(id);
			// The saved role revision and provider are immutable across a resumed run.
			return dispatch(previous.role, task, id, `${previous.model.provider}/${previous.model.id}`);
		},
		steer: (id, text) => controller().steer(id, text),
		stop: (id) => controller().stop(id),
		async activate(id) {
			const active = context();
			const role = roleById(id);
			if (role.placement === "child") throw new Error("Choose a definition that allows use in the main session.");
			if (!active.isIdle()) throw new Error("Wait for the main agent to finish before changing its role.");
			const model = resolveAgentModel(role.model, active.modelRegistry.getAvailable());
			if (!api || !(await api.setModel(model))) throw new Error("Model: authentication is unavailable for this role.");
			api.setThinkingLevel(role.thinking);
			mainRole = structuredClone(role);
			api.appendEntry("jouzu-main-role", { role: mainRole, revision: digest(mainRole) });
			notify();
		},
		activeRole: () => mainRole?.id,
		subscribe(callback) {
			listeners.add(callback);
			return () => listeners.delete(callback);
		},
	};
	return {
		service,
		register(pi, open) {
			api = pi;
			pi.registerCommand("subagents", {
				description: "Open child runs; use show or hide for the status pane",
				handler: async (args, active) => {
					const action = args.trim();
					if (action && action !== "show" && action !== "hide") {
						active.ui.notify("Use /subagents, /subagents show, or /subagents hide.", "warning");
						return;
					}
					if (active.mode !== "tui") {
						const output = JSON.stringify({ runs: service.runs().map(summary) });
						if (active.hasUI) active.ui.notify(output, "info");
						else console.log(output);
						return;
					}
					if (action) {
						dashboard.setVisible(action === "show");
						active.ui.notify(
							action === "show"
								? "Subagent pane enabled; it appears when this session has child runs."
								: "Subagent pane hidden. Use /subagents show to display it.",
							"info",
						);
					} else await open("runs");
				},
			});
			pi.registerCommand("workflow", {
				description: "Open agent definitions and child runs",
				handler: async (_args, active) => {
					if (active.mode !== "tui") {
						active.ui.notify(
							JSON.stringify({
								agents: roles().config.roles.map(({ id, model, placement }) => ({ id, model, placement })),
								runs: service.runs(),
							}),
							"info",
						);
						return;
					}
					await open();
				},
			});
			pi.on("session_start", async (_event, active) => {
				unsubscribe?.();
				clearTimeout(completionTimer);
				completed = [];
				dashboard.dispose();
				ctx = undefined;
				await manager?.dispose();
				ctx = active;
				dashboard.attach(active);
				mainRole = undefined;
				for (const entry of active.sessionManager.getBranch())
					if (entry.type === "custom" && entry.customType === "jouzu-main-role") {
						const saved = entry.data as { role?: AgentRole; revision?: string };
						try {
							if (saved?.role && saved.revision === digest(saved.role))
								mainRole = parseAgentConfig({ schemaVersion: 1, maxConcurrent: 1, roles: [saved.role] }).roles[0];
						} catch {}
					}
				let concurrency = 2;
				try {
					concurrency = roles().config.maxConcurrent;
				} catch {
					active.ui.notify(
						"Workflow: agents.json could not be loaded. Correct the configuration before launching agents.",
						"warning",
					);
				}
				manager = new SubagentManager(
					paths,
					active.sessionManager.getSessionId(),
					concurrency,
					workerFactory,
					(run) => {
						if (ctx !== active) return;
						completed.push(run);
						clearTimeout(completionTimer);
						completionTimer = setTimeout(() => {
							if (ctx !== active) return;
							const batch = completed;
							completed = [];
							pi.sendMessage(
								{
									customType: "jouzu-subagent-result",
									content: batch
										.map(
											(item) =>
												`Agent ${item.role.id} (${item.id}) ${item.status}. Workspace: ${item.cwd}\n${(item.result ?? "Read its output for details.").slice(0, 2000)}`,
										)
										.join("\n\n"),
									display: true,
									details: { runs: batch.map(summary) },
								},
								{
									deliverAs: "followUp",
									triggerTurn:
										batch.some((item) => item.status !== "cancelled" && item.status !== "interrupted") &&
										!active.hasPendingMessages(),
								},
							);
						}, 100);
					},
				);
				try {
					manager.attach();
				} catch (error) {
					active.ui.notify(error instanceof Error ? error.message : "Workflow storage is unavailable.", "warning");
				}
				unsubscribe = manager.subscribe(notify);
				notify();
			});
			pi.on("before_agent_start", (event, active) => {
				ctx = active;
				if (!mainRole) return;
				return { systemPrompt: `${event.systemPrompt}\n\nAgent role: ${mainRole.id}\n${mainRole.instructions}` };
			});
			pi.on("session_shutdown", async () => {
				dashboard.dispose();
				ctx = undefined;
				clearTimeout(completionTimer);
				completed = [];
				unsubscribe?.();
				await manager?.dispose();
				manager = undefined;
				mainRole = undefined;
			});
			const schema = {
				type: "object",
				properties: {
					op: { type: "string", enum: ["roles", "launch", "list", "read", "trace", "steer", "stop", "resume"] },
					role: { type: "string", description: "Role ID from op:roles." },
					task: {
						type: "string",
						description:
							"Bounded assignment. For review include requirements, candidate identity, scope, and check evidence, without the coder's reasoning.",
					},
					id: { type: "string", description: "Run ID. Omit only for trace of the parent session." },
					workspace: {
						type: "string",
						description:
							"Launch only: directory, absolute or relative to the parent cwd. Defaults to parent cwd; not a filesystem sandbox.",
					},
					context: {
						type: "string",
						enum: ["fresh", "fork", "splice"],
						description:
							"Launch only. Fresh (default): assignment only. Fork: inherit parent conversation as reference context. Splice: selected entryIds.",
					},
					entryIds: {
						type: "array",
						items: { type: "string" },
						minItems: 1,
						maxItems: 100,
						description: "Launch with splice: parent message/compaction entry IDs from trace.",
					},
					parentContext: {
						type: "boolean",
						description:
							"Launch only: allow parent_context snapshot lookup. Defaults to true, or false for review-only roles.",
					},
					query: { type: "string", description: "Trace: literal text search." },
					kind: { type: "string", enum: ["all", "messages", "tools", "errors", "compaction"] },
					entryId: { type: "string", description: "Trace: select one entry." },
					limit: { type: "integer", minimum: 1, maximum: 100 },
					offset: { type: "integer", minimum: 0 },
				},
				required: ["op"],
				additionalProperties: false,
			} as unknown as ToolDefinition["parameters"];
			pi.registerTool({
				name: "subagent",
				label: "Subagent",
				description:
					"Launch and control child agents with configured roles and models. Use roles first. Select workspace and fresh/fork/splice context on launch. Children have Jouzu skills, recall, web tools, and their own task list; they cannot delegate through tools. Launch returns immediately; completion arrives as an attributed follow-up. List shows workspace and activity. Read pages event previews; trace queries saved messages, tool arguments/results, errors, and compactions (omit id for parent history). Steer queues a message. Resume preserves the original workspace and child conversation; use a new launch to change workspace or context. Treat child output as evidence and verify the integrated result.",
				promptSnippet:
					"subagent: assign roles/models and workspaces, share context, query child traces, steer/stop/resume children.",
				parameters: schema,
				async execute(
					_id,
					params: LaunchOptions & TraceQuery & { op: string; role?: string; task?: string; id?: string },
				) {
					if (
						params.op !== "launch" &&
						[params.workspace, params.context, params.entryIds, params.parentContext].some(
							(value) => value !== undefined,
						)
					)
						throw new Error("Workspace and context options are launch-only. Start a new run to change them.");
					if (params.offset !== undefined && (!Number.isInteger(params.offset) || params.offset < 0))
						throw new Error("Offset must be a nonnegative integer.");
					let result: unknown;
					switch (params.op) {
						case "roles":
							result = roles().config.roles.map(({ id, description, model, placement, judging, tools }) => ({
								id,
								description,
								model,
								placement,
								judging,
								tools,
								additionalTools: CHILD_EXTRA_TOOLS,
							}));
							break;
						case "list":
							result = {
								runs: service
									.runs()
									.slice(params.offset ?? 0, (params.offset ?? 0) + 20)
									.map(summary),
								nextOffset: service.runs().length > (params.offset ?? 0) + 20 ? (params.offset ?? 0) + 20 : null,
							};
							break;
						case "launch":
							result = summary(await service.launch(params.role ?? "", params.task ?? "", params));
							break;
						case "read":
							result = service.read(params.id ?? "", params.offset);
							break;
						case "trace":
							result = await service.trace(params.id, {
								query: params.query,
								kind: params.kind,
								entryId: params.entryId,
								offset: params.offset,
								limit: params.limit,
							});
							break;
						case "steer":
							result = { receipt: service.steer(params.id ?? "", params.task ?? ""), status: "accepted" };
							break;
						case "stop":
							await service.stop(params.id ?? "");
							result = { status: "cancelled" };
							break;
						case "resume":
							result = summary(await service.resume(params.id ?? "", params.task ?? ""));
							break;
						default:
							throw new Error("Choose a supported subagent operation.");
					}
					return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
				},
			});
		},
	};
}
