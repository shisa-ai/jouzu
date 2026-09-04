import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatHelp, isBlockedPiSelfUpdate, parseJouzuArgs, UsageError } from "./args.js";
import { catalogStatus, formatCatalogStatus, validateCatalogFile } from "./catalog-command.js";
import { createDoctorReport } from "./doctor.js";
import { createJouzuHelpExtension } from "./help.js";
import {
	applyKeybindings,
	ensureDefaultKeybindings,
	formatKeybindingPlan,
	KeybindingConfigError,
	KeybindingConflictError,
	planKeybindings,
	resetKeybindings,
} from "./keybindings.js";
import { loadMetadata } from "./metadata.js";
import {
	acceptQuarantinedCatalog,
	refreshAllModelCatalogs,
	refreshAvailableModelCatalogs,
	refreshModelCatalog,
} from "./model-catalog-sync.js";
import { createJouzuModelPicker } from "./model-picker.js";
import { projectDefaultAppliesAtStartup } from "./model-picker-state.js";
import { resolveJouzuPaths } from "./paths.js";
import { offerPiConfigurationImport, PiImportError } from "./pi-import.js";
import { clearInteractiveStartup, createJouzuPresentationExtension, isInteractivePiStartup } from "./presentation.js";
import { promptForJapaneseSupport, writeProfileChoice } from "./profile-choice.js";
import {
	applyProfile,
	formatProfilePlan,
	ProfileConflictError,
	ProfileStateError,
	planProfile,
} from "./profile-manager.js";
import { loadBundledProfile } from "./profiles.js";
import {
	createReleaseExtensionDiagnostics,
	ensureReleaseRuntimeCompatibility,
	inspectReleaseExtensions,
	probeReleaseRuntimeCompatibility,
	usesReleaseExtensions,
	withReleaseExtensionArguments,
	withReleaseExtensionConflictPolicy,
} from "./release-extensions.js";
import { withJouzuResumeHint } from "./resume.js";
import { configurePiProcess, type ProfileSelection, resolveProfileSelection } from "./runtime.js";
import { createSessionUiExtension } from "./session-ui/index.js";
import { ensureQuietStartupDefault, suppressPiReleaseNotes } from "./startup-settings.js";
import { JouzuUpdater } from "./updater.js";

async function loadPiRuntime(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
	return import("@earendil-works/pi-coding-agent");
}

