import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { SessionUiHint } from "./contracts.js";
import { SessionStatusController } from "./controller.js";
import { SESSION_UI_RUNTIME_IDS } from "./identity.js";
import { SessionPromptEditor } from "./prompt-frame.js";
import { SessionLineComponent } from "./session-line.js";
import type { SessionStatusSnapshot } from "./snapshot.js";
import { StatusBarComponent } from "./status-bar.js";

export interface SessionUiExtensionOptions {
	getHints?: (snapshot: SessionStatusSnapshot | undefined) => readonly SessionUiHint[];
}

export function createSessionUiExtension(options: SessionUiExtensionOptions = {}): InlineExtension {
	return {
		name: SESSION_UI_RUNTIME_IDS.extension,
		factory: (pi) => {
			let controller: SessionStatusController | undefined;

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
				ctx.ui.setWidget(
					SESSION_UI_RUNTIME_IDS.sessionLineWidget,
					(tui, theme) =>
						new SessionLineComponent(
							activeController,
							theme,
							() => options.getHints?.(activeController.getSnapshot()) ?? [],
							() => tui.requestRender(),
						),
					{ placement: "aboveEditor" },
				);
				ctx.ui.setFooter((tui, theme, footerData) => {
					const statusBar = new StatusBarComponent(activeController, theme, () => tui.requestRender());
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
				ctx.ui.setEditorComponent(
					(tui, theme, keybindings) => new SessionPromptEditor(tui, theme, keybindings, ctx.ui.theme),
				);
				void activeController.refreshProject(ctx);
			});

			pi.on("agent_start", (_event, ctx) => sync(ctx));
			pi.on("agent_end", (_event, ctx) => sync(ctx));
			pi.on("agent_settled", (_event, ctx) => sync(ctx));
			pi.on("model_select", (_event, ctx) => sync(ctx));
			pi.on("thinking_level_select", (_event, ctx) => sync(ctx));
			pi.on("message_end", (_event, ctx) => sync(ctx));
			pi.on("session_compact", (_event, ctx) => sync(ctx));
			pi.on("session_tree", (_event, ctx) => sync(ctx));
			pi.on("tool_execution_end", (_event, ctx) => {
				sync(ctx);
				if (controller) void controller.refreshGit(ctx);
			});
			pi.on("session_shutdown", (_event, ctx) => {
				controller?.dispose();
				controller = undefined;
				if (ctx.mode !== "tui") return;
				ctx.ui.setWidget(SESSION_UI_RUNTIME_IDS.sessionLineWidget, undefined);
				ctx.ui.setFooter(undefined);
				ctx.ui.setEditorComponent(undefined);
			});
		},
	};
}
