import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const version = "0.0.1";

export default function jouzuManifest(pi: ExtensionAPI): void {
	pi.registerCommand("jouzu-manifest", {
		description: "Show the Jouzu Manifest preview status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Jouzu Manifest ${version} is a package-name reservation preview.`, "info");
		},
	});
}
