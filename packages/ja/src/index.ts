import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const version = "0.0.1";

export default function jouzuJa(pi: ExtensionAPI): void {
	pi.registerCommand("jouzu-ja", {
		description: "Show the Jouzu JA preview status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Jouzu JA ${version} is a package-name reservation preview.`, "info");
		},
	});
}