export async function runMainCli(args: string[]): Promise<void> {
	const parsed = parseJouzuArgs(args);
	if (parsed.kind === "self-update") throw new Error("self-update must be handled by the lightweight CLI bootstrap");
	if (parsed.kind === "help") {
		console.log(formatHelp());
		return;
	}
	if (parsed.kind === "pi" && isBlockedPiSelfUpdate(parsed.args)) {
		throw new UsageError(
			"Jouzu pins its Pi runtime and cannot run Pi self-update. Upgrade Jouzu instead; package-only updates such as `jz update --extensions` remain available.",
		);
	}

	const paths = resolveJouzuPaths({ homeOverride: parsed.options.home });
	const metadata = loadMetadata();
	const interactiveStartup = parsed.kind === "pi" && isInteractivePiStartup(parsed.args);
	const executable = process.argv[1] ?? fileURLToPath(import.meta.url);
	const updater = new JouzuUpdater({
		paths,
		currentVersion: metadata.jouzuVersion,
		executable,
		report: (message) => console.log(message),
	});

	if (parsed.kind === "catalog") {
		if (parsed.operation === "status") {
			const status = catalogStatus(paths, process.env, parsed.sourceId);
			console.log(parsed.json ? JSON.stringify(status, null, 2) : formatCatalogStatus(status));
			return;
		}
		if (parsed.operation === "refresh") {
			if (parsed.sourceId) {
				const result = await refreshModelCatalog(paths, { sourceId: parsed.sourceId });
				console.log(parsed.json ? JSON.stringify(result, null, 2) : formatCatalogStatus(result.catalogStatus));
				if (result.status === "rejected" || result.status === "error") process.exitCode = 1;
				return;
			}
			const result = await refreshAllModelCatalogs(paths);
			console.log(parsed.json ? JSON.stringify(result, null, 2) : formatCatalogStatus(catalogStatus(paths)));
			if (result.status === "partial" || result.status === "failed") process.exitCode = 1;
			return;
		}
		if (parsed.operation === "accept") {
			if (!parsed.revision || !parsed.digest)
				throw new UsageError("catalog accept requires an exact revision and digest");
			console.log(
				formatCatalogStatus(
					acceptQuarantinedCatalog(paths, parsed.revision, parsed.digest, process.env, new Date(), parsed.sourceId),
				),
			);
			return;
		}
		if (!parsed.path) throw new UsageError(`catalog ${parsed.operation} requires a file path`);
		const result = validateCatalogFile(parsed.path, parsed.operation === "conformance");
		console.log(
			parsed.json
				? JSON.stringify(result, null, 2)
				: result.valid
					? "Model catalog is valid."
					: `Model catalog is invalid: ${result.error?.message}`,
		);
		if (!result.valid) process.exitCode = 1;
		return;
	}

	if (parsed.kind === "keybindings") {
		if (parsed.operation === "status" || parsed.operation === "plan") {
			const plan = planKeybindings(paths);
			console.log(parsed.json ? JSON.stringify(plan, null, 2) : formatKeybindingPlan(plan));
			if (plan.actions.some((action) => action.type === "conflict")) process.exitCode = 5;
			return;
		}
		const result = parsed.operation === "apply" ? applyKeybindings(paths) : resetKeybindings(paths);
		console.log(formatKeybindingPlan(result.plan));
		console.log(
			result.changed
				? `${parsed.operation === "apply" ? "Applied" : "Reset"} keybinding transaction: ${result.transactionId}`
				: `Keybinding defaults already ${parsed.operation === "apply" ? "converged" : "disabled"}.`,
		);
		if (result.backupDir) console.log(`Backup: ${result.backupDir}`);
		return;
	}

	const inheritedPiAgentDir = process.env.PI_CODING_AGENT_DIR;
	const inheritedPiSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	const profileChoicePath = join(paths.stateDir, "profile-choice.json");
	let profile: ProfileSelection = resolveProfileSelection(paths, {
		explicitProfile: parsed.options.profile,
		allowSavedChoice: parsed.kind !== "version",
		interactiveStartup,
	});
	let firstRunChoice = false;
	if (profile.needsFirstRunInput) {
		profile = {
			id: await promptForJapaneseSupport(),
			source: "first-run choice",
			needsFirstRunInput: false,
		};
		firstRunChoice = true;
	}

	if (parsed.kind === "profile") {
		const selected = parsed.profile ?? profile.id;
		const bundled = loadBundledProfile(selected);
		if (parsed.operation === "plan") {
			const plan = planProfile(bundled, paths, metadata.jouzuVersion);
			console.log(parsed.json ? JSON.stringify(plan, null, 2) : formatProfilePlan(plan));
			if (plan.actions.some((action) => action.type === "conflict")) process.exitCode = 3;
			return;
		}
		const result = applyProfile(bundled, paths, metadata.jouzuVersion);
		writeProfileChoice(profileChoicePath, selected);
		console.log(formatProfilePlan(result.plan));
		console.log(result.changed ? `Applied transaction: ${result.transactionId}` : "Profile already converged");
		if (result.backupDir) console.log(`Backups: ${result.backupDir}`);
		return;
	}

	if (interactiveStartup) {
		await offerPiConfigurationImport(paths, { inheritedAgentDir: inheritedPiAgentDir });
		ensureQuietStartupDefault(paths);
		suppressPiReleaseNotes(paths, metadata.piVersion);
		const bootstrap = ensureDefaultKeybindings(paths);
		if (bootstrap.message) console.error(bootstrap.message);
	}

	configurePiProcess(paths);
	let pi: typeof import("@earendil-works/pi-coding-agent") | undefined;
	let piRuntimeVersion: string | undefined;
	let piImportDiagnostic: string | undefined;
	try {
		pi = await loadPiRuntime();
		piRuntimeVersion = pi.VERSION;
	} catch (error) {
		piImportDiagnostic = error instanceof Error ? error.message : String(error);
	}

	if (parsed.kind === "version") {
		if (piImportDiagnostic || !piRuntimeVersion) {
			throw new Error(`Jouzu could not load its pinned Pi runtime: ${piImportDiagnostic ?? "unavailable"}`);
		}
		if (piRuntimeVersion !== metadata.piVersion) {
			throw new Error(`loaded Pi ${piRuntimeVersion} does not match Jouzu's exact pin ${metadata.piVersion}`);
		}
		console.log(`jouzu ${metadata.displayVersion}`);
		console.log(`pi ${piRuntimeVersion}`);
		console.log(`profile schema ${metadata.profileSchemaVersion}`);
		return;
	}
	if (parsed.kind === "doctor") {
		const desiredProfile = loadBundledProfile(profile.id);
		let updateStatus: ReturnType<JouzuUpdater["status"]> | undefined;
		let updateDiagnostic: string | undefined;
		let keybindingPlan: ReturnType<typeof planKeybindings> | undefined;
		let keybindingDiagnostic: string | undefined;
		let releaseExtensionStatus: ReturnType<typeof inspectReleaseExtensions> | undefined;
		let releaseExtensionDiagnostic: string | undefined;
		try {
			updateStatus = updater.status();
		} catch (error) {
			updateDiagnostic = error instanceof Error ? error.message : String(error);
		}
		try {
			keybindingPlan = planKeybindings(paths);
		} catch (error) {
			keybindingDiagnostic = error instanceof Error ? error.message : String(error);
		}
		try {
			releaseExtensionStatus = inspectReleaseExtensions();
			probeReleaseRuntimeCompatibility(releaseExtensionStatus);
		} catch (error) {
			releaseExtensionDiagnostic = error instanceof Error ? error.message : String(error);
		}
		const result = createDoctorReport({
			metadata,
			paths,
			profile,
			piRuntimeVersion: piRuntimeVersion ?? "unavailable",
			piRuntimeDiagnostic: piImportDiagnostic,
			executable,
			inheritedPiAgentDir,
			inheritedPiSessionDir,
			desiredProfileManifestSha256: desiredProfile.manifestSha256,
			...(updateStatus ? { updateStatus } : {}),
			...(updateDiagnostic ? { updateDiagnostic } : {}),
			...(keybindingPlan ? { keybindingPlan } : {}),
			...(keybindingDiagnostic ? { keybindingDiagnostic } : {}),
			...(releaseExtensionStatus ? { releaseExtensionStatus } : {}),
			...(releaseExtensionDiagnostic ? { releaseExtensionDiagnostic } : {}),
		});
		console.log(parsed.json ? JSON.stringify(result.report, null, 2) : result.text);
		if (!result.healthy) process.exitCode = 1;
		return;
	}

	const bundled = loadBundledProfile(profile.id);
	applyProfile(bundled, paths, metadata.jouzuVersion);
	if (firstRunChoice) {
		writeProfileChoice(profileChoicePath, profile.id);
		console.log(profile.id === "ja" ? "Japanese support enabled." : "Continuing with the Core profile.");
	}
	clearInteractiveStartup(parsed.args);
	if (piImportDiagnostic || !pi || !piRuntimeVersion) {
		throw new Error(`Jouzu could not load its pinned Pi runtime: ${piImportDiagnostic ?? "unavailable"}`);
	}
	if (piRuntimeVersion !== metadata.piVersion) {
		throw new Error(`loaded Pi ${piRuntimeVersion} does not match Jouzu's exact pin ${metadata.piVersion}`);
	}
	const modelPicker = createJouzuModelPicker(paths, {
		applyProjectDefaultAtStartup: interactiveStartup && projectDefaultAppliesAtStartup(parsed.args),
		restoreLastModelAtStartup: interactiveStartup && projectDefaultAppliesAtStartup(parsed.args),
	});
	if (interactiveStartup) {
		// Best-effort catalog refresh in the background: a source is contacted only
		// when its credential is available, and cached revisions keep serving.
		void refreshAvailableModelCatalogs(paths)
			.then((result) => {
				if (result) modelPicker.reloadCatalogs();
			})
			.catch(() => {});
	}
	const help = createJouzuHelpExtension();
	const effectiveKeyText = (action: "app.model.select" | "app.model.cycleForward") => pi.keyText(action) || "unbound";
	const sessionUi = createSessionUiExtension({
		getHints: () => [
			{
				id: "palette.shortcuts",
				text: `${effectiveKeyText("app.model.select")} models · ${effectiveKeyText("app.model.cycleForward")} favorites · Ctrl+/ help`,
				priority: 10,
				role: "muted",
			},
		],
		onModelPicker: (query) =>
			modelPicker.open({ source: query ? "command" : "action", ...(query ? { initialSearchInput: query } : {}) }),
		onModelCycle: (direction) => modelPicker.cycleFavorite(direction),
		onScopedModelsCommand: () => modelPicker.handleScopedModelsCommand(),
	});
	const releaseExtensionStatus = inspectReleaseExtensions();
	probeReleaseRuntimeCompatibility(releaseExtensionStatus);
	ensureReleaseRuntimeCompatibility(releaseExtensionStatus);
	const piArgs = withReleaseExtensionArguments(parsed.args, releaseExtensionStatus);
	const releaseDiagnostics = createReleaseExtensionDiagnostics(releaseExtensionStatus);
	const startPi = () =>
		pi.main(piArgs, {
			extensionFactories: [
				createJouzuPresentationExtension(metadata, profile),
				sessionUi,
				modelPicker.extension,
				help,
				releaseDiagnostics,
			],
		});
	await withJouzuResumeHint(() =>
		usesReleaseExtensions(parsed.args)
			? withReleaseExtensionConflictPolicy(pi, releaseExtensionStatus, startPi)
			: startPi(),
	);
}

