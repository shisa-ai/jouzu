import { constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { KeybindingPlan } from "./keybindings.js";
import type { JouzuMetadata } from "./metadata.js";
import type { JouzuPaths } from "./paths.js";
import type { ProfileSelection } from "./runtime.js";
import { describeStateLock, inspectStateLock, STATE_LOCK_STALE_MS } from "./state-lock.js";
import type { UpdateInstallChannel, UpdateStatus } from "./updater.js";

const PROVIDER_ENVIRONMENT_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANT_LING_API_KEY",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"NVIDIA_API_KEY",
	"GEMINI_API_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_PROFILE",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"ZAI_API_KEY",
	"HF_TOKEN",
	"KIMI_API_KEY",
	"MINIMAX_API_KEY",
] as const;

export interface DoctorContext {
	metadata: JouzuMetadata;
	paths: JouzuPaths;
	profile: ProfileSelection;
	piRuntimeVersion: string;
	piRuntimeDiagnostic?: string;
	executable: string;
	env?: NodeJS.ProcessEnv;
	inheritedPiAgentDir?: string;
	inheritedPiSessionDir?: string;
	platform?: NodeJS.Platform;
	architecture?: string;
	nodeVersion?: string;
	locale?: string;
	commandPaths?: { git: string | null; bash: string | null; npm: string | null };
	desiredProfileManifestSha256?: string;
	updateStatus?: UpdateStatus;
	updateDiagnostic?: string;
	keybindingPlan?: KeybindingPlan;
	keybindingDiagnostic?: string;
}

export interface DoctorResult {
	text: string;
	healthy: boolean;
}

function parseNodeVersion(version: string): [number, number, number] {
	const [major = "0", minor = "0", patch = "0"] = version.replace(/^v/, "").split(".");
	return [Number(major), Number(minor), Number(patch)];
}

function nodeIsSupported(version: string): boolean {
	const [major, minor, patch] = parseNodeVersion(version);
	return major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0)));
}

function executableExists(path: string, platform: NodeJS.Platform): boolean {
	try {
		return statSync(path).isFile() && (platform === "win32" || (statSync(path).mode & constants.S_IXUSR) !== 0);
	} catch {
		return false;
	}
}

function findExecutable(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
	const pathApi = platform === "win32" ? win32 : posix;
	const extensions = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
	const candidates = (env.PATH ?? "")
		.split(pathApi.delimiter)
		.filter(Boolean)
		.flatMap((directory) => extensions.map((extension) => pathApi.join(directory, `${name}${extension}`)));
	if (platform === "win32" && name === "bash") {
		for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
			if (root) candidates.push(pathApi.join(root, "Git", "bin", "bash.exe"));
		}
	}
	return candidates.find((candidate) => executableExists(candidate, platform));
}

function readPackageCount(settingsPath: string): { count: number; warning?: string } {
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown };
		if (settings.packages === undefined) return { count: 0 };
		if (!Array.isArray(settings.packages)) return { count: 0, warning: "settings.json packages is not an array" };
		return { count: settings.packages.length };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return { count: 0 };
		return { count: 0, warning: "settings.json could not be parsed" };
	}
}

function describeInstallChannel(channel: UpdateInstallChannel | undefined): string {
	switch (channel) {
		case "global-npm":
			return "global npm install";
		case "local-npm":
			return "local npm install";
		case "ephemeral-npx":
			return "npx install";
		case "source":
			return "source checkout";
		case "other":
			return "other";
		default:
			return "unavailable";
	}
}

function userHome(env: NodeJS.ProcessEnv): string {
	return env.HOME ?? env.USERPROFILE ?? homedir();
}

