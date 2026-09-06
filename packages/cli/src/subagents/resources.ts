import { join } from "node:path";
import {
	DefaultResourceLoader,
	type ExtensionContext,
	loadProjectContextFiles,
	loadSkills,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { CompactionRequestController, registerCompactionRequest } from "../compaction-request.js";
import { brandDefaultSystemPrompt, buildCapabilityRoutingGuidance } from "../presentation.js";
import { writeFilePrivateAtomic } from "../private-fs.js";
import { loadBundledProfile } from "../profiles.js";
import { inspectReleaseExtensions, omitOptionalReleaseExtensionFailures } from "../release-extensions.js";
import type { WorkerLaunch } from "./protocol.js";

export const CHILD_EXTENSION_PACKAGES = new Set([
	"@sting8k/pi-vcc",
	"@lhl/pi-tasks",
	"pi-webaio",
	"jouzu-camoufox-adapter",
]);
export const CHILD_EXTRA_TOOLS = [
	"vcc_recall",
	"compact_context",
	"web_fetch",
	"batch_web_fetch",
	"tff-fetch_url",
	"tff-search_web",
	"TaskCreate",
	"TaskCreateMany",
	"TaskGet",
	"TaskList",
	"TaskUpdate",
] as const;

/** Called only inside a dedicated worker, before loading extension factories. */
export function configureChildResources(launch: WorkerLaunch): void {
	process.env.PI_CODING_AGENT_DIR = launch.directory;
	process.env.PI_CODING_AGENT_SESSION_DIR = launch.directory;
	process.env.PI_TASKS = join(launch.directory, "tasks.json");
	process.env.PI_VCC_CONFIG_PATH = join(launch.directory, "pi-vcc-config.json");
	process.env.JOUZU_RUNTIME_STATE_DIR = launch.runtimeStateDir ?? launch.directory;
	// Pi owns between-turn continuation; do not leave a VCC timer racing worker exit.
	writeFilePrivateAtomic(
		process.env.PI_VCC_CONFIG_PATH,
		`${JSON.stringify({
			overrideDefaultCompaction: true,
			smartKeepTail: true,
			continueAfterThresholdCompact: false,
			debug: false,
		})}\n`,
	);
	writeFilePrivateAtomic(
		join(launch.directory, "tasks-config.json"),
		`${JSON.stringify({
			taskScope: "session",
			autoMode: "off",
			autoClearCompleted: "never",
		})}\n`,
	);
}

export async function childResourceLoader(launch: WorkerLaunch) {
	const compaction = new CompactionRequestController();
	const bundledSkills: string[] = [];
	const profile = loadBundledProfile(launch.profile ?? "core");
	for (const asset of profile.assets) {
		if (!asset.target.startsWith("skills/")) continue;
		const path = join(launch.directory, asset.target);
		writeFilePrivateAtomic(path, asset.bytes.toString("utf8"));
		bundledSkills.push(path);
	}
	const skills = loadSkills({
		cwd: launch.cwd,
		agentDir: launch.userAgentDir ?? launch.directory,
		skillPaths: bundledSkills,
		includeDefaults: true,
	});
	// Workflow controls stay with the coordinator; their skill must not advertise absent tools.
	skills.skills = skills.skills.filter((skill) => skill.name !== "multiloop");
	const release = inspectReleaseExtensions();
	const selected = release.resolvedExtensions.filter((entry) => CHILD_EXTENSION_PACKAGES.has(entry.packageName));
	for (const name of CHILD_EXTENSION_PACKAGES) {
		const record = release.manifest.packages.find((entry) => entry.name === name);
		if (!record?.optional && !selected.some((entry) => entry.packageName === name))
			throw new Error(`Resources: child extension ${name} is unavailable. Run jz doctor and repair the installation.`);
	}
	const loader = new DefaultResourceLoader({
		// Extension configuration and task state belong to the child, not its project or parent.
		cwd: launch.directory,
		agentDir: launch.directory,
		settingsManager: SettingsManager.inMemory(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: selected.map((entry) => entry.path),
		skillsOverride: () => skills,
		agentsFilesOverride: () => ({
			agentsFiles: loadProjectContextFiles({
				cwd: launch.cwd,
				agentDir: launch.userAgentDir ?? launch.directory,
			}),
		}),
		systemPromptOverride: () => undefined,
		appendSystemPromptOverride: () => [
			...profile.assets
				.filter((asset) => asset.target === "APPEND_SYSTEM.md")
				.map((asset) => asset.bytes.toString("utf8")),
			launch.role.instructions,
			`You are a child agent working in ${launch.cwd}. This workspace sets the default directory, not a filesystem sandbox. Read project material and skill references wherever needed; keep edits within the assigned scope. Do not start other agents, scheduled jobs, or autonomous loops. Your task list and vcc_recall history belong to this child session. Report evidence, check results, and blockers to the coordinator.`,
		],
		extensionsOverride: (base) => {
			const result = omitOptionalReleaseExtensionFailures(base, release);
			for (const extension of result.extensions) {
				for (const name of extension.tools.keys())
					if (!(CHILD_EXTRA_TOOLS as readonly string[]).includes(name)) extension.tools.delete(name);
				// No headless slash-command path should activate a task runner or change session policy.
				extension.commands.clear();
				if (selected.some((entry) => entry.packageName === "@lhl/pi-tasks" && entry.path === extension.path)) {
					for (const [event, handlers] of extension.handlers)
						extension.handlers.set(
							event,
							handlers.map(
								(handler) => (value, ctx) => handler(value, { ...(ctx as ExtensionContext), cwd: launch.directory }),
							),
						);
					for (const { definition } of extension.tools.values()) {
						const execute = definition.execute;
						definition.execute = (id, args, signal, update, ctx) =>
							execute(id, args, signal, update, { ...ctx, cwd: launch.directory });
					}
				}
			}
			return result;
		},
		extensionFactories: [
			{
				name: "jouzu-child",
				factory: (pi) => {
					registerCompactionRequest(pi, compaction);
					pi.on("before_agent_start", (event) => ({
						systemPrompt: brandDefaultSystemPrompt(
							event.systemPrompt,
							undefined,
							buildCapabilityRoutingGuidance(event.systemPromptOptions),
						),
					}));
				},
			},
		],
	});
	await loader.reload();
	const errors = loader.getExtensions().errors;
	if (errors.length)
		throw new Error(
			`Resources: child extensions failed to load (${errors.map((error) => error.path).join(", ")}). Run jz doctor.`,
		);
	return Object.assign(loader, { compaction });
}
