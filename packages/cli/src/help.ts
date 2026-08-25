import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";

const HELP_SHORTCUTS = ["ctrl+/", "ctrl+?"] as const;

export function createJouzuHelpExtension(): InlineExtension {
	return {
		name: "jouzu-help",
		factory: (pi) => {
			const showHelp = async (ctx: ExtensionContext) => {
				if (ctx.mode !== "tui") return;
				await ctx.ui.custom<void>(
					(_tui, theme, keybindings, done) => {
						const text = new Text(
							[
								theme.bold(theme.fg("accent", "Jouzu Help")),
								"",
								`${theme.fg("accent", "Ctrl+L")}  Models`,
								`${theme.fg("accent", "Ctrl+/")}  Help`,
								`${theme.fg("accent", "/hotkeys")}  All shortcuts`,
								`${theme.fg("accent", "/status")}  Session details`,
								"",
								theme.fg("dim", "Esc close"),
							].join("\n"),
							1,
							1,
						);
						return {
							render: (width: number) => text.render(width),
							invalidate: () => text.invalidate(),
							handleInput: (data: string) => {
								if (
									keybindings.matches(data, "tui.select.cancel") ||
									HELP_SHORTCUTS.some((shortcut) => matchesKey(data, shortcut))
								) {
									done(undefined);
								}
							},
						};
					},
					{
						overlay: true,
						overlayOptions: { width: 38, maxHeight: 12, anchor: "center", margin: 1 },
					},
				);
			};

			for (const shortcut of HELP_SHORTCUTS) {
				pi.registerShortcut(shortcut, { description: "Open Jouzu help", handler: showHelp });
			}
		},
	};
}