export function createDoctorReport(context: DoctorContext): DoctorResult {
	const env = context.env ?? process.env;
	const platform = context.platform ?? process.platform;
	const architecture = context.architecture ?? process.arch;
	const nodeVersion = context.nodeVersion ?? process.version;
	const locale = context.locale ?? Intl.DateTimeFormat().resolvedOptions().locale;
	const pathApi = platform === "win32" ? win32 : posix;
	const lines: string[] = [];
	const problems: string[] = [];
	const warnings: string[] = [];
	const settingsPath = pathApi.join(context.paths.agentDir, "settings.json");
	const authPath = pathApi.join(context.paths.agentDir, "auth.json");
	const modelsPath = pathApi.join(context.paths.agentDir, "models.json");
	const sharedSkillsPath = pathApi.resolve(userHome(env), ".agents", "skills");
	const packageState = readPackageCount(settingsPath);
	const gitPath = context.commandPaths ? (context.commandPaths.git ?? undefined) : findExecutable("git", env, platform);
	const bashPath = context.commandPaths
		? (context.commandPaths.bash ?? undefined)
		: findExecutable("bash", env, platform);
	const npmPath = context.commandPaths ? (context.commandPaths.npm ?? undefined) : findExecutable("npm", env, platform);
	const providerEnvironment = PROVIDER_ENVIRONMENT_KEYS.some((key) => Boolean(env[key]));
	const nodeSupported = nodeIsSupported(nodeVersion);

	if (!nodeSupported) problems.push(`Node ${nodeVersion} is unsupported; Jouzu requires >=22.19.0`);
	if (!gitPath) problems.push("Git was not found on PATH");
	if (!bashPath) problems.push("Bash was not found; install Bash or Git Bash");
	if (!npmPath) problems.push("npm was not found on PATH; npm is required for Jouzu updates");
	if (context.metadata.piVersion !== context.piRuntimeVersion) {
		problems.push(`Pinned Pi ${context.metadata.piVersion} does not match loaded runtime ${context.piRuntimeVersion}`);
	}
	if (context.piRuntimeDiagnostic) {
		problems.push(`Pi runtime could not be loaded: ${context.piRuntimeDiagnostic}`);
	}
	if (context.metadata.lock.compatibilityStatus !== "qualified") {
		problems.push(`Pi lock status is ${context.metadata.lock.compatibilityStatus}, not qualified`);
	}
	if (!existsSync(authPath) && !providerEnvironment && !existsSync(modelsPath)) {
		warnings.push(
			"No obvious provider credential or custom model configuration was found; use /login or provider environment variables",
		);
	}
	if (!context.profile.appliedManifestSha256) {
		warnings.push('The selected profile has not been applied; run "jouzu profile apply"');
	} else if (
		context.desiredProfileManifestSha256 &&
		context.profile.appliedManifestSha256 !== context.desiredProfileManifestSha256
	) {
		warnings.push('The applied profile differs from the bundled manifest; run "jouzu profile plan"');
	}
	if (packageState.warning) warnings.push(packageState.warning);
	if (context.updateStatus?.state.lastResult === "failed") {
		warnings.push(`The last Jouzu update operation failed (${context.updateStatus.state.lastErrorCode ?? "unknown"})`);
	}
	if (context.updateDiagnostic) warnings.push(`Self-update status is unavailable: ${context.updateDiagnostic}`);
	if (context.keybindingPlan?.actions.some((action) => action.type === "conflict")) {
		warnings.push('Jouzu keybinding defaults conflict with user bindings; run "jouzu keybindings plan"');
	}
	if (context.keybindingDiagnostic) warnings.push(`Keybinding status is unavailable: ${context.keybindingDiagnostic}`);

	lines.push("Jouzu doctor");
	lines.push("");
	lines.push(`Jouzu version: ${context.metadata.jouzuVersion}`);
	lines.push(`Pi runtime: ${context.piRuntimeVersion}`);
	lines.push(`Pi upstream: ${context.metadata.lock.tag} (${context.metadata.lock.commit})`);
	lines.push(
		`Pi qualification: ${context.metadata.lock.compatibilityStatus}; deviations=${context.metadata.lock.deviations.length}`,
	);
	lines.push(`Profile schema: ${context.metadata.profileSchemaVersion}`);
	lines.push(`Install channel: ${describeInstallChannel(context.updateStatus?.installChannel)}`);
	lines.push(`Executable: ${context.executable}`);
	lines.push(`Self-update policy: ${context.updateStatus?.policy ?? "unavailable"}`);
	lines.push(`Self-update channel: ${context.updateStatus?.installChannel ?? "unavailable"}`);
	lines.push(
		`Automatic startup update: ${context.updateStatus ? (context.updateStatus.startupEligible ? "eligible" : "not eligible") : "unavailable"}`,
	);
	lines.push(`Last update check: ${context.updateStatus?.state.lastCheckedAt ?? "never"}`);
	lines.push(`Latest observed Jouzu: ${context.updateStatus?.state.latestVersion ?? "not checked"}`);
	lines.push(`Keybinding defaults: ${context.keybindingPlan?.status ?? "unavailable"}`);
	lines.push(`Keybinding policy: ${context.keybindingPlan?.policy ?? "unavailable"}`);
	lines.push(`Jouzu default follow-up key: ctrl+enter`);
	lines.push(`Jouzu default dequeue key: ctrl+up`);
	lines.push(`Keybinding config: ${context.keybindingPlan?.configPath ?? "unavailable"}`);
	lines.push("");
	lines.push(`Platform: ${platform} ${architecture}`);
	lines.push(`Node: ${nodeVersion} (${nodeSupported ? "supported" : "unsupported"})`);
	lines.push(`Locale: ${locale}`);
	lines.push(`Git: ${gitPath ?? "not found"}`);
	lines.push(`Bash: ${bashPath ?? "not found"}`);
	lines.push(`npm: ${npmPath ?? "not found"}`);
	lines.push(`Proxy configured: ${env.HTTP_PROXY || env.HTTPS_PROXY ? "yes" : "no"}`);
	lines.push(`Additional CA configured: ${env.NODE_EXTRA_CA_CERTS ? "yes" : "no"}`);
	lines.push("");
	lines.push(`Agent/config root: ${context.paths.agentDir}`);
	lines.push(`State root: ${context.paths.stateDir}`);
	lines.push(`Session root: ${context.paths.sessionDir}`);
	lines.push(`Cache root: ${context.paths.cacheDir}`);
	lines.push(`Inherited Pi agent root replaced: ${context.inheritedPiAgentDir ? "yes" : "not set"}`);
	lines.push(`Inherited Pi session root replaced: ${context.inheritedPiSessionDir ? "yes" : "not set"}`);
	const now = new Date();
	const stateLocks = [
		{ label: "Profile lock", path: pathApi.join(context.paths.stateDir, "profile.lock") },
		{ label: "Keybinding lock", path: pathApi.join(context.paths.stateDir, "keybindings.lock") },
		{ label: "Update lock", path: pathApi.join(context.paths.stateDir, "self-update.lock") },
	];
	for (const { label, path } of stateLocks) {
		lines.push(`${label}: ${describeStateLock(path, STATE_LOCK_STALE_MS, now)}`);
		const status = inspectStateLock(path, now).status;
		if (status === "held-dead" || status === "owner-unknown" || status === "invalid") {
			problems.push(`A leftover state lock blocks Jouzu operations: ${path} (${status})`);
		}
	}
	lines.push(
		`Shared cross-harness skills: ${sharedSkillsPath} (${existsSync(sharedSkillsPath) ? "present" : "absent"})`,
	);
	lines.push("");
	lines.push(`Selected profile: ${context.profile.id} (${context.profile.source})`);
	lines.push(`Bundled profile manifest: ${context.desiredProfileManifestSha256 ?? "unavailable"}`);
	lines.push(`Applied profile manifest: ${context.profile.appliedManifestSha256 ?? "not applied"}`);
	lines.push(`Configured Pi packages: ${packageState.count}`);
	lines.push(`Provider auth file: ${existsSync(authPath) ? "present" : "absent"}`);
	lines.push(`Custom models file: ${existsSync(modelsPath) ? "present" : "absent"}`);
	lines.push(`Provider environment: ${providerEnvironment ? "present" : "not detected"}`);
	lines.push("");
	lines.push(
		"Isolation: stock Pi global config, auth, packages, and sessions are not imported. Project resources and ~/.agents/skills remain shared Pi compatibility surfaces.",
	);

	if (warnings.length > 0) {
		lines.push("");
		lines.push("Warnings:");
		for (const warning of warnings) lines.push(`- ${warning}`);
	}
	if (problems.length > 0) {
		lines.push("");
		lines.push("Problems:");
		for (const problem of problems) lines.push(`- ${problem}`);
	}
	lines.push("");
	lines.push(problems.length === 0 ? "Result: ready for Jouzu v0.1 preview" : "Result: action required");

	return { text: lines.join("\n"), healthy: problems.length === 0 };
}
