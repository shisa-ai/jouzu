import { createRequire } from "node:module";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { __test_wrapTool__, CamoufoxClient, type CamoufoxService, createAllTools } from "@the-forge-flow/camoufox-pi";
import { launchOptions as camoufoxLaunchOptions } from "camoufox-js";
import { CamoufoxFetcher, camoufoxPath } from "camoufox-js/dist/pkgman.js";
import { firefox } from "playwright-core";

const require = createRequire(import.meta.url);

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

function nativeBindingIsIncompatible(error: unknown): boolean {
	const message =
		error instanceof Error
			? `${error.message}\n${error.cause instanceof Error ? error.cause.message : ""}`
			: String(error);
	return /(?:GLIBC|GLIBCXX)_[0-9.]+.*not found|ERR_DLOPEN_FAILED/u.test(message);
}

export async function shouldDisableCamoufoxWebGl(
	loadDatabase: () => Promise<unknown> = async () => ({ default: require("better-sqlite3") }),
): Promise<boolean> {
	try {
		const imported = (await loadDatabase()) as { default?: new (path: string) => { close(): void } };
		if (!imported.default) throw new Error("better-sqlite3 has no default Database export");
		const database = new imported.default(":memory:");
		database.close();
		return false;
	} catch (error) {
		if (nativeBindingIsIncompatible(error)) return true;
		throw error;
	}
}

export function withJouzuCamoufoxLibraryPath<T extends { env?: Record<string, string | number | boolean> }>(
	launchOptions: T,
	environment: NodeJS.ProcessEnv = process.env,
): T {
	const compatibilityPath = environment.JOUZU_CAMOUFOX_LIBRARY_PATH?.trim();
	if (!compatibilityPath) return launchOptions;
	const inherited = Object.fromEntries(
		Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	return {
		...launchOptions,
		env: {
			...inherited,
			...launchOptions.env,
			LD_LIBRARY_PATH: [compatibilityPath, environment.LD_LIBRARY_PATH].filter(Boolean).join(":"),
		},
	};
}

/**
 * Register Camoufox's selected tools without starting or downloading a browser
 * during ordinary Jouzu startup. The client launches on the first tool call.
 */
export function createJouzuCamoufoxExtension(pi: ExtensionAPI): void {
	const client = new CamoufoxClient({
		launcher: {
			async launch() {
				await ensureJouzuCamoufoxInstalled();
				const blockWebGl = await shouldDisableCamoufoxWebGl();
				const launchOptions = withJouzuCamoufoxLibraryPath(
					await camoufoxLaunchOptions({
						headless: true,
						...(blockWebGl ? { block_webgl: true, i_know_what_im_doing: true } : {}),
					}),
				);
				const browser = await firefox.launch(launchOptions);
				const context = await browser.newContext();
				return { browser, context, version: browser.version() };
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
