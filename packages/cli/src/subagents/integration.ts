import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { preferCatalogModels } from "../model-catalog-projection.js";
import { createNotificationInbox } from "../notifications/inbox.js";
import type { JouzuPaths } from "../paths.js";
import {
	observedSubagentResults,
	SUBAGENT_RESULT,
	subagentCompletionBatch,
	terminalReadObservation,
} from "./completion.js";
import { type AgentRun, isActiveRun, SubagentManager, type WorkerFactory } from "./manager.js";
import { parseSubagentResult, runPresentation, subagentComponent } from "./render.js";
import {
	type AgentModel,
	type AgentRole,
	AgentRoleStore,
	digest,
	parseAgentConfig,
	type RoleSnapshot,
	resolveAgentModel,
} from "./roles.js";
import { resolveWorkspace } from "./workspace.js";

export interface WorkflowService {
	roles(): RoleSnapshot;
	save(snapshot: RoleSnapshot): void;
	models(): AgentModel[];
	runs(): AgentRun[];
	read(id: string, offset?: number): { text: string; nextOffset: number | null; totalBytes: number };
	launch(roleId: string, task: string, options?: { workspace?: string }): Promise<AgentRun>;
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
	options: { textguardFiles?: boolean } = {},
): { service: WorkflowService; register(pi: ExtensionAPI, open: () => Promise<boolean>): void } {
	const store = new AgentRoleStore(paths);
	let ctx: ExtensionContext | undefined;
	let sessionGeneration = 0;
	let api: ExtensionAPI | undefined;
	let manager: SubagentManager | undefined;
	let mainRole: AgentRole | undefined;
	const listeners = new Set<() => void>();
	let unsubscribe: (() => void) | undefined;

	const summary = (run: AgentRun) => ({
		id: run.id,
		role: run.role.id,
		model: run.model,
		status: run.status,
		workspace: run.cwd,
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
	const availableModels = () => {
		const registry = context().modelRegistry;
		const available = registry.getAvailable();
		return preferCatalogModels(available, typeof registry.getAll === "function" ? registry.getAll() : available);
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
		workspace?: string,
	) => {
		const active = context();
		const generation = sessionGeneration;
		const targetManager = controller();
		const cwd = resolveWorkspace(active.cwd, previousRunId ? targetManager.get(previousRunId).cwd : workspace);
		const model = resolveAgentModel(modelSelector ?? role.model, availableModels());
		const registered = active.modelRegistry.getRegisteredProviderConfig(model.provider);
		if (registered?.streamSimple)
			throw new Error(
				"Model: this provider uses an in-process extension. Choose a provider with a built-in API for child agents.",
			);
		const auth = await active.modelRegistry.getApiKeyAndHeaders(model);
		if (sessionGeneration !== generation || manager !== targetManager)
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
				task,
				textguardFiles: options.textguardFiles === true,
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
		models: availableModels,
		runs: () => manager?.list() ?? [],
		read: (id, offset) => controller().read(id, offset),
		launch: (id, task, options) => dispatch(roleById(id), task, undefined, undefined, options?.workspace),
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
			const model = resolveAgentModel(role.model, availableModels());
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
			const inbox = createNotificationInbox({
				pi,
				customType: SUBAGENT_RESULT,
				records: () => service.runs().flatMap((run) => (run.completion ? [{ id: run.id, ...run.completion }] : [])),
				save: (id, change) => controller().saveNotification(id, change),
				observed: (entries) => observedSubagentResults(service.runs(), entries),
				build: (batchId, records) =>
					subagentCompletionBatch(context().sessionManager.getSessionId(), batchId, records, service.runs()),
				reportError: () =>
					ctx?.ui.notify(
						"Agent notification delivery failed. Read the retained results with subagent list/read; reload when idle to retry.",
						"warning",
					),
			});
			pi.registerMessageRenderer("jouzu-subagent-result", (message, { expanded }, theme) => {
				const details = message.details as { presentation?: unknown; runs?: unknown } | undefined;
				return subagentComponent(details?.presentation ?? (details?.runs ? details : message.content), theme, expanded);
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
				const generation = ++sessionGeneration;
				unsubscribe?.();
				inbox.shutdown();
				ctx = undefined;
				await manager?.dispose();
				if (generation !== sessionGeneration) return;
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
				manager = new SubagentManager(paths, active.sessionManager.getSessionId(), concurrency, workerFactory, () => {
					if (generation !== sessionGeneration || !ctx) return;
					inbox.request();
				});
				try {
					manager.attach();
					inbox.start(active);
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
				sessionGeneration += 1;
				ctx = undefined;
				inbox.shutdown();
				unsubscribe?.();
				await manager?.dispose();
				manager = undefined;
				mainRole = undefined;
			});
			const schema = {
				type: "object",
				properties: {
					op: { type: "string", enum: ["roles", "launch", "list", "read", "steer", "stop", "resume", "acknowledge"] },
					role: { type: "string", description: "Role ID from op:roles." },
					batchId: {
						type: "string",
						description: "Current-run completion batch ID for op:acknowledge. Call alone when no reply is needed.",
					},
					task: {
						type: "string",
						description:
							"Bounded assignment. For review include requirements, candidate identity, scope, and check evidence, without the coder's reasoning.",
					},
					id: { type: "string", description: "Run ID returned by launch or list." },
					workspace: {
						type: "string",
						description:
							"Launch only: working directory, absolute or relative to the parent. Defaults to parent cwd; not a filesystem sandbox. For review, choose the repository whose candidate identity should be captured.",
					},
					offset: { type: "integer", minimum: 0 },
				},
				required: ["op"],
				additionalProperties: false,
			} as unknown as ToolDefinition["parameters"];
			pi.registerTool({
				name: "subagent",
				label: "Subagent",
				description:
					"Launch and control child agents with configured roles and models. Use roles first. Set workspace on launch to select the working directory and review candidate repository. File access follows enabled role tools and OS permissions, not a workspace fence. Launch returns immediately; unread terminal results arrive in a batch after active work and queued messages finish. Read returns bounded output with a byte offset; complete terminal-output reads prevent redundant completion turns. Use acknowledge with the delivered batchId alone when no reply is needed. Steer queues a message; resume starts a follow-up in the saved child session. Main-session ownership remains with you. Treat child output as evidence and verify the integrated result.",
				promptSnippet:
					"subagent: discover roles, delegate coding or fresh review, inspect results, steer/stop/resume children.",
				parameters: schema,
				renderCall(raw, theme) {
					const args = raw as { op?: string; role?: string };
					return subagentComponent(
						`Subagent · ${args?.op ?? "preparing"}${args?.role ? ` · ${args.role}` : ""}`,
						theme,
						false,
						"call",
					);
				},
				renderResult(result, { expanded }, theme, renderContext) {
					if (renderContext.isError)
						return subagentComponent(parseSubagentResult(result.content), theme, expanded, "error");
					const details = result.details as { presentation?: unknown } | undefined;
					return subagentComponent(
						details?.presentation ?? parseSubagentResult(result.content),
						theme,
						expanded,
						String((renderContext.args as { op?: string } | undefined)?.op ?? ""),
					);
				},
				async execute(
					_id,
					params: {
						op: string;
						role?: string;
						task?: string;
						id?: string;
						offset?: number;
						workspace?: string;
						batchId?: string;
					},
				) {
					if (params.workspace !== undefined && params.op !== "launch")
						throw new Error("Workspace is launch-only. Resume keeps the original workspace.");
					if (params.offset !== undefined && (!Number.isInteger(params.offset) || params.offset < 0))
						throw new Error("Offset must be a nonnegative integer.");
					if (params.op === "acknowledge") return inbox.acknowledge(params.batchId);
					let result: unknown;
					let presentation: unknown;
					switch (params.op) {
						case "roles":
							result = roles().config.roles.map(
								({ id, description, model, placement, judging, tools, maxTurns, timeoutSeconds }) => ({
									id,
									description,
									model,
									placement,
									judging,
									tools,
									maxTurns,
									timeoutSeconds,
								}),
							);
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
						case "launch": {
							const run = await service.launch(params.role ?? "", params.task ?? "", { workspace: params.workspace });
							result = summary(run);
							presentation = runPresentation(run);
							break;
						}
						case "read": {
							const output = service.read(params.id ?? "", params.offset);
							const run = controller().get(params.id ?? "");
							result = isActiveRun(run)
								? output
								: {
										...output,
										terminal: {
											status: run.status,
											summary: run.result?.slice(0, 2000),
											summaryTruncated: (run.result?.length ?? 0) > 2000,
										},
									};
							break;
						}
						case "steer":
							result = { receipt: service.steer(params.id ?? "", params.task ?? ""), status: "accepted" };
							break;
						case "stop":
							await service.stop(params.id ?? "");
							result = { status: "cancelled" };
							break;
						case "resume": {
							const run = await service.resume(params.id ?? "", params.task ?? "");
							result = summary(run);
							presentation = runPresentation(run);
							break;
						}
						default:
							throw new Error("Choose a supported subagent operation.");
					}
					if (params.op === "list")
						presentation = {
							...(result as object),
							runs: service
								.runs()
								.slice(params.offset ?? 0, (params.offset ?? 0) + 20)
								.map(runPresentation),
						};
					const content = [{ type: "text" as const, text: JSON.stringify(result) }];
					const terminalRead =
						params.op === "read"
							? terminalReadObservation(
									controller().get(params.id ?? ""),
									params.offset ?? 0,
									result as { nextOffset: number | null; totalBytes: number },
									content,
								)
							: undefined;
					return {
						content,
						details: { ...(presentation ? { presentation } : {}), ...(terminalRead ? { terminalRead } : {}) },
					};
				},
			});
		},
	};
}
