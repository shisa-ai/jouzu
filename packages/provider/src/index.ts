import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const version = "0.0.1";

export default function jouzuProvider(pi: ExtensionAPI): void {
	pi.registerCommand("jouzu-provider", {
		description: "Show the Jouzu Provider preview status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Jouzu Provider ${version} is a package-name reservation preview.`, "info");
		},
	});
}
