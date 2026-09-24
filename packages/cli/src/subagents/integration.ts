import {
	type ExtensionAPI,
	type ExtensionContext,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { FlowLedgerError } from "../flow-control/receipt-ledger.js";
import {
	SUBAGENT_READ_RECEIPT,
	SUBAGENT_READ_RECEIPTS,
	type SubagentReadReceipt,
	subagentReadReceiptKey,
} from "../flow-control/subagent-observation-extension.js";
import { SUBAGENT_WAIT_SOURCE, type SubagentWaitSourceRequest } from "../flow-control/subagent-waits.js";
import { preferCatalogModels } from "../model-catalog-projection.js";
import { createNotificationInbox } from "../notifications/inbox.js";
import type { JouzuPaths } from "../paths.js";
import type { TextGuardMode } from "../textguard-policy.js";
import {
	observedSubagentResults,
	SUBAGENT_RESULT,
	subagentCompletionBatch,
	terminalReadObservation,
} from "./completion.js";
import { captureChildContext, type LaunchOptions } from "./context.js";
import { SubagentDashboard } from "./dashboard.js";
import { type AgentRun, isActiveRun, SubagentManager, type WorkerFactory } from "./manager.js";
import { agentModelSelectorLabel } from "./model-display.js";
import { parseSubagentResult, runPresentation, subagentComponent } from "./render.js";
import {
	type AgentModel,
	type AgentRole,
	AgentRoleStore,
	digest,
	isSameModelSelector,
	parseAgentConfig,
	type RoleSnapshot,
	resolveAgentModel,
	SAME_MODEL,
} from "./roles.js";
import { readSessionTrace, type TraceQuery } from "./trace.js";
import { resolveWorkspace } from "./workspace.js";

export interface WorkflowService {
	subagentsEnabled(): boolean;
	setSubagentsEnabled(enabled: boolean): Promise<void>;
	roles(): RoleSnapshot;
	save(snapshot: RoleSnapshot): void;
	models(): AgentModel[];
	runs(): AgentRun[];
	read(id: string, offset?: number): { text: string; nextOffset: number | null; totalBytes: number };
	trace(id?: string, options?: TraceQuery): ReturnType<typeof readSessionTrace>;
	launch(roleId: string, task: string, options?: LaunchOptions): Promise<AgentRun>;
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
	options: { textguardFiles?: boolean; textguardMode?: () => TextGuardMode } = {},
): {
	service: WorkflowService;
	register(pi: ExtensionAPI, open: (section?: "agents" | "runs") => Promise<boolean>): void;
} {
	const dashboard = new SubagentDashboard();
	const store = new AgentRoleStore(paths);
	let ctx: ExtensionContext | undefined;
	let sessionGeneration = 0;
	let api: ExtensionAPI | undefined;
	let manager: SubagentManager | undefined;
	let mainRole: AgentRole | undefined;
	let subagentsEnabled = true;
	let settingChange: Promise<void> | undefined;
	let enableRevision = 0;
	const listeners = new Set<() => void>();
	let unsubscribe: (() => void) | undefined;

	const summary = (run: AgentRun) => ({
		id: run.id,
		role: run.role.id,
		model: run.model,
		status: run.status,
		workspace: run.cwd,
		context: run.context,
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
	const availableModels = () => {
		const registry = context().modelRegistry;
		const available = registry.getAvailable();
		return preferCatalogModels(available, typeof registry.getAll === "function" ? registry.getAll() : available);
	};
	const roles = () => store.load();
	/**
	 * Resolve a saved model selector for this session. `same` means the model the
	 * session is already using, and goes through the same validation as an explicit selector
	 * so catalog preference and the unavailable-model error still apply.
	 */
	const resolveModel = (selector: string) => {
		if (!isSameModelSelector(selector)) return resolveAgentModel(selector, availableModels());
		const current = context().model;
		if (!current)
			throw new Error(
				`Model: the role model is "${SAME_MODEL}", but this session has no model selected. Select a model, or give the role an explicit provider/model.`,
			);
		return resolveAgentModel(`${current.provider}/${current.id}`, availableModels());
	};
	const roleById = (id: string) => {
		const role = roles().config.roles.find((item) => item.id === id);
		if (!role) throw new Error("Agent definition was not found.");
		return role;
	};
	const requireSubagents = () => {
		if (!subagentsEnabled)
			throw new Error("Subagents are off for this session. The user can enable them in Workflow or with /workflow on.");
	};
	const dispatch = async (
		role: AgentRole,
		task: string,
		previousRunId?: string,
		modelSelector?: string,
		launchOptions: LaunchOptions = {},
	) => {
		requireSubagents();
		const revision = enableRevision;
		const active = context();
		const generation = sessionGeneration;
		const targetManager = controller();
		const cwd = resolveWorkspace(
			active.cwd,
			previousRunId ? targetManager.get(previousRunId).cwd : launchOptions.workspace,
		);
		const parentEntryId = active.sessionManager.getLeafId() ?? undefined;
		const childContext = previousRunId
			? undefined
			: captureChildContext(
					launchOptions,
					role.judging,
					active.sessionManager.getSessionId(),
					active.sessionManager.getBranch(),
					parentEntryId,
				);
		const model = resolveModel(modelSelector ?? role.model);
		const registered = active.modelRegistry.getRegisteredProviderConfig(model.provider);
		if (registered?.streamSimple)
			throw new Error(
				"Model: this provider uses an in-process extension. Choose a provider with a built-in API for child agents.",
			);
		const auth = await active.modelRegistry.getApiKeyAndHeaders(model);
		if (sessionGeneration !== generation || manager !== targetManager)
			throw new Error("Session changed before the agent could start. Retry in this session.");
		requireSubagents();
		if (revision !== enableRevision) throw new Error("Subagent setting changed before launch. Retry the assignment.");
		if (!auth.ok) throw new Error("Authentication: sign in to the selected agent provider and retry.");
		if (auth.env && Object.keys(auth.env).length)
			throw new Error("Authentication: choose an API-key or token provider for child agents.");
		const settings = SettingsManager.create(active.cwd, paths.agentDir);
		if (settings.drainErrors().length)
			throw new Error("Could not read cache-warming settings for the child. Check settings.json before retrying.");
		return targetManager.launch(
			{
				cacheWarming: settings.getCacheWarmingMode(),
				role,
				model,
				auth: {
					apiKey: auth.apiKey,
					headers: auth.headers as Record<string, string> | undefined,
					baseUrl: auth.baseUrl,
				},
				cwd,
				context: childContext,
				task,
				textguardFiles: options.textguardFiles === true,
				...(options.textguardMode ? { textguardMode: options.textguardMode() } : {}),
			},
			parentEntryId,
			previousRunId,
		);
	};
	const service: WorkflowService = {
		subagentsEnabled: () => subagentsEnabled,
		async setSubagentsEnabled(enabled) {
			context();
			if (settingChange) throw new Error("Wait for the subagent setting change to finish.");
			if (enabled === subagentsEnabled && (enabled || !service.runs().some(isActiveRun))) return;
			api?.appendEntry("jouzu-subagents-enabled", { enabled });
			subagentsEnabled = enabled;
			enableRevision++;
			notify();
			if (!enabled) {
				settingChange = controller().stopAll("Subagents disabled. Changes already made remain.");
				try {
					await settingChange;
				} finally {
					settingChange = undefined;
					notify();
				}
			}
		},
		roles,
		save(snapshot) {
			store.save(snapshot.config, snapshot.revision);
			notify();
		},
		models: availableModels,
		runs: () => manager?.list() ?? [],
		read: (id, offset) => controller().read(id, offset),
		trace: (id, options) => {
			if (id) return controller().trace(id, options);
			const file = context().sessionManager.getSessionFile();
			if (!file) throw new Error("Trace: the parent session has no saved transcript yet.");
			return readSessionTrace(file, options);
		},
		async launch(id, task, options) {
			requireSubagents();
			return dispatch(roleById(id), task, undefined, undefined, options);
		},
		async resume(id, task) {
			requireSubagents();
			const previous = controller().get(id);
			// The saved role revision and provider are immutable across a resumed run.
			return dispatch(previous.role, task, id, `${previous.model.provider}/${previous.model.id}`);
		},
		steer: (id, text) => {
			requireSubagents();
			return controller().steer(id, text);
		},
		stop: (id) => controller().stop(id),
		async activate(id) {
			const active = context();
			const role = roleById(id);
			if (role.placement === "child") throw new Error("Choose a definition that allows use in the main session.");
			if (!active.isIdle()) throw new Error("Wait for the main agent to finish before changing its role.");
			if (!api) throw new Error("Model: authentication is unavailable for this role.");
			// A "same" main role keeps the session's current model, so there is nothing to switch to.
			if (!isSameModelSelector(role.model)) {
				const model = resolveAgentModel(role.model, availableModels());
				if (!(await api.setModel(model))) throw new Error("Model: authentication is unavailable for this role.");
			}
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
			pi.events?.on(SUBAGENT_WAIT_SOURCE, (data) => {
				const request = data as SubagentWaitSourceRequest;
				if (typeof request?.accept !== "function" || typeof request.sessionId !== "string") return;
				request.accept({
					get(id) {
						// Attachment restores waits before session_start acquires the manager's lock.
						// Construction reads records only; the active manager later reports interruption.
						const owner =
							manager?.parentSessionId === request.sessionId
								? manager
								: new SubagentManager(paths, request.sessionId, 1, workerFactory);
						return owner.get(id);
					},
					subscribe: service.subscribe,
				});
			});
			const inbox = createNotificationInbox({
				pi,
				customType: SUBAGENT_RESULT,
				records: () => service.runs().flatMap((run) => (run.completion ? [{ id: run.id, ...run.completion }] : [])),
				save: (id, change) => controller().saveNotification(id, change),
				beforeReconcile: async () => {
					const active = context();
					const generation = sessionGeneration;
					let pending: Promise<SubagentReadReceipt[]> | undefined;
					let assertActive: (() => void) | undefined;
					pi.events?.emit(SUBAGENT_READ_RECEIPTS, {
						sessionId: active.sessionManager.getSessionId(),
						accept(receipts: Promise<SubagentReadReceipt[]>, check: () => void) {
							pending = receipts;
							assertActive = check;
						},
					});
					// Without final-input evidence, retain the completion notification.
					if (!pending || !assertActive) return;
					let receipts: SubagentReadReceipt[];
					try {
						receipts = await pending;
						if (generation !== sessionGeneration) return;
						assertActive();
					} catch (error) {
						if (error instanceof FlowLedgerError && (error.code === "stale" || error.code === "scope")) return;
						throw error;
					}
					const saved = new Set(
						active.sessionManager
							.getBranch()
							.flatMap((entry) =>
								entry.type === "custom" && entry.customType === SUBAGENT_READ_RECEIPT
									? [subagentReadReceiptKey(entry.data as SubagentReadReceipt)]
									: [],
							),
					);
					for (const receipt of receipts) {
						const key = subagentReadReceiptKey(receipt);
						if (saved.has(key)) continue;
						pi.appendEntry(SUBAGENT_READ_RECEIPT, receipt);
						saved.add(key);
					}
				},
				observed: (entries) => observedSubagentResults(service.runs(), entries, true),
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
			pi.registerCommand("subagents", {
				description: "Open child runs; use show or hide for the status pane",
				getArgumentCompletions: (prefix) =>
					["show", "hide"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
				handler: async (args, active) => {
					const action = args.trim();
					if (action && action !== "show" && action !== "hide") {
						active.ui.notify("Use /subagents, /subagents show, or /subagents hide.", "warning");
						return;
					}
					if (active.mode !== "tui") {
						const output = JSON.stringify({ runs: service.runs().map(summary) });
						if (active.mode === "print") console.log(output);
						else active.ui.notify(output, "info");
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
				description: "Open agents and runs; on/off/toggle controls subagents for this session",
				getArgumentCompletions: (prefix) =>
					["on", "off", "toggle"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
				handler: async (args, active) => {
					const action = args.trim();
					if (action) {
						if (!["on", "off", "toggle"].includes(action)) {
							active.ui.notify("Use /workflow, /workflow on, /workflow off, or /workflow toggle.", "error");
							return;
						}
						try {
							await service.setSubagentsEnabled(action === "toggle" ? !subagentsEnabled : action === "on");
							active.ui.notify(
								subagentsEnabled
									? "Subagents on for this session."
									: "Subagents off for this session. Queued and running children stopped; existing changes remain.",
								"info",
							);
						} catch (error) {
							active.ui.notify(error instanceof Error ? error.message : "Could not change subagent setting.", "error");
						}
						return;
					}
					if (active.mode !== "tui") {
						active.ui.notify(
							JSON.stringify({
								subagentsEnabled,
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
				dashboard.dispose();
				ctx = undefined;
				await manager?.dispose();
				if (generation !== sessionGeneration) return;
				ctx = active;
				dashboard.attach(active);
				mainRole = undefined;
				subagentsEnabled = true;
				for (const entry of active.sessionManager.getEntries()) {
					if (entry.type === "custom" && entry.customType === "jouzu-subagents-enabled") {
						const saved = entry.data as { enabled?: unknown } | undefined;
						if (typeof saved?.enabled === "boolean") subagentsEnabled = saved.enabled;
					}
				}
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
				let systemPrompt = event.systemPrompt;
				if (mainRole) systemPrompt += `\n\nAgent role: ${mainRole.id}\n${mainRole.instructions}`;
				if (subagentsEnabled)
					systemPrompt +=
						"\n\nSubagents are enabled. Before delegating, call subagent with op:roles to check live availability and current role definitions; the user can edit roles or disable subagents during the session. Use a role that allows child placement. Only the user can change role models in Workflow; do not override them or edit agent configuration to select another model. Write each assignment in complete sentences with normal spacing. Give one objective, verified context and file paths, constraints, acceptance checks, and an explicit stopping point and report. Separate dependent stages. For follow-ups, state what changed and what remains authorized. Diagnose provider, tool, and instruction failures before judging implementation quality; do not substitute another model.";
				if (!subagentsEnabled)
					systemPrompt +=
						"\n\nSubagents are disabled by the user for this session. Work directly; do not delegate or re-enable subagents. Existing results may be inspected and acknowledged.";
				return { systemPrompt };
			});
			pi.on("session_shutdown", async () => {
				dashboard.dispose();
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
					op: {
						type: "string",
						enum: ["roles", "launch", "list", "read", "trace", "steer", "stop", "resume", "acknowledge"],
					},
					role: { type: "string", description: "Role ID from op:roles." },
					batchId: {
						type: "string",
						description: "Current-run completion batch ID for op:acknowledge. Call alone when no reply is needed.",
					},
					task: {
						type: "string",
						description:
							"Assignment or follow-up in plain sentences: one objective, verified context/files, constraints, acceptance checks, and a stopping point/report. For review, name the candidate and provide requirements and check evidence without the implementer's reasoning.",
					},
					id: {
						type: "string",
						description: "Run ID returned by launch or list. Omit for trace of the parent session.",
					},
					workspace: {
						type: "string",
						description:
							"Launch working directory, absolute or relative to the parent; empty defaults to parent cwd. Not a filesystem sandbox. Ignored outside launch/resume; resume cannot change its saved directory. For review, selects the candidate repository.",
					},
					context: {
						type: "string",
						enum: ["fresh", "fork", "splice"],
						description:
							"Launch only. Fresh (default): assignment only. Fork: parent conversation as references. Splice: selected entryIds from the active parent branch.",
					},
					entryIds: {
						type: "array",
						items: { type: "string" },
						minItems: 1,
						maxItems: 100,
						description: "Launch with splice: message or compaction IDs from parent trace.",
					},
					parentContext: {
						type: "boolean",
						description:
							"Launch only: allow read-only parent_context snapshot lookup. Defaults to true, or false for review-only roles.",
					},
					query: { type: "string", description: "Trace: case-insensitive literal text search." },
					kind: { type: "string", enum: ["all", "messages", "tools", "errors", "compaction"] },
					entryId: { type: "string", description: "Trace: select one saved entry." },
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
					"Launch and control child agents with configured roles and models. Use roles before delegating to check live enabled status and current definitions. Only the user can change role models or the enable setting. Launch uses the configured role model; resume keeps its saved model. Set workspace on launch to select the working directory and review candidate repository. Launch context defaults to fresh; fork shares parent conversation as references, splice shares entryIds. parentContext enables snapshot lookup and defaults off for review-only roles. Resume retains the original snapshot. File access follows enabled role tools and OS permissions, not a workspace fence. Launch returns immediately; unread terminal results arrive in a batch after active work and queued messages finish. Read returns bounded output with a byte offset; complete terminal-output reads prevent redundant completion turns. Trace searches saved messages, tool arguments/results, errors, and compactions; omit id for parent history. Trace does not acknowledge completion. Use acknowledge with the delivered batchId alone when no reply is needed. Steer queues a message; resume starts a follow-up in the saved child session. Main-session ownership remains with you. Treat child output as evidence and verify the integrated result.",
				promptSnippet:
					"subagent: discover roles, delegate coding or fresh review, inspect results, steer/stop/resume children.",
				parameters: schema,
				// Strict providers derive a required-but-nullable form, so a model that declines an
				// operation-specific field sends null instead of a value nobody chose — a fabricated run
				// ID or role would steer the wrong child.
				constrainedSampling: { type: "json_schema", strict: "prefer" },
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
					params: LaunchOptions &
						TraceQuery & {
							op: string;
							role?: string;
							task?: string;
							id?: string;
							offset?: number;
							workspace?: string;
							batchId?: string;
						},
				) {
					if ("model" in params)
						throw new Error("Only the user can change subagent models in Workflow. Omit the model argument.");
					if (["launch", "resume", "steer"].includes(params.op)) requireSubagents();
					if (
						params.op !== "launch" &&
						[params.context, params.entryIds, params.parentContext].some((value) => value !== undefined)
					)
						throw new Error("Context options are launch-only. Resume keeps the original parent snapshot.");
					const workspace = params.workspace?.trim() ? params.workspace : undefined;
					if (params.op === "resume" && workspace) {
						const previous = controller().get(params.id ?? "");
						if (resolveWorkspace(context().cwd, workspace) !== previous.cwd)
							throw new Error("Resume keeps the original workspace. Launch a new agent to use another directory.");
					}
					if (params.offset !== undefined && (!Number.isInteger(params.offset) || params.offset < 0))
						throw new Error("Offset must be a nonnegative integer.");
					if (params.op === "acknowledge") return inbox.acknowledge(params.batchId);
					let result: unknown;
					let presentation: unknown;
					switch (params.op) {
						case "roles":
							result = {
								enabled: subagentsEnabled,
								...(!subagentsEnabled
									? {
											reason:
												"Subagents are disabled by the user for this session. Work directly; only the user should re-enable them.",
										}
									: {}),
								roles: roles().config.roles.map(
									({ id, description, model, placement, judging, tools, maxTurns, timeoutSeconds }) => ({
										id,
										description,
										model,
										modelLabel: agentModelSelectorLabel(model, availableModels()),
										placement,
										judging,
										tools,
										maxTurns,
										timeoutSeconds,
									}),
								),
							};
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
							const run = await service.launch(params.role ?? "", params.task ?? "", {
								workspace,
								context: params.context,
								entryIds: params.entryIds,
								parentContext: params.parentContext,
							});
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
