import { getMarkdownTheme, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { catalogText, defaultCatalog } from "./cli-messages.js";
import { protectedCommand, protectedUrl } from "./human-messages.js";
import type { CatalogBundle } from "./locale-catalog.js";

const PLUGINS_ENTRY = "jouzu-plugins";

export function pluginsGuide(catalog: CatalogBundle = defaultCatalog()): string {
	return [
		`### ${catalogText(catalog, "jouzu.cli.plugins.title")}`,
		catalogText(catalog, "jouzu.cli.plugins.introduction", { url: protectedUrl("https://pi.dev/packages") }),
		`**${catalogText(catalog, "jouzu.cli.plugins.install")}**\n\`\`\`sh\njz install npm:<package-name>\n\`\`\``,
		catalogText(catalog, "jouzu.cli.plugins.manage", {
			list: protectedCommand("`jz list`"),
			remove: protectedCommand("`jz remove <source>`"),
			reload: protectedCommand("`/reload`"),
		}),
		catalogText(catalog, "jouzu.cli.plugins.warning"),
		`**${catalogText(catalog, "jouzu.cli.plugins.customizeTitle")}** ${catalogText(
			catalog,
			"jouzu.cli.plugins.customize",
			{
				reload: protectedCommand("`/reload`"),
			},
		)}`,
		`**${catalogText(catalog, "jouzu.cli.plugins.question")}**`,
	].join("\n\n");
}

export function createPluginsExtension(catalog: CatalogBundle = defaultCatalog()): InlineExtension {
	return {
		name: "jouzu-plugins",
		factory(pi) {
			pi.registerEntryRenderer(PLUGINS_ENTRY, () => new Markdown(pluginsGuide(catalog), 1, 1, getMarkdownTheme()));
			pi.registerCommand("plugins", {
				description: catalogText(catalog, "jouzu.cli.plugins.description"),
				handler: async (_args, ctx) => {
					if (ctx.mode === "tui") pi.appendEntry(PLUGINS_ENTRY);
					else if (ctx.mode === "print") console.log(pluginsGuide(catalog));
					else ctx.ui.notify(pluginsGuide(catalog), "info");
				},
			});
		},
	};
}
