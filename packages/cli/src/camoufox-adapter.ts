import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	__test_wrapTool__,
	CamoufoxClient,
	type CamoufoxService,
	createAllTools,
	RealLauncher,
} from "@the-forge-flow/camoufox-pi";
import { CamoufoxFetcher, camoufoxPath } from "camoufox-js/dist/pkgman.js";

export interface CamoufoxInstallDependencies {
	locateInstalled(): unknown;
	install(): Promise<void>;
}

const defaultInstallDependencies: CamoufoxInstallDependencies = {
	locateInstalled: () => camoufoxPath(false),
	install: async () => {
		await new CamoufoxFetcher().install();
	},
};

export async function ensureJouzuCamoufoxInstalled(
	dependencies: CamoufoxInstallDependencies = defaultInstallDependencies,
): Promise<void> {
	try {
		dependencies.locateInstalled();
		return;
	} catch {
		await dependencies.install();
	}
	dependencies.locateInstalled();
}

/**
 * Register Camoufox's selected tools without starting or downloading a browser
 * during ordinary Jouzu startup. The client launches on the first tool call.
 */
export function createJouzuCamoufoxExtension(pi: ExtensionAPI): void {
	const launcher = new RealLauncher();
	const client = new CamoufoxClient({
		launcher: {
			async launch(options) {
				await ensureJouzuCamoufoxInstalled();
				return launcher.launch(options);
			},
		},
	});
	let basePath: string | null = null;
	const service = {
		getClient: () => client,
		getConfig: () => client.config,
		getBasePath: () => basePath,
	} as unknown as CamoufoxService;

	for (const definition of createAllTools(service)) {
		pi.registerTool(__test_wrapTool__(definition) as unknown as ToolDefinition);
	}
	pi.on("session_start", (_event, context) => {
		basePath = context.cwd;
	});
	pi.on("session_shutdown", async () => {
		basePath = null;
		await client.close();
	});
}

export default createJouzuCamoufoxExtension;
