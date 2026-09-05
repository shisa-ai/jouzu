import { constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import {
	CAMOUFOX_INSTALL_LOCK_STALE_MS,
	inspectJouzuCamoufoxRuntime,
	resolveCamoufoxRuntimePaths,
} from "./camoufox-adapter.js";
import type { KeybindingPlan } from "./keybindings.js";
import type { JouzuMetadata } from "./metadata.js";
import { loadModelPickerState } from "./model-picker-state.js";
import type { JouzuPaths } from "./paths.js";
import type { ReleaseExtensionStatus } from "./release-extensions.js";
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
	releaseExtensionStatus?: ReleaseExtensionStatus;
	releaseExtensionDiagnostic?: string;
}

export type DoctorSeverity = "warning" | "problem";

export type DoctorSectionId = "runtime" | "platform" | "roots" | "profile";

/** One observed fact. Schema 1 IDs are machine keys, but remain experimental through v0.1.x. */
export interface DoctorField {
	id: string;
	section: DoctorSectionId;
	label: string;
	value: string;
}

/** One diagnosis. Several issues may attach to the same observed field. */
export interface DoctorIssue {
	id: string;
	severity: DoctorSeverity;
	message: string;
}

export interface DoctorReport {
	schemaVersion: 1;
	experimental: true;
	healthy: boolean;
	fields: DoctorField[];
	issues: DoctorIssue[];
	notes: string[];
}

export interface DoctorResult {
	text: string;
	healthy: boolean;
	report: DoctorReport;
}

const DOCTOR_SECTION_ORDER: readonly DoctorSectionId[] = ["runtime", "platform", "roots", "profile"];

/**
 * Render the human report. Sections are emitted in a fixed order and separated
 * by one blank line, so adding a field never changes unrelated output.
 */
