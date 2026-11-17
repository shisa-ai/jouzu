import {
	type ExtensionAPI,
	type ExtensionContext,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { CatalogMessageId, catalogText, defaultCatalog } from "../cli-messages.js";
import { FlowLedgerError } from "../flow-control/receipt-ledger.js";
import {
	SUBAGENT_READ_RECEIPT,
	SUBAGENT_READ_RECEIPTS,
	type SubagentReadReceipt,
	subagentReadReceiptKey,
} from "../flow-control/subagent-observation-extension.js";
import { SUBAGENT_WAIT_SOURCE, type SubagentWaitSourceRequest } from "../flow-control/subagent-waits.js";
import { readStoredLanguageContractState } from "../language-contract.js";
import type { CatalogBundle } from "../locale-catalog.js";
import { preferCatalogModels } from "../model-catalog-projection.js";
import { createNotificationInbox } from "../notifications/inbox.js";
import type { JouzuPaths } from "../paths.js";
import { promptCapabilities } from "../prompt-capabilities.js";
import { setPromptSections } from "../prompt-sections.js";
import type { TextGuardMode } from "../textguard-policy.js";
import {
	observedSubagentResults,
	SUBAGENT_RESULT,
	subagentCompletionBatch,
	terminalReadObservation,
} from "./completion.js";
import { captureChildContext, type LaunchOptions } from "./context.js";
import { SubagentDashboard } from "./dashboard.js";
import { roleLanguageContract } from "./language.js";
import { type AgentRun, isActiveRun, SubagentManager, type WorkerFactory } from "./manager.js";
import { agentModelSelectorLabel } from "./model-display.js";
import { parseSubagentResult, runPresentation, subagentComponent } from "./render.js";
import {
	type AgentModel,
	type AgentRole,
	AgentRoleStore,
	DEFAULT_WORKSPACE_WRITERS,
	defaultAgentConfig,
	digest,
	isSameModelSelector,
	parseAgentConfig,
	type RoleSnapshot,
	resolveAgentModel,
	resolveAgentThinking,
	SAME_MODEL,
	type WorkspaceWriterPolicy,
} from "./roles.js";
import { readSessionTrace, type TraceQuery } from "./trace.js";
import { resolveWorkspace } from "./workspace.js";

export interface WorkflowService {
	sessionId(): string | undefined;
	/** Parent session working directory, the default child workspace. */
	cwd(): string;
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
/** The catalog ID the subagent tool label reads its display text from. */
const SUBAGENT_LABEL_ID = "jouzu.cli.tool.subagent.label";

export function createWorkflowIntegration(
	paths: JouzuPaths,
	workerFactory?: WorkerFactory,
	options: {
		textguardFiles?: boolean;
		textguardMode?: () => TextGuardMode;
		profile?: () => "core" | "ja";
		dashboardVisibility?: (visible: boolean) => void;
		/** The resolved catalog the subagent result renderer reads its display text from. */
		catalog?: CatalogBundle;
	} = {},
): {
	service: WorkflowService;
	register(pi: ExtensionAPI, open: (section?: "agents" | "runs") => Promise<boolean>): void;
} {
	const catalog = options.catalog ?? defaultCatalog();
	const dashboard = new SubagentDashboard(catalog);
	const store = new AgentRoleStore(paths, catalog);
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
		thinking: run.thinkingLevel ?? run.role.thinking,
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
		if (!ctx) throw new Error(catalogText(catalog, CatalogMessageId.subagentWorkflowRequiresSession));
		return ctx;
	};
	const controller = () => {
		if (!manager) throw new Error(catalogText(catalog, CatalogMessageId.subagentWorkflowRequiresSession));
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
		if (!isSameModelSelector(selector)) return resolveAgentModel(selector, availableModels(), catalog);
		const current = context().model;
		if (!current)
			throw new Error(catalogText(catalog, CatalogMessageId.subagentSameModelNoSession, { model: SAME_MODEL }));
		return resolveAgentModel(`${current.provider}/${current.id}`, availableModels(), catalog);
	};
	const roleById = (id: string) => {
		const role = roles().config.roles.find((item) => item.id === id);
		if (!role) throw new Error(catalogText(catalog, CatalogMessageId.subagentAgentDefinitionNotFound));
		return role;
	};
	const requireSubagents = () => {
		if (!subagentsEnabled) throw new Error(catalogText(catalog, CatalogMessageId.subagentDisabledForSession));
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
			catalog,
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
					catalog,
				);
		const model = resolveModel(modelSelector ?? role.model);
		const thinkingLevel = resolveAgentThinking(role.thinking, api?.getThinkingLevel?.(), catalog);
		const registered = active.modelRegistry.getRegisteredProviderConfig(model.provider);
		if (registered?.streamSimple) throw new Error(catalogText(catalog, CatalogMessageId.subagentProviderInProcess));
		const auth = await active.modelRegistry.getApiKeyAndHeaders(model);
		if (sessionGeneration !== generation || manager !== targetManager)
			throw new Error(catalogText(catalog, CatalogMessageId.subagentSessionChangedBeforeStart));
		requireSubagents();
		if (revision !== enableRevision)
			throw new Error(catalogText(catalog, CatalogMessageId.subagentSettingChangedBeforeLaunch));
		if (!auth.ok) throw new Error(catalogText(catalog, CatalogMessageId.subagentAuthenticationSignIn));
		if (auth.env && Object.keys(auth.env).length)
			throw new Error(catalogText(catalog, CatalogMessageId.subagentAuthenticationApiKeyProvider));
		const settings = SettingsManager.create(active.cwd, paths.agentDir);
		if (settings.drainErrors().length)
			throw new Error(catalogText(catalog, CatalogMessageId.subagentCacheWarmingSettingsUnreadable));
		const profile = options.profile?.() ?? "core";
		return targetManager.launch(
			{
				cacheWarming: settings.getCacheWarmingMode(),
				role,
				model,
				thinkingLevel,
				auth: {
					apiKey: auth.apiKey,
					headers: auth.headers as Record<string, string> | undefined,
					baseUrl: auth.baseUrl,
				},
				cwd,
				userAgentDir: paths.agentDir,
				runtimeStateDir: paths.stateDir,
				runtimeCacheDir: paths.cacheDir,
				profile,
				// Resolve active caller preferences, not a staged Settings change, on launch and resume.
				// The manager freezes this launch contract; later parent changes cannot reach it.
				languageContract: roleLanguageContract(role, readStoredLanguageContractState(active)?.contract, profile),
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
		sessionId: () => (ctx && manager ? manager.parentSessionId : undefined),
		cwd: () => context().cwd,
		subagentsEnabled: () => subagentsEnabled,
		async setSubagentsEnabled(enabled) {
			context();
			if (settingChange) throw new Error(catalogText(catalog, CatalogMessageId.subagentSettingChangeInProgress));
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
			const saved = store.save(snapshot.config, snapshot.revision);
			manager?.setConcurrency(saved.config.maxConcurrent);
			manager?.setWorkspaceWriters(saved.config.workspaceWriters);
			notify();
		},
		models: availableModels,
		runs: () => manager?.list() ?? [],
		read: (id, offset) => controller().read(id, offset),
		trace: (id, options) => {
			if (id) return controller().trace(id, options);
			const file = context().sessionManager.getSessionFile();
			if (!file) throw new Error(catalogText(catalog, CatalogMessageId.subagentParentTranscriptUnavailable));
			return readSessionTrace(file, options, catalog);
		},
		async launch(id, task, options) {
			requireSubagents();
			return dispatch(roleById(id), task, undefined, undefined, options);
		},
		async resume(id, task) {
			requireSubagents();
			const previous = controller().get(id);
			// Saved selectors remain authoritative; inherited settings follow the parent.
			return dispatch(
				previous.role,
				task,
				id,
				isSameModelSelector(previous.role.model) ? SAME_MODEL : `${previous.model.provider}/${previous.model.id}`,
			);
		},
		steer: (id, text) => {
			requireSubagents();
			return controller().steer(id, text);
		},
		stop: (id) => controller().stop(id),
		async activate(id) {
			const active = context();
			const role = roleById(id);
			if (role.placement === "child")
				throw new Error(catalogText(catalog, CatalogMessageId.subagentMainPlacementRequired));
			if (!active.isIdle()) throw new Error(catalogText(catalog, CatalogMessageId.subagentMainRoleIdleRequired));
			if (!api) throw new Error(catalogText(catalog, CatalogMessageId.subagentRoleAuthenticationUnavailable));
			// A "same" main role keeps the session's current model, so there is nothing to switch to.
			if (!isSameModelSelector(role.model)) {
				const model = resolveAgentModel(role.model, availableModels(), catalog);
				if (!(await api.setModel(model)))
					throw new Error(catalogText(catalog, CatalogMessageId.subagentRoleAuthenticationUnavailable));
			}
			if (role.thinking !== "same") api.setThinkingLevel(role.thinking);
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
								: new SubagentManager(paths, request.sessionId, 1, workerFactory, undefined, catalog);
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
					subagentCompletionBatch(context().sessionManager.getSessionId(), batchId, records, service.runs(), catalog),
				reportError: () =>
					ctx?.ui.notify(catalogText(catalog, CatalogMessageId.subagentNotificationDeliveryFailed), "warning"),
			});
			pi.registerMessageRenderer("jouzu-subagent-result", (message, { expanded }, theme) => {
				const details = message.details as { presentation?: unknown; runs?: unknown } | undefined;
				return subagentComponent(
					details?.presentation ?? (details?.runs ? details : message.content),
					theme,
					expanded,
					"",
					catalog,
				);
			});
			pi.registerCommand("subagents", {
				description: catalogText(catalog, CatalogMessageId.subagentCommandDescription),
				getArgumentCompletions: (prefix) =>
					["show", "hide"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
				handler: async (args, active) => {
					const action = args.trim();
					if (action && action !== "show" && action !== "hide") {
						active.ui.notify(catalogText(catalog, CatalogMessageId.subagentCommandHint), "warning");
						return;
					}
					if (active.mode !== "tui") {
						const output = JSON.stringify({ runs: service.runs().map(summary) });
						if (active.mode === "print") console.log(output);
						else active.ui.notify(output, "info");
						return;
					}
					if (action) {
						if (options.dashboardVisibility) {
							options.dashboardVisibility(action === "show");
							active.ui.notify(
								action === "show"
									? catalogText(catalog, CatalogMessageId.subagentDashboardRestored)
									: catalogText(catalog, CatalogMessageId.subagentDashboardHidden),
								"info",
							);
							return;
						}
						dashboard.setVisible(action === "show");
						active.ui.notify(
							action === "show"
								? catalogText(catalog, CatalogMessageId.subagentPaneEnabled)
								: catalogText(catalog, CatalogMessageId.subagentPaneHidden),
							"info",
						);
					} else await open("runs");
				},
			});
			pi.registerCommand("workflow", {
				description: catalogText(catalog, CatalogMessageId.subagentWorkflowCommandDescription),
				getArgumentCompletions: (prefix) =>
					["on", "off", "toggle"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
				handler: async (args, active) => {
					const action = args.trim();
					if (action) {
						if (!["on", "off", "toggle"].includes(action)) {
							active.ui.notify(catalogText(catalog, CatalogMessageId.subagentWorkflowCommandHint), "error");
							return;
						}
						try {
							await service.setSubagentsEnabled(action === "toggle" ? !subagentsEnabled : action === "on");
							active.ui.notify(
								subagentsEnabled
									? catalogText(catalog, CatalogMessageId.subagentEnabledNotice)
									: catalogText(catalog, CatalogMessageId.subagentDisabledNotice),
								"info",
							);
						} catch (error) {
							active.ui.notify(
								error instanceof Error
									? error.message
									: catalogText(catalog, CatalogMessageId.subagentSettingChangeFailed),
								"error",
							);
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
				if (!options.dashboardVisibility) dashboard.attach(active);
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
								mainRole = parseAgentConfig({ schemaVersion: 1, maxConcurrent: 1, roles: [saved.role] }, catalog)
									.roles[0];
						} catch {}
					}
				let concurrency = defaultAgentConfig().maxConcurrent;
				let workspaceWriters: WorkspaceWriterPolicy = DEFAULT_WORKSPACE_WRITERS;
				try {
					const config = roles().config;
					concurrency = config.maxConcurrent;
					workspaceWriters = config.workspaceWriters;
				} catch {
					active.ui.notify(catalogText(catalog, CatalogMessageId.subagentWorkflowAgentsUnreadable), "warning");
				}
				manager = new SubagentManager(
					paths,
					active.sessionManager.getSessionId(),
					concurrency,
					workerFactory,
					() => {
						if (generation !== sessionGeneration || !ctx) return;
						inbox.request();
					},
					catalog,
				);
				try {
					manager.attach();
					// Apply the saved writer policy only once this process owns the session.
					manager.setWorkspaceWriters(workspaceWriters);
					inbox.start(active);
				} catch (error) {
					active.ui.notify(
						error instanceof Error
							? error.message
							: catalogText(catalog, CatalogMessageId.subagentWorkflowStorageUnavailable),
						"warning",
					);
				}
				unsubscribe = manager.subscribe(notify);
				notify();
			});
			pi.on("before_agent_start", (event, active) => {
				ctx = active;
				const role = mainRole ? `Agent role: ${mainRole.id}\n${mainRole.instructions}` : undefined;
				const available = promptCapabilities(event.systemPromptOptions, { subagentsEnabled });
				// Filtering the prompt index does not remove explicit skill commands or saved results.
				event.systemPromptOptions.skills = available.skills;
				const subagents = !available.tools.has("subagent")
					? undefined
					: subagentsEnabled
						? "Use subagent op:roles before delegation; choose a role allowing child placement. Roles can change. Only the user changes role models or enables subagents; do not edit agent configuration to choose a model. Give each child one objective, verified context and paths, constraints, acceptance checks, and an explicit stopping point and report. Use complete sentences. Separate dependent stages; state what changed and remains authorized in follow-ups. Diagnose provider, tool, and instruction failures before judging implementation; do not substitute another model."
						: "Subagents are disabled by the user. Work directly; do not delegate or re-enable them. Existing results may be inspected and acknowledged.";
				return setPromptSections(event, { agent_role: role, subagents });
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
						description:
							"Fields by operation: roles: none; list: offset?; launch: role, task; read/stop: id; resume/steer: id, task; acknowledge: batchId. Trace: id? (omit for parent), query?, kind?, entryId?, offset?, limit?. Read also accepts offset.",
					},
					role: {
						type: "string",
						description:
							"Role ID from op:roles. A name the user gives that op:roles does not list may be a model; choose a listed role and tell the user that role models are set in Workflow.",
					},
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
							"Launch working directory; defaults to parent cwd. For review, selects the candidate repository. Resume keeps its saved directory; omit this field.",
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
						description:
							"Launch with splice only: 1–100 IDs returned by parent trace. For fresh or fork, omit entryIds (or use null); never supply an empty array or placeholder IDs.",
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
			// Declare null at registration rather than relying on a provider to add it.
			// Type unions preserve strict-provider support for nullable arrays.
			const properties = (
				schema as unknown as {
					properties: Record<string, { type: string | string[]; enum?: unknown[]; [key: string]: unknown }>;
				}
			).properties;
			for (const [key, property] of Object.entries(properties)) {
				if (key === "op") continue;
				property.type = [property.type as string, "null"];
				if (property.enum) property.enum = [...property.enum, null];
			}
			pi.registerTool({
				name: "subagent",
				exposure: "model-only",
				label: catalogText(catalog, SUBAGENT_LABEL_ID),
				description:
					'Launch and control child agents. Start with {"op":"roles"} for live availability and role definitions. Omit unused fields; use null only if required by the interface. A launch needs only op, role, and task; context defaults to fresh. Never invent IDs or placeholder values. Only the user changes role models or enables subagents. Launch uses the configured model; resume keeps its saved role, workspace, and context. A same model or thinking setting follows the current main session on launch and resume. Steer queues a message; resume starts a follow-up. File access follows enabled tools and OS permissions, not a workspace fence. Launch returns immediately; unread terminal results arrive in a batch after active work and queued messages finish. Read pages use byte offsets; reading all terminal output prevents redundant completion turns. Trace searches saved messages, tool calls/results, errors, and compactions without acknowledging completion. Acknowledge only the delivered batchId, alone, when no reply is needed. You retain main-session ownership; verify child output before accepting it.',
				promptSnippet:
					"subagent: discover roles, delegate coding or fresh review, inspect results, steer/stop/resume children.",
				parameters: schema,
				// Strict providers may require every field; unused nullable fields mean omission.
				constrainedSampling: { type: "json_schema", strict: "prefer" },
				renderCall(raw, theme) {
					const args = raw as { op?: string; role?: string };
					const operation = args?.op ?? catalogText(catalog, CatalogMessageId.subagentCallPreparing);
					return subagentComponent(
						`${catalogText(catalog, CatalogMessageId.subagentCallLabel, { operation })}${args?.role ? ` · ${args.role}` : ""}`,
						theme,
						false,
						"call",
						catalog,
					);
				},
				renderResult(result, { expanded }, theme, renderContext) {
					if (renderContext.isError)
						return subagentComponent(parseSubagentResult(result.content), theme, expanded, "error", catalog);
					const details = result.details as { presentation?: unknown } | undefined;
					return subagentComponent(
						details?.presentation ?? parseSubagentResult(result.content),
						theme,
						expanded,
						String((renderContext.args as { op?: string } | undefined)?.op ?? ""),
						catalog,
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
					if ("model" in params) throw new Error(catalogText(catalog, CatalogMessageId.subagentModelArgumentUserOnly));
					// Strict providers use null for omitted optional fields. Normalize a copy so
					// validation and downstream services see the same omission semantics.
					params = Object.fromEntries(
						Object.entries(params).filter(([key, value]) => key === "op" || value !== null),
					) as typeof params;
					const requiredFields: Record<string, string[]> = {
						launch: ["role", "task"],
						read: ["id"],
						stop: ["id"],
						resume: ["id", "task"],
						steer: ["id", "task"],
						acknowledge: ["batchId"],
					};
					for (const field of requiredFields[params.op] ?? []) {
						const value = (params as unknown as Record<string, unknown>)[field];
						if (typeof value === "string" && value.trim()) continue;
						const hint =
							field === "role"
								? catalogText(catalog, CatalogMessageId.subagentFieldHintRole, { command: '{"op":"roles"}' })
								: field === "id"
									? catalogText(catalog, CatalogMessageId.subagentFieldHintRunId, { command: '{"op":"list"}' })
									: field === "batchId"
										? catalogText(catalog, CatalogMessageId.subagentFieldHintBatchId)
										: catalogText(catalog, CatalogMessageId.subagentFieldHintTask);
						throw new Error(
							catalogText(catalog, CatalogMessageId.subagentFieldRequired, {
								op: params.op,
								field,
								hint,
							}),
						);
					}
					if (["launch", "resume", "steer"].includes(params.op)) requireSubagents();
					if (
						params.op === "resume" &&
						[params.context, params.entryIds, params.parentContext].some((value) => value !== undefined)
					)
						throw new Error(catalogText(catalog, CatalogMessageId.subagentResumeContextOmit));
					// Other operations do not consume launch context. Providers may still fill
					// those fields when sampling this shared schema; do not block discovery.
					const workspace = params.workspace?.trim() ? params.workspace : undefined;
					if (params.op === "resume" && workspace) {
						const previous = controller().get(params.id ?? "");
						if (resolveWorkspace(context().cwd, workspace, catalog) !== previous.cwd)
							throw new Error(catalogText(catalog, CatalogMessageId.subagentResumeWorkspaceKeep));
					}
					if (params.offset !== undefined && (!Number.isInteger(params.offset) || params.offset < 0))
						throw new Error(catalogText(catalog, CatalogMessageId.subagentOffsetNonnegative));
					if (params.op === "acknowledge") return inbox.acknowledge(params.batchId);
					let result: unknown;
					let presentation: unknown;
					switch (params.op) {
						case "roles": {
							const config = roles().config;
							result = {
								enabled: subagentsEnabled,
								...(!subagentsEnabled
									? {
											reason: catalogText(catalog, CatalogMessageId.subagentRolesDisabledReason),
										}
									: {}),
								maxConcurrent: config.maxConcurrent,
								workspaceWriters: config.workspaceWriters,
								roles: config.roles.map(
									({ id, description, model, thinking, placement, judging, tools, maxTurns, timeoutSeconds }) => ({
										id,
										description,
										model,
										modelLabel: agentModelSelectorLabel(model, availableModels()),
										thinking,
										placement,
										judging,
										tools,
										maxTurns,
										timeoutSeconds,
									}),
								),
							};
							break;
						}
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
							throw new Error(catalogText(catalog, CatalogMessageId.subagentOperationUnsupported));
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
