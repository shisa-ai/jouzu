import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	__test_wrapTool__,
	CamoufoxClient,
	type CamoufoxService,
	createAllTools,
	RealLauncher,
} from "@the-forge-flow/camoufox-pi";

/**
 * Register Camoufox's selected tools without starting or downloading a browser
 * during ordinary Jouzu startup. The client launches on the first tool call.
 */
export function createJouzuCamoufoxExtension(pi: ExtensionAPI): void {
	const client = new CamoufoxClient({ launcher: new RealLauncher() });
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
