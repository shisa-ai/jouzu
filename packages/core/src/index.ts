import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const version = "0.0.1";

export default function jouzuCore(pi: ExtensionAPI): void {
	pi.registerCommand("jouzu-core", {
		description: "Show the Jouzu Core preview status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`Jouzu Core ${version} is a package-name reservation preview.`, "info");
		},
	});
}
