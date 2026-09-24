import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DefaultResourceLoader,
	type ExtensionContext,
	type InlineExtension,
	loadProjectContextFiles,
	loadSkills,
	type ResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { CompactionRequestController, registerCompactionRequest } from "../compaction-request.js";
import { buildModelGuidance } from "../model-guidance.js";
import { brandDefaultSystemPrompt, buildCapabilityRoutingGuidance } from "../presentation.js";
import { validatePrivateDirectory, writeFilePrivateAtomic } from "../private-fs.js";
import { loadBundledProfile } from "../profiles.js";
import { inspectReleaseExtensions, omitOptionalReleaseExtensionFailures } from "../release-extensions.js";
import { createToolArgumentExtension } from "../tool-arguments.js";
import type { WorkerLaunch } from "./protocol.js";

/** Cancel worker-local schedules before restored flow receipts inspect their state. */
function disableChildSchedules(directory: string): number {
	const stateDirectory = join(directory, ".pi");
	validatePrivateDirectory(directory);
	validatePrivateDirectory(stateDirectory);
	const path = join(stateDirectory, "schedule-prompts.json");
	let metadata: ReturnType<typeof lstatSync>;
	try {
		metadata = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
	if (!metadata.isFile() || metadata.size > 4 * 1024 * 1024)
		throw new Error("Child schedule storage must be a regular file of at most 4 MB.");
	const store = JSON.parse(readFileSync(path, "utf8")) as { version: number; jobs: { enabled: boolean }[] };
	if (
		store?.version !== 1 ||
		!Array.isArray(store.jobs) ||
		store.jobs.some((job) => !job || typeof job.enabled !== "boolean")
	)
		throw new Error("Child schedule storage has an unsupported format.");
	const cancelled = store.jobs.filter((job) => job.enabled).length;
	if (!cancelled) return 0;
	for (const job of store.jobs) job.enabled = false;
	writeFilePrivateAtomic(path, `${JSON.stringify(store)}\n`, directory);
	return cancelled;
}

/** Configure process-global extension discovery only inside the dedicated worker. */
export function configureChildResources(launch: WorkerLaunch): number {
	const cancelledSchedules = disableChildSchedules(launch.directory);
	process.env.PI_CODING_AGENT_DIR = launch.directory;
	process.env.PI_CODING_AGENT_SESSION_DIR = launch.directory;
	process.env.PI_TASKS = join(launch.directory, "tasks.json");
	process.env.PI_VCC_CONFIG_PATH = join(launch.directory, "pi-vcc-config.json");
	process.env.JOUZU_RUNTIME_STATE_DIR = launch.runtimeStateDir ?? launch.directory;
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
	return cancelledSchedules;
}

/** Build the released capability set, with automation state owned by the child. */
export async function expandedChildResourceLoader(
	launch: WorkerLaunch,
	contentPolicy: ResourceLoader["contentPolicy"],
	extensionFactories: InlineExtension[] = [],
) {
	const compaction = new CompactionRequestController();
	const profile = loadBundledProfile(launch.profile ?? "core");
	const bundledSkills: string[] = [];
	for (const asset of profile.assets) {
		if (!asset.target.startsWith("skills/")) continue;
		const path = join(launch.directory, asset.target);
		writeFilePrivateAtomic(path, asset.bytes.toString("utf8"));
		bundledSkills.push(path);
	}
	const release = inspectReleaseExtensions();
	if (release.errors.length)
		throw new Error("Resources: child extensions are unavailable. Run jz doctor and repair the installation.");
	const skills = loadSkills({
		cwd: launch.cwd,
		agentDir: launch.userAgentDir ?? launch.directory,
		skillPaths: [...bundledSkills, ...release.resolvedSkillPaths],
		includeDefaults: true,
		admissionLimits: contentPolicy ? true : undefined,
	});
	const statePackages = new Set(["@lhl/pi-tasks", "pi-multiloop"]);
	const stateControllers = new Set([
		"<inline:jouzu-task-controller>",
		"<inline:jouzu-multiloop-controller>",
		"<inline:jouzu-schedule-waits>",
	]);
	const loader = new DefaultResourceLoader({
		cwd: launch.directory,
		agentDir: launch.directory,
		contentPolicy,
		settingsManager: SettingsManager.inMemory(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: release.resolvedExtensions
			.filter((entry) => entry.packageName !== "pi-schedule-prompt")
			.map((entry) => entry.path),
		skillsOverride: () => skills,
		agentsFilesOverride: () => ({
			agentsFiles: launch.role.judging
				? []
				: loadProjectContextFiles({
						cwd: launch.cwd,
						agentDir: launch.userAgentDir ?? launch.directory,
					}),
		}),
		systemPromptOverride: () => undefined,
		appendSystemPromptOverride: () =>
			[
				...profile.assets
					.filter((asset) => asset.target === "APPEND_SYSTEM.md")
					.map((asset) => asset.bytes.toString("utf8")),
				launch.role.instructions,
				buildModelGuidance(launch.model.id, launch.role.tools),
				`You are a child agent working in ${launch.cwd}. This workspace is the default directory, not a filesystem sandbox. Keep edits within the assigned scope. Your task list, loops, and recall history belong to this child session. Scheduling and delegation belong to the parent. Return any scheduling or delegation request to the coordinator; do not create schedules or launch other agents through tools or shell commands. Automation state is stored in ${launch.directory}; run project checks in ${launch.cwd}. Report evidence, check results, and blockers to the coordinator.`,
			].filter(Boolean),
		extensionsOverride: (base) => {
			const result = omitOptionalReleaseExtensionFailures(base, release);
			for (const extension of result.extensions) {
				if (
					!stateControllers.has(extension.path) &&
					!release.resolvedExtensions.some(
						(entry) => statePackages.has(entry.packageName) && entry.path === extension.path,
					)
				)
					continue;
				// These packages locate writable state through context.cwd. Tools such as bash and read
				// continue to use the assigned workspace; no shared project automation is reopened.
				for (const [event, handlers] of extension.handlers)
					extension.handlers.set(
						event,
						handlers.map(
							(handler) => (value, ctx) => handler(value, { ...(ctx as ExtensionContext), cwd: launch.directory }),
						),
					);
				for (const command of extension.commands.values()) {
					const handler = command.handler;
					command.handler = (args, ctx) => handler(args, { ...ctx, cwd: launch.directory });
				}
				for (const { definition } of extension.tools.values()) {
					const execute = definition.execute;
					definition.execute = (id, args, signal, update, ctx) =>
						execute(id, args, signal, update, { ...ctx, cwd: launch.directory });
				}
			}
			return result;
		},
		extensionFactories: [
			createToolArgumentExtension(),
			...extensionFactories,
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
	if (loader.getExtensions().errors.length)
		throw new Error("Resources: child extensions failed to load. Run jz doctor and repair the installation.");
	return Object.assign(loader, { compaction });
}