export function handleMainCliError(error: unknown): void {
	if (error instanceof PiImportError) {
		console.error(`Jouzu Pi import failed: ${error.message}`);
		process.exitCode = error.exitCode;
		return;
	}
	if (error instanceof KeybindingConflictError) {
		console.error(formatKeybindingPlan(error.plan));
		console.error('Resolve the conflicts above, then run "jouzu keybindings apply" again.');
		process.exitCode = error.exitCode;
		return;
	}
	if (error instanceof KeybindingConfigError) {
		console.error(`Jouzu keybindings failed: ${error.message}`);
		process.exitCode = error.exitCode;
		return;
	}
	if (error instanceof ProfileStateError) {
		console.error(`Jouzu profile state is unreadable: ${error.message}`);
		console.error(
			'Recovery: repair or remove the profile state file, then run "jouzu profile plan" and "jouzu profile apply" again.',
		);
		process.exitCode = 1;
		return;
	}
	if (error instanceof ProfileConflictError) {
		console.error(formatProfilePlan(error.plan));
		console.error('Resolve the conflicts above, then run "jouzu profile apply" again.');
		process.exitCode = error.exitCode;
		return;
	}
	if (error instanceof UsageError) {
		console.error(`Error: ${error.message}`);
		console.error('Run "jouzu --help" for Jouzu usage or "jouzu pi --help" for Pi usage.');
		process.exitCode = error.exitCode;
		return;
	}
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Jouzu failed: ${message}`);
	process.exitCode = 1;
}
