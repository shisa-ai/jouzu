import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { SessionUiActivity, SessionUiActivityContext, SessionUiHint } from "./contracts.js";
import { SessionStatusController } from "./controller.js";
import { SESSION_UI_RUNTIME_IDS } from "./identity.js";
import { type ModelCycleDirection, SessionPromptEditor } from "./prompt-frame.js";
import { SessionLineComponent } from "./session-line.js";
import type { SessionStatusSnapshot } from "./snapshot.js";
import { StatusBarComponent } from "./status-bar.js";
import { createSessionUiStyles, type SessionUiStyleOptions, type SessionUiStyleScheme } from "./styles.js";
import { WorkDashboardComponent } from "./work-dashboard-component.js";
import type { WorkDashboardController } from "./work-dashboard-controller.js";
import { dashboardAvailableRows } from "./work-dashboard-height.js";

export interface SessionUiExtensionOptions {
	dashboard?: {
		controller: WorkDashboardController;
		attach(ctx: ExtensionContext, resetVisibility: boolean): void;
		mode(): "compact" | "expanded" | "hidden";
	};
	getHints?: (snapshot: SessionStatusSnapshot | undefined) => readonly SessionUiHint[];
	/**
	 * Activity shown on the Session Line in place of the hint. The getter is read on each render and
	 * on every animation step, so a source that can change without a render, such as a child agent
	 * finishing, stays current only while `active` is true.
	 */
	getActivity?: (context: SessionUiActivityContext) => SessionUiActivity | undefined;
	onModelPicker?: (query?: string) => Promise<boolean>;
	onModelCycle?: (direction: ModelCycleDirection) => Promise<boolean>;
	onScopedModelsCommand?: () => Promise<boolean>;
	styleScheme?: SessionUiStyleScheme;
	colorEnabled?: boolean;
	env?: NodeJS.ProcessEnv;
}

export function createSessionUiExtension(options: SessionUiExtensionOptions = {}): InlineExtension {
	return {
		name: SESSION_UI_RUNTIME_IDS.extension,
		factory: (pi) => {
			let controller: SessionStatusController | undefined;
			let editorInstalled = false;
			const styleOptions: SessionUiStyleOptions = {
				...(options.styleScheme ? { scheme: options.styleScheme } : {}),
				...(options.colorEnabled !== undefined ? { colorEnabled: options.colorEnabled } : {}),
				...(options.env ? { env: options.env } : {}),
			};
			const stylesFor = (theme: Parameters<typeof createSessionUiStyles>[0]) =>
				createSessionUiStyles(theme, styleOptions);

			const sync = (ctx: Parameters<SessionStatusController["sync"]>[0]) => {
				controller?.sync(ctx);
			};

			pi.on("session_start", (_event, ctx) => {
				if (ctx.mode !== "tui") return;
				controller?.dispose();
				controller = new SessionStatusController({
					run: (command, args, commandOptions) =>
						pi.exec(command, args, {
							cwd: commandOptions.cwd,
							timeout: commandOptions.timeout,
							...(commandOptions.signal ? { signal: commandOptions.signal } : {}),
						}),
				});
				controller.sync(ctx);
				const activeController = controller;
				options.dashboard?.attach(ctx, true);
				// Pi exposes extension statuses only through the footer factory, so the footer publishes
				// the live map for the Session Line to read.
				let extensionStatuses: ReadonlyMap<string, string> = new Map();
				ctx.ui.setWidget(
					SESSION_UI_RUNTIME_IDS.sessionLineWidget,
					(tui, theme) =>
						new SessionLineComponent(
							activeController,
							stylesFor(theme),
							() => options.getHints?.(activeController.getSnapshot()) ?? [],
							() => tui.requestRender(),
							() => options.getActivity?.({ extensionStatuses }),
						),
					{ placement: "aboveEditor" },
				);
				if (options.dashboard) {
					const dashboard = options.dashboard;
					ctx.ui.setWidget(
						"jouzu-work-dashboard",
						(tui, theme) => {
							const component: WorkDashboardComponent = new WorkDashboardComponent(
								dashboard.controller,
								stylesFor(theme),
								(width) => ({
									mode: dashboard.mode(),
									terminalRows: tui.terminal.rows,
									availableRows: dashboardAvailableRows(tui, component, width),
								}),
								() => tui.requestRender(),
							);
							return component;
						},
						{ placement: "aboveEditor" },
					);
				}
				ctx.ui.setFooter((tui, theme, footerData) => {
					extensionStatuses = footerData.getExtensionStatuses();
					const statusBar = new StatusBarComponent(activeController, stylesFor(theme), () => tui.requestRender());
					const unsubscribeBranch = footerData.onBranchChange(() => {
						void activeController.refreshGit(ctx);
					});
					return {
						render: (width) => statusBar.render(width),
						invalidate: () => statusBar.invalidate(),
						dispose: () => {
							unsubscribeBranch();
							statusBar.dispose();
						},
					};
				});
				if (!editorInstalled) {
					ctx.ui.setEditorComponent(
						(tui, theme, keybindings) =>
							new SessionPromptEditor(tui, theme, keybindings, stylesFor(ctx.ui.theme), {
								...(options.onModelPicker ? { onModelPicker: options.onModelPicker } : {}),
								...(options.onModelCycle ? { onModelCycle: options.onModelCycle } : {}),
								...(options.onScopedModelsCommand ? { onScopedModelsCommand: options.onScopedModelsCommand } : {}),
							}),
					);
					editorInstalled = true;
				}
				void activeController.refreshProject(ctx);
			});

			pi.on("agent_start", (_event, ctx) => sync(ctx));
			pi.on("agent_end", (_event, ctx) => sync(ctx));
			pi.on("agent_settled", (_event, ctx) => sync(ctx));
			pi.on("model_select", (_event, ctx) => sync(ctx));
			pi.on("thinking_level_select", (_event, ctx) => sync(ctx));
			pi.on("message_end", (_event, ctx) => sync(ctx));
			pi.on("session_compact", (_event, ctx) => sync(ctx));
			pi.on("session_tree", (_event, ctx) => {
				sync(ctx);
				if (ctx.mode === "tui") options.dashboard?.attach(ctx, false);
			});
			pi.on("tool_execution_end", (_event, ctx) => {
				sync(ctx);
				if (controller) void controller.refreshGit(ctx);
			});
			pi.on("session_shutdown", (_event, ctx) => {
				controller?.dispose();
				controller = undefined;
				options.dashboard?.controller.detach();
				if (ctx.mode !== "tui") return;
				if (options.dashboard) ctx.ui.setWidget("jouzu-work-dashboard", undefined);
				ctx.ui.setWidget(SESSION_UI_RUNTIME_IDS.sessionLineWidget, undefined);
				ctx.ui.setFooter(undefined);
				ctx.ui.setEditorComponent(undefined);
				editorInstalled = false;
			});
		},
	};
}
