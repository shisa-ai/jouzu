import type { ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import { CatalogMessageId, catalogText, defaultCatalog } from "./cli-messages.js";
import type { ProtectedValue } from "./human-messages.js";
import { protectedCommand } from "./human-messages.js";
import { formatEffectiveKeybinding, formatKeyId } from "./keybinding-hints.js";
import type { CatalogBundle } from "./locale-catalog.js";

const HELP_SHORTCUTS = ["ctrl+/", "ctrl+?"] as const;

/**
 * The help overlay.
 *
 * Every label is a catalog message. The resolved keybindings and the slash
 * commands are injected as protected values at render time, so the overlay
 * always shows the effective key and the catalog never stores one. Each value
 * keeps its own `{" "}` alignment literal, so the decoration and the width do
 * not depend on the locale.
 */
export function createJouzuHelpExtension(catalog: CatalogBundle = defaultCatalog()): InlineExtension {
	return {
		name: "jouzu-help",
		factory: (pi) => {
			const showHelp = async (ctx: ExtensionContext) => {
				if (ctx.mode !== "tui") return;
				await ctx.ui.custom<void>(
					(_tui, theme, keybindings, done) => {
						const shortcutSeparator = catalogText(catalog, CatalogMessageId.helpOverlayShortcutSeparator);
						const helpKeys = HELP_SHORTCUTS.map((shortcut) => formatKeyId(shortcut)).join(shortcutSeparator);
						const accent = (value: string): ProtectedValue => protectedCommand(theme.fg("accent", value));
						const key = (action: "app.model.select" | "app.model.cycleForward" | "tui.select.cancel") =>
							accent(formatEffectiveKeybinding(keybindings, action));
						const text = new Text(
							[
								theme.bold(theme.fg("accent", catalogText(catalog, CatalogMessageId.helpOverlayTitle))),
								"",
								catalogText(catalog, CatalogMessageId.helpOverlayModels, { key: key("app.model.select") }),
								catalogText(catalog, CatalogMessageId.helpOverlayCycleFavorites, {
									key: key("app.model.cycleForward"),
								}),
								catalogText(catalog, CatalogMessageId.helpOverlayHelp, { key: accent(helpKeys) }),
								catalogText(catalog, CatalogMessageId.helpOverlayAllShortcuts, {
									command: accent("/hotkeys"),
								}),
								catalogText(catalog, CatalogMessageId.helpOverlaySessionDetails, {
									command: accent("/session"),
								}),
								catalogText(catalog, "jouzu.cli.helpOverlay.fastMode", { command: accent("/fast on|off") }),
								catalogText(catalog, "jouzu.cli.helpOverlay.plugins", { command: accent("/plugins") }),
								catalogText(catalog, "jouzu.cli.helpOverlay.btw", { command: accent("/btw") }),
								catalogText(catalog, CatalogMessageId.helpOverlayRuntimeBuilds, {
									command: accent("/about"),
								}),
								catalogText(catalog, CatalogMessageId.helpOverlayAgentsRuns, {
									command: accent("/workflow"),
								}),
								catalogText(catalog, CatalogMessageId.helpOverlayChildDashboard, {
									command: accent("/subagents"),
								}),
								catalogText(catalog, "jouzu.cli.helpOverlay.scrollback", { command: accent("/scrollback") }),
								"",
								theme.fg(
									"dim",
									catalogText(catalog, CatalogMessageId.helpOverlayClose, { key: key("tui.select.cancel") }),
								),
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
						overlayOptions: { width: 42, maxHeight: 18, anchor: "center", margin: 1 },
					},
				);
			};

			pi.registerCommand("help", {
				description: catalogText(catalog, CatalogMessageId.helpOverlayShortcutDescription),
				handler: async (_args, ctx) => showHelp(ctx),
			});

			for (const shortcut of HELP_SHORTCUTS) {
				pi.registerShortcut(shortcut, {
					description: catalogText(catalog, CatalogMessageId.helpOverlayShortcutDescription),
					handler: showHelp,
				});
			}
		},
	};
}
