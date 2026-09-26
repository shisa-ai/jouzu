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
			// The Session Line renders as the prompt editor's first line. Pi moves a widget directly above
			// the editor whenever it is registered again, so a widget cannot hold that position.
			let sessionLine: SessionLineComponent | undefined;
			let requestRender = () => {};
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
				sessionLine?.dispose();
				sessionLine = new SessionLineComponent(
					activeController,
					stylesFor(ctx.ui.theme),
					() => options.getHints?.(activeController.getSnapshot()) ?? [],
					() => requestRender(),
					() => options.getActivity?.({ extensionStatuses }),
				);
				if (options.dashboard) {
					const dashboard = options.dashboard;
					ctx.ui.setWidget(
						SESSION_UI_RUNTIME_IDS.workDashboardWidget,
						(tui, theme) => {
							const component: WorkDashboardComponent = new WorkDashboardComponent(
								dashboard.controller,
								stylesFor(theme),
								(width) => ({
									mode: dashboard.mode(),
									animate: activeController.getSnapshot()?.activity.idle === true,
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
					requestRender = () => tui.requestRender();
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
								topLine: (width) => sessionLine?.render(width)[0],
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
				if (options.dashboard) ctx.ui.setWidget(SESSION_UI_RUNTIME_IDS.workDashboardWidget, undefined);
				sessionLine?.dispose();
				sessionLine = undefined;
				requestRender = () => {};
				ctx.ui.setFooter(undefined);
				ctx.ui.setEditorComponent(undefined);
				editorInstalled = false;
			});
		},
	};
}
