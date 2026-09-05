import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { JouzuPaths } from "../paths.js";
import { type AgentRun, SubagentManager, type WorkerFactory } from "./manager.js";
import {
	type AgentModel,
	type AgentRole,
	AgentRoleStore,
	digest,
	parseAgentConfig,
	type RoleSnapshot,
	resolveAgentModel,
} from "./roles.js";

export interface WorkflowService {
	roles(): RoleSnapshot;
	save(snapshot: RoleSnapshot): void;
	models(): AgentModel[];
	runs(): AgentRun[];
	read(id: string, offset?: number): { text: string; nextOffset: number | null; totalBytes: number };
	launch(roleId: string, task: string): Promise<AgentRun>;
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
): { service: WorkflowService; register(pi: ExtensionAPI, open: () => Promise<boolean>): void } {
	const store = new AgentRoleStore(paths);
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
		review: run.review,
		usage: run.usage,
		previousRunId: run.previousRunId,
		childSessionId: run.childSessionId,
		sessionFile: run.sessionFile,
	});
	const notify = () => {
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
	const dispatch = async (role: AgentRole, task: string, previousRunId?: string, modelSelector?: string) => {
		const active = context();
		const targetManager = controller();
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
				cwd: active.cwd,
				task,
			},
			active.sessionManager.getLeafId() ?? undefined,
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
		launch: (id, task) => dispatch(roleById(id), task),
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
				ctx = undefined;
				await manager?.dispose();
				ctx = active;
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
												`Agent ${item.role.id} (${item.id}) ${item.status}.\n${(item.result ?? "Read its output for details.").slice(0, 2000)}`,
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
					op: { type: "string", enum: ["roles", "launch", "list", "read", "steer", "stop", "resume"] },
					role: { type: "string", description: "Role ID from op:roles." },
					task: {
						type: "string",
						description:
							"Bounded assignment. For review include requirements, candidate identity, scope, and check evidence, without the coder's reasoning.",
					},
					id: { type: "string", description: "Run ID returned by launch or list." },
					offset: { type: "integer", minimum: 0 },
				},
				required: ["op"],
				additionalProperties: false,
			} as unknown as ToolDefinition["parameters"];
			pi.registerTool({
				name: "subagent",
				label: "Subagent",
				description:
					"Launch and control child agents with configured roles and models. Use roles first. Launch returns immediately; completion arrives as an attributed follow-up. Read returns bounded output with a byte offset. Steer queues a message; resume starts a follow-up in the saved child session. Main-session ownership remains with you. Treat child output as evidence and verify the integrated result.",
				promptSnippet:
					"subagent: discover roles, delegate coding or fresh review, inspect results, steer/stop/resume children.",
				parameters: schema,
				async execute(_id, params: { op: string; role?: string; task?: string; id?: string; offset?: number }) {
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
							result = summary(await service.launch(params.role ?? "", params.task ?? ""));
							break;
						case "read":
							result = service.read(params.id ?? "", params.offset);
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
