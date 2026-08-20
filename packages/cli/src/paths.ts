import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface JouzuPaths {
	agentDir: string;
	stateDir: string;
	cacheDir: string;
	sessionDir: string;
	profileStatePath: string;
	backupDir: string;
}

export interface PathResolutionOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	cwd?: string;
	homeOverride?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
	return value && value.trim().length > 0 ? value : undefined;
}

function expandHome(value: string, home: string, platform: NodeJS.Platform): string {
	if (value === "~") return home;
	if (value.startsWith("~/") || value.startsWith("~\\")) {
		const pathApi = platform === "win32" ? win32 : posix;
		return pathApi.join(home, value.slice(2));
	}
	return value;
}

function absolutePath(value: string, home: string, cwd: string, platform: NodeJS.Platform): string {
	const pathApi = platform === "win32" ? win32 : posix;
	return pathApi.resolve(cwd, expandHome(value, home, platform));
}

export function resolveJouzuPaths(options: PathResolutionOptions = {}): JouzuPaths {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const home = options.homeDir ?? homedir();
	const pathApi = platform === "win32" ? win32 : posix;
	const cwd = options.cwd ?? process.cwd();
	const homeOverride = nonEmpty(options.homeOverride) ?? nonEmpty(env.JOUZU_HOME);

	let agentDir: string;
	let stateDir: string;
	let cacheDir: string;
	if (homeOverride) {
		const root = absolutePath(homeOverride, home, cwd, platform);
		agentDir = pathApi.join(root, "agent");
		stateDir = pathApi.join(root, "state");
		cacheDir = pathApi.join(root, "cache");
	} else if (platform === "darwin") {
		const applicationSupport = pathApi.join(home, "Library", "Application Support", "Jouzu");
		agentDir = pathApi.join(applicationSupport, "agent");
		stateDir = pathApi.join(applicationSupport, "state");
		cacheDir = pathApi.join(home, "Library", "Caches", "Jouzu");
	} else if (platform === "win32") {
		const roaming = absolutePath(
			nonEmpty(env.APPDATA) ?? pathApi.join(home, "AppData", "Roaming"),
			home,
			cwd,
			platform,
		);
		const local = absolutePath(
			nonEmpty(env.LOCALAPPDATA) ?? pathApi.join(home, "AppData", "Local"),
			home,
			cwd,
			platform,
		);
		agentDir = pathApi.join(roaming, "Jouzu", "agent");
		stateDir = pathApi.join(local, "Jouzu", "state");
		cacheDir = pathApi.join(local, "Jouzu", "cache");
	} else {
		const configHome = absolutePath(
			nonEmpty(env.XDG_CONFIG_HOME) ?? pathApi.join(home, ".config"),
			home,
			cwd,
			platform,
		);
		const stateHome = absolutePath(
			nonEmpty(env.XDG_STATE_HOME) ?? pathApi.join(home, ".local", "state"),
			home,
			cwd,
			platform,
		);
		const cacheHome = absolutePath(nonEmpty(env.XDG_CACHE_HOME) ?? pathApi.join(home, ".cache"), home, cwd, platform);
		agentDir = pathApi.join(configHome, "jouzu", "agent");
		stateDir = pathApi.join(stateHome, "jouzu");
		cacheDir = pathApi.join(cacheHome, "jouzu");
	}

	return {
		agentDir,
		stateDir,
		cacheDir,
		sessionDir: pathApi.join(stateDir, "sessions"),
		profileStatePath: pathApi.join(stateDir, "profile-state.json"),
		backupDir: pathApi.join(stateDir, "backups"),
	};
}