export function formatDoctorReport(report: DoctorReport): string {
	const lines: string[] = ["Jouzu doctor"];
	for (const section of DOCTOR_SECTION_ORDER) {
		const fields = report.fields.filter((field) => field.section === section);
		if (fields.length === 0) continue;
		lines.push("");
		for (const field of fields) lines.push(`${field.label}: ${field.value}`);
	}
	for (const note of report.notes) {
		lines.push("");
		lines.push(note);
	}
	for (const [heading, severity] of [
		["Warnings", "warning"],
		["Problems", "problem"],
	] as const) {
		const matching = report.issues.filter((issue) => issue.severity === severity);
		if (matching.length === 0) continue;
		lines.push("");
		lines.push(`${heading}:`);
		for (const issue of matching) lines.push(`- ${issue.message}`);
	}
	lines.push("");
	lines.push(report.healthy ? "Result: ready for Jouzu v0.1 preview" : "Result: action required");
	return lines.join("\n");
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

	const fields: DoctorField[] = [];
	const issues: DoctorIssue[] = [];
	const notes: string[] = [];
	const field = (section: DoctorSectionId, id: string, label: string, value: string): void => {
		fields.push({ id, section, label, value });
	};
	const problem = (id: string, message: string): void => {
		issues.push({ id, severity: "problem", message });
	};
	const warning = (id: string, message: string): void => {
		issues.push({ id, severity: "warning", message });
	};

	const settingsPath = pathApi.join(context.paths.agentDir, "settings.json");
	const authPath = pathApi.join(context.paths.agentDir, "auth.json");
	const modelsPath = pathApi.join(context.paths.agentDir, "models.json");
	const modelPickerStatePath = pathApi.join(context.paths.stateDir, "model-picker.json");
	const sharedSkillsPath = pathApi.resolve(userHome(env), ".agents", "skills");
	const packageState = readPackageCount(settingsPath);
	const gitPath = context.commandPaths ? (context.commandPaths.git ?? undefined) : findExecutable("git", env, platform);
	const bashPath = context.commandPaths
		? (context.commandPaths.bash ?? undefined)
		: findExecutable("bash", env, platform);
	const npmPath = context.commandPaths ? (context.commandPaths.npm ?? undefined) : findExecutable("npm", env, platform);
	const providerEnvironment = PROVIDER_ENVIRONMENT_KEYS.some((key) => Boolean(env[key]));
	const nodeSupported = nodeIsSupported(nodeVersion);
	const camoufoxRuntime = inspectJouzuCamoufoxRuntime(context.paths.stateDir);

	if (!nodeSupported) problem("node.unsupported", `Node ${nodeVersion} is unsupported; Jouzu requires >=22.19.0`);
	if (!gitPath) problem("git.missing", "Git was not found on PATH");
	if (!bashPath) problem("bash.missing", "Bash was not found; install Bash or Git Bash");
	if (!npmPath) problem("npm.missing", "npm was not found on PATH; npm is required for Jouzu updates");
	if (context.metadata.piVersion !== context.piRuntimeVersion) {
		problem(
			"pi.versionMismatch",
			`Pinned Pi ${context.metadata.piVersion} does not match loaded runtime ${context.piRuntimeVersion}`,
		);
	}
	if (context.piRuntimeDiagnostic) {
		problem("pi.runtimeUnavailable", `Pi runtime could not be loaded: ${context.piRuntimeDiagnostic}`);
	}
	if (context.metadata.lock.compatibilityStatus !== "qualified") {
		problem("pi.lockUnqualified", `Pi lock status is ${context.metadata.lock.compatibilityStatus}, not qualified`);
	}
	if (!existsSync(authPath) && !providerEnvironment && !existsSync(modelsPath)) {
		warning(
			"provider.unconfigured",
			"No obvious provider credential or custom model configuration was found; use /login or provider environment variables",
		);
	}
	if (!context.profile.appliedManifestSha256) {
		warning("profile.notApplied", 'The selected profile has not been applied; run "jouzu profile apply"');
	} else if (
		context.desiredProfileManifestSha256 &&
		context.profile.appliedManifestSha256 !== context.desiredProfileManifestSha256
	) {
		warning("profile.drift", 'The applied profile differs from the bundled manifest; run "jouzu profile plan"');
	}
	if (packageState.warning) warning("packages.invalid", packageState.warning);
	if (context.updateStatus?.state.lastResult === "failed") {
		warning(
			"update.lastFailed",
			`The last Jouzu update operation failed (${context.updateStatus.state.lastErrorCode ?? "unknown"})`,
		);
	}
	if (context.updateDiagnostic) {
		warning("update.statusUnavailable", `Self-update status is unavailable: ${context.updateDiagnostic}`);
	}
	if (context.keybindingPlan?.actions.some((action) => action.type === "conflict")) {
		warning(
			"keybindings.conflict",
			'Jouzu keybinding defaults conflict with user bindings; run "jouzu keybindings plan"',
		);
	}
	if (context.keybindingDiagnostic) {
		warning("keybindings.statusUnavailable", `Keybinding status is unavailable: ${context.keybindingDiagnostic}`);
	}
	if (context.releaseExtensionStatus?.errors.length) {
		problem(
			"extensions.unavailable",
			`Required release extensions are unavailable: ${context.releaseExtensionStatus.errors.join("; ")}`,
		);
	}
	if (context.releaseExtensionStatus?.degradedExtensions.length) {
		const failures = context.releaseExtensionStatus.degradedExtensions.map((failure) => {
			const tools = failure.tools.length > 0 ? `; disabled tools: ${failure.tools.join(", ")}` : "";
			const error = failure.error.trim().replace(/\.+$/u, "");
			return `${failure.packageName}@${failure.packageVersion}${tools}: ${error}`;
		});
		problem(
			"extensions.optionalUnavailable",
			`Optional release extensions are unavailable: ${failures.join("; ")}. Correct the reported platform or package error, then rerun \`jz doctor\`.`,
		);
	}
	if (context.releaseExtensionDiagnostic) {
		problem(
			"extensions.manifestInvalid",
			`Release extension inventory is unavailable: ${context.releaseExtensionDiagnostic}`,
		);
	}
	if (camoufoxRuntime.status === "invalid") {
		problem(
			"camoufox.runtimeInvalid",
			`The optional Camoufox runtime is invalid at ${camoufoxRuntime.installRoot}; remove that directory and retry a browser tool`,
		);
	}
	let modelPickerState = "absent";
	if (existsSync(modelPickerStatePath)) {
		try {
			const state = loadModelPickerState(context.paths, { recover: false }).state;
			modelPickerState = `${Object.keys(state.defaults.projects).length} project defaults; ${state.favorites.length} favorites; ${state.recents.global.length} global recents; ${Object.keys(state.recents.projects).length} project scopes`;
		} catch (error) {
			modelPickerState = "unreadable";
			warning(
				"modelPicker.unreadable",
				`Model picker state is unreadable: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	field("runtime", "jouzu.version", "Jouzu version", context.metadata.displayVersion);
	field("runtime", "pi.runtime", "Pi runtime", context.piRuntimeVersion);
	field("runtime", "pi.upstream", "Pi upstream", `${context.metadata.lock.tag} (${context.metadata.lock.tagCommit})`);
	if (context.metadata.lock.commit !== context.metadata.lock.tagCommit) {
		field("runtime", "pi.packageSource", "Pi package source", context.metadata.lock.commit);
	}
	field(
		"runtime",
		"pi.qualification",
		"Pi qualification",
		`${context.metadata.lock.compatibilityStatus}; deviations=${context.metadata.lock.deviations.length}`,
	);
	field("runtime", "profile.schema", "Profile schema", String(context.metadata.profileSchemaVersion));
	field(
		"runtime",
		"extensions.releaseOwned",
		"Release-owned extensions",
		context.releaseExtensionStatus
			? `${context.releaseExtensionStatus.extensionCount} selected; ${context.releaseExtensionStatus.resolvedExtensionPaths.length} ready; ${context.releaseExtensionStatus.degradedExtensions.length} optional unavailable${context.releaseExtensionStatus.errors.length > 0 ? "; required unavailable" : ""}`
			: "unavailable",
	);
	field(
		"runtime",
		"skills.packageOwned",
		"Package-owned skills",
		context.releaseExtensionStatus
			? `${context.releaseExtensionStatus.skillCount} selected; ${context.releaseExtensionStatus.resolvedSkillPaths.length} ready`
			: "unavailable",
	);
	field(
		"runtime",
		"extensions.compatibilityDependencies",
		"Extension compatibility dependencies",
		context.releaseExtensionStatus
			? `${context.releaseExtensionStatus.manifest.compatibilityDependencies.length} selected`
			: "unavailable",
	);
	field(
		"runtime",
		"camoufox.runtime",
		"Optional Camoufox runtime",
		camoufoxRuntime.status === "not-installed"
			? "not installed; installs on first browser tool use"
			: camoufoxRuntime.status,
	);
	field(
		"runtime",
		"update.installChannel",
		"Install channel",
		describeInstallChannel(context.updateStatus?.installChannel),
	);
	field("runtime", "executable", "Executable", context.executable);
	field("runtime", "update.policy", "Self-update policy", context.updateStatus?.policy ?? "unavailable");
	field("runtime", "update.channel", "Self-update channel", context.updateStatus?.installChannel ?? "unavailable");
	field(
		"runtime",
		"update.startupEligible",
		"Automatic startup update",
		context.updateStatus ? (context.updateStatus.startupEligible ? "eligible" : "not eligible") : "unavailable",
	);
	field("runtime", "update.lastCheckedAt", "Last update check", context.updateStatus?.state.lastCheckedAt ?? "never");
	field(
		"runtime",
		"update.latestVersion",
		"Latest observed Jouzu",
		context.updateStatus?.state.latestVersion ?? "not checked",
	);
	field("runtime", "keybindings.status", "Keybinding defaults", context.keybindingPlan?.status ?? "unavailable");
	field("runtime", "keybindings.policy", "Keybinding policy", context.keybindingPlan?.policy ?? "unavailable");
	field("runtime", "keybindings.followUpKey", "Jouzu default follow-up key", "ctrl+enter");
	field("runtime", "keybindings.dequeueKey", "Jouzu default dequeue key", "ctrl+up");
	field("runtime", "keybindings.configPath", "Keybinding config", context.keybindingPlan?.configPath ?? "unavailable");

	field("platform", "platform", "Platform", `${platform} ${architecture}`);
	field("platform", "node", "Node", `${nodeVersion} (${nodeSupported ? "supported" : "unsupported"})`);
	field("platform", "locale", "Locale", locale);
	field("platform", "git", "Git", gitPath ?? "not found");
	field("platform", "bash", "Bash", bashPath ?? "not found");
	field("platform", "npm", "npm", npmPath ?? "not found");
	field("platform", "proxy", "Proxy configured", env.HTTP_PROXY || env.HTTPS_PROXY ? "yes" : "no");
	field("platform", "extraCaCerts", "Additional CA configured", env.NODE_EXTRA_CA_CERTS ? "yes" : "no");

	field("roots", "paths.agentDir", "Agent/config root", context.paths.agentDir);
	field("roots", "paths.stateDir", "State root", context.paths.stateDir);
	field("roots", "paths.sessionDir", "Session root", context.paths.sessionDir);
	field("roots", "paths.cacheDir", "Cache root", context.paths.cacheDir);
	field("roots", "modelPicker.state", "Model picker state", modelPickerState);
	field(
		"roots",
		"isolation.piAgentDir",
		"Inherited Pi agent root replaced",
		context.inheritedPiAgentDir ? "yes" : "not set",
	);
	field(
		"roots",
		"isolation.piSessionDir",
		"Inherited Pi session root replaced",
		context.inheritedPiSessionDir ? "yes" : "not set",
	);
	const now = new Date();
	const stateLocks = [
		{ id: "lock.profile", label: "Profile lock", file: "profile.lock", staleMs: STATE_LOCK_STALE_MS },
		{ id: "lock.piImport", label: "Pi import lock", file: "pi-import.lock", staleMs: STATE_LOCK_STALE_MS },
		{ id: "lock.keybindings", label: "Keybinding lock", file: "keybindings.lock", staleMs: STATE_LOCK_STALE_MS },
		{ id: "lock.modelPicker", label: "Model picker lock", file: "model-picker.lock", staleMs: STATE_LOCK_STALE_MS },
		{ id: "lock.update", label: "Update lock", file: "self-update.lock", staleMs: STATE_LOCK_STALE_MS },
		{
			id: "lock.camoufoxRuntime",
			label: "Camoufox runtime install lock",
			file: pathApi.relative(context.paths.stateDir, resolveCamoufoxRuntimePaths(context.paths.stateDir).installLock),
			staleMs: CAMOUFOX_INSTALL_LOCK_STALE_MS,
		},
	];
	for (const { id, label, file, staleMs } of stateLocks) {
		const path = pathApi.join(context.paths.stateDir, file);
		field("roots", id, label, describeStateLock(path, staleMs, now));
		const status = inspectStateLock(path, now).status;
		if (status === "held-dead" || status === "owner-unknown" || status === "invalid") {
			problem(`${id}.stale`, `A leftover state lock blocks Jouzu operations: ${path} (${status})`);
		}
	}
	field(
		"roots",
		"skills.shared",
		"Shared cross-harness skills",
		`${sharedSkillsPath} (${existsSync(sharedSkillsPath) ? "present" : "absent"})`,
	);

	field("profile", "profile.selected", "Selected profile", `${context.profile.id} (${context.profile.source})`);
	field(
		"profile",
		"profile.bundledManifest",
		"Bundled profile manifest",
		context.desiredProfileManifestSha256 ?? "unavailable",
	);
	field(
		"profile",
		"profile.appliedManifest",
		"Applied profile manifest",
		context.profile.appliedManifestSha256 ?? "not applied",
	);
	field("profile", "packages.count", "Configured Pi packages", String(packageState.count));
	field("profile", "provider.authFile", "Provider auth file", existsSync(authPath) ? "present" : "absent");
	field("profile", "provider.modelsFile", "Custom models file", existsSync(modelsPath) ? "present" : "absent");
	field("profile", "provider.environment", "Provider environment", providerEnvironment ? "present" : "not detected");

	notes.push(
		"Isolation: stock Pi global config, auth, packages, and sessions are not imported. Project resources and ~/.agents/skills remain shared Pi compatibility surfaces.",
	);

	const report: DoctorReport = {
		schemaVersion: 1,
		experimental: true,
		healthy: !issues.some((issue) => issue.severity === "problem"),
		fields,
		issues,
		notes,
	};
	return { text: formatDoctorReport(report), healthy: report.healthy, report };
}
