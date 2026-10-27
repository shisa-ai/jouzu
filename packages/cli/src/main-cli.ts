import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatHelp, isBlockedPiSelfUpdate, parseJouzuArgs, UsageError, usageErrorMessage } from "./args.js";
import { createAstraCompatibilityExtension } from "./astra-compatibility.js";
import {
	catalogStatus,
	catalogValidationMessage,
	formatCatalogStatus,
	validateCatalogFile,
} from "./catalog-command.js";
import { classicHostBuiltinOverrides, createDirectToolPolicyExtension } from "./classic-host-policy.js";
import {
	CatalogError,
	CatalogMessageId,
	catalogMessage,
	catalogMessageText,
	catalogText,
	defaultCatalog,
} from "./cli-messages.js";
import { DashboardVisibility, loadDashboardPolicy } from "./dashboard-policy.js";
import { createDisplayCatalog } from "./display-catalog.js";
import { createDoctorReport } from "./doctor.js";
import { createFastModeExtension, FAST_MODE_STATUS } from "./fast-mode.js";
import { CliMessageId, protectedSourceError } from "./human-messages.js";
import { isInteractivePiStartup, usesMachineReadableStdout } from "./interactive-startup.js";
import { formatKeyId } from "./keybinding-hints.js";
import {
	applyKeybindings,
	ensureDefaultKeybindings,
	formatKeybindingPlan,
	KeybindingConfigError,
	KeybindingConflictError,
	planKeybindings,
	resetKeybindings,
} from "./keybindings.js";
import { createLabelPolicy } from "./label-policy.js";
import { promptForLanguageChoice, saveLanguageChoice } from "./language-choice.js";
import { createLanguageContractExtension } from "./language-contract.js";
import { readProjectArtifactPolicy, resolveArtifactPolicy, resolveResponseLanguage } from "./language-settings.js";
import { type CatalogBundle, resolveCatalog, summarizeCatalog } from "./locale-catalog.js";
import { catalogSupportStates } from "./locale-status.js";
import { loadMetadata } from "./metadata.js";
import { catalogRegistrationGaps, catalogThinkingLevelGaps } from "./model-catalog.js";
import {
	acceptQuarantinedCatalog,
	loadActiveModelCatalogs,
	pendingStartupCatalogSources,
	refreshAllModelCatalogs,
	refreshAvailableModelCatalogs,
	refreshModelCatalog,
	refreshModelCatalogSources,
} from "./model-catalog-sync.js";
import { projectDefaultAppliesAtStartup } from "./model-picker-state.js";
import { resolveJouzuPaths } from "./paths.js";
import { offerPiConfigurationImport, PiImportError } from "./pi-import.js";
import { buildPreRuntimeContext } from "./pre-runtime.js";
import { writeProfileChoice } from "./profile-choice.js";
import {
	applyProfile,
	formatProfilePlan,
	ProfileConflictError,
	ProfileStateError,
	planProfile,
} from "./profile-manager.js";
import { runProfileMigrationCommand } from "./profile-migration-command.js";
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
import { createResponsesToolSchemaExtension } from "./responses-tool-schema.js";
import { configurePiProcess, type ProfileSelection, resolveProfileSelection } from "./runtime.js";
import { createRuntimeDiagnostics } from "./runtime-diagnostics.js";
import { withJouzuOutput } from "./runtime-output.js";
import { createScrollbackSessionObserver } from "./scrollback-session.js";
import { sessionActivity } from "./session-activity.js";
import { createSessionLabelsExtension } from "./session-labels.js";
import { createShisaExtension } from "./shisa-link/extension.js";
import { offerShisaOnboarding } from "./shisa-link/onboarding.js";
import { ensureQuietStartupDefault, suppressPiReleaseNotes } from "./startup-settings.js";
import { createToolArgumentExtension } from "./tool-arguments.js";
import { osLocaleCandidates, readLocalizationSettings, resolveUiLocale, UiLocaleUsageError } from "./ui-locale.js";
import { JouzuUpdater } from "./updater.js";
import {
	activeChildCount,
	createChildWorkSource,
	createClaimedWorkSource,
	createFlowWorkSource,
	jobWorkUnits,
	taskWorkUnits,
	type WidgetClaimChannel,
} from "./work-dashboard-sources.js";

export const STARTUP_CATALOG_TIMEOUT_MS = 8_000;

async function loadPiRuntime(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
	return import("@earendil-works/pi-coding-agent");
}

export async function runMainCli(args: string[]): Promise<void> {
	const parsed = parseJouzuArgs(args);
	if (parsed.kind === "self-update") throw new Error("self-update must be handled by the lightweight CLI bootstrap");
	if (parsed.kind === "pi" && isBlockedPiSelfUpdate(parsed.args)) {
		throw new UsageError(catalogMessage(CatalogMessageId.usagePinnedPiSelfUpdate));
	}

	const paths = resolveJouzuPaths({ homeOverride: parsed.options.home });
	// Resolve the UI locale from the real startup inputs. This reads the option,
	// the Jouzu environment variable, and the saved settings file, and never
	// writes any of them. The resolved value is carried to the doctor context so
	// the diagnostics issue can render it without re-reading the sources.
	let localizationConfig = readLocalizationSettings(paths.configDir);
	const resolveStartupUiLocale = () =>
		resolveUiLocale({
			...(parsed.options.uiLocale ? { cli: parsed.options.uiLocale } : {}),
			...(process.env.JOUZU_UI_LOCALE ? { env: process.env.JOUZU_UI_LOCALE } : {}),
			config: localizationConfig,
			os: osLocaleCandidates(process.env),
		});
	let uiLocale = resolveStartupUiLocale();
	// Commands share one catalog decision. A successful first-run save below
	// refreshes it before any session extensions capture the display language.
	let preRuntime = buildPreRuntimeContext({
		uiLocale,
		machineReadable: parsed.kind === "acp" || (parsed.kind === "pi" && usesMachineReadableStdout(parsed.args)),
	});
	// One renderer option object and one message helper for every human output
	// below, so no command re-resolves the locale or reads `process` again.
	let renderOptions = { ...preRuntime.display, catalog: preRuntime.catalog.bundle };
	const text = (id: CatalogMessageId, args?: Readonly<Record<string, string | number>>): string =>
		catalogText(preRuntime.catalog.bundle, id, args);
	if (parsed.kind === "help") {
		console.log(
			formatHelp(preRuntime.catalog.bundle, {
				stdoutIsTTY: process.stdout.isTTY === true,
				columns: process.stdout.columns,
			}),
		);
		return;
	}
	if (localizationConfig.status === "future") {
		console.error(text(CatalogMessageId.localizationFuture, { version: localizationConfig.schemaVersion }));
	} else if (localizationConfig.status === "invalid") {
		console.error(text(CatalogMessageId.localizationInvalid, { reason: localizationConfig.reason }));
	}
	const metadata = loadMetadata();
	const interactiveStartup = parsed.kind === "pi" && isInteractivePiStartup(parsed.args);
	const executable = process.argv[1] ?? fileURLToPath(import.meta.url);

	if (parsed.kind === "acp") {
		const { runAcpServer } = await import("./acp.js");
		const childArgs = [executable];
		if (parsed.options.home || process.env.JOUZU_HOME) childArgs.push("--jouzu-home", paths.configDir);
		if (parsed.options.profile) childArgs.push("--jouzu-profile", parsed.options.profile);
		if (parsed.options.uiLocale) childArgs.push("--jouzu-ui-locale", parsed.options.uiLocale);
		if (parsed.options.textguardFiles) childArgs.push("--jouzu-textguard-files");
		if (parsed.options.textguardStrict) childArgs.push("--jouzu-textguard-strict");
		if (parsed.options.textguardOff) childArgs.push("--jouzu-textguard-off");
		await runAcpServer({
			executable: process.execPath,
			args: childArgs,
			sessionDir: paths.sessionDir,
			version: metadata.jouzuVersion,
			catalog: preRuntime.catalog.bundle,
		});
		return;
	}

	if (parsed.kind === "catalog") {
		if (parsed.operation === "status") {
			const status = catalogStatus(paths, process.env, parsed.sourceId, preRuntime.catalog.bundle);
			console.log(parsed.json ? JSON.stringify(status, null, 2) : formatCatalogStatus(status, renderOptions));
			return;
		}
		if (parsed.operation === "refresh") {
			if (parsed.sourceId) {
				const result = await refreshModelCatalog(paths, {
					sourceId: parsed.sourceId,
					catalog: preRuntime.catalog.bundle,
				});
				console.log(
					parsed.json ? JSON.stringify(result, null, 2) : formatCatalogStatus(result.catalogStatus, renderOptions),
				);
				if (result.status === "rejected" || result.status === "error") process.exitCode = 1;
				return;
			}
			const result = await refreshAllModelCatalogs(paths, { catalog: preRuntime.catalog.bundle });
			console.log(
				parsed.json ? JSON.stringify(result, null, 2) : formatCatalogStatus(catalogStatus(paths), renderOptions),
			);
			if (result.status === "partial" || result.status === "failed") process.exitCode = 1;
			return;
		}
		if (parsed.operation === "accept") {
			if (!parsed.revision || !parsed.digest)
				throw new UsageError(catalogMessage(CatalogMessageId.usageCatalogAcceptRevisionDigest));
			console.log(
				formatCatalogStatus(
					acceptQuarantinedCatalog(
						paths,
						parsed.revision,
						parsed.digest,
						process.env,
						new Date(),
						parsed.sourceId,
						preRuntime.catalog.bundle,
					),
					renderOptions,
				),
			);
			return;
		}
		if (!parsed.path)
			throw new UsageError(catalogMessage(CatalogMessageId.usageCatalogFileRequired, { operation: parsed.operation }));
		const result = validateCatalogFile(parsed.path, parsed.operation === "conformance");
		console.log(
			parsed.json
				? JSON.stringify(result, null, 2)
				: result.valid
					? text(CatalogMessageId.catalogValid)
					: text(CatalogMessageId.catalogInvalid, {
							message: catalogValidationMessage(result, preRuntime.catalog.bundle),
						}),
		);
		if (!result.valid) process.exitCode = 1;
		return;
	}

	if (parsed.kind === "keybindings") {
		if (parsed.operation === "status" || parsed.operation === "plan") {
			const plan = planKeybindings(paths, { catalog: preRuntime.catalog.bundle });
			console.log(parsed.json ? JSON.stringify(plan, null, 2) : formatKeybindingPlan(plan, renderOptions));
			if (plan.actions.some((action) => action.type === "conflict")) process.exitCode = 5;
			return;
		}
		const result =
			parsed.operation === "apply"
				? applyKeybindings(paths, new Date(), preRuntime.catalog.bundle)
				: resetKeybindings(paths, new Date(), preRuntime.catalog.bundle);
		console.log(formatKeybindingPlan(result.plan, renderOptions));
		console.log(
			result.changed
				? text(parsed.operation === "apply" ? CatalogMessageId.keybindingsApplied : CatalogMessageId.keybindingsReset, {
						id: String(result.transactionId),
					})
				: text(
						parsed.operation === "apply"
							? CatalogMessageId.keybindingsAlreadyConverged
							: CatalogMessageId.keybindingsAlreadyDisabled,
					),
		);
		if (result.backupDir) console.log(text(CatalogMessageId.backupPath, { path: result.backupDir }));
		return;
	}

	if (parsed.kind === "profile-migration") {
		// The migration entry previews, confirms, applies, and rolls back the
		// Japanese profile migration. A non-interactive run needs the explicit
		// `--yes` confirmation; nothing applies without one.
		const exitCode = await runProfileMigrationCommand(paths, {
			operation: parsed.operation,
			json: parsed.json,
			yes: parsed.yes,
			interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
			...(parsed.options.profile ? { explicitProfile: parsed.options.profile } : {}),
			catalog: preRuntime.catalog.bundle,
			render: renderOptions,
		});
		if (exitCode !== 0) process.exitCode = exitCode;
		return;
	}

	const inheritedPiAgentDir = process.env.PI_CODING_AGENT_DIR;
	const inheritedPiSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	const profileChoicePath = join(paths.stateDir, "profile-choice.json");
	let profile: ProfileSelection = resolveProfileSelection(paths, {
		explicitProfile: parsed.options.profile,
		allowSavedChoice: parsed.kind !== "version",
		interactiveStartup,
		catalog: preRuntime.catalog.bundle,
	});
	let firstRunChoice = false;
	if (profile.needsFirstRunInput) {
		// The first-run screen chooses the interface language by self-name and
		// confirms the response language separately. A skip or a non-interactive
		// run writes nothing, so the saved settings stay byte-identical.
		const choice = await promptForLanguageChoice(process.stdin, process.stdout, {
			catalog: preRuntime.catalog.bundle,
			env: process.env,
		});
		if (choice) {
			try {
				saveLanguageChoice(paths, choice, preRuntime.catalog.bundle);
				// Resolve again from the saved file, retaining CLI/environment
				// precedence rather than treating the choice as an override.
				localizationConfig = readLocalizationSettings(paths.configDir);
				uiLocale = resolveStartupUiLocale();
				preRuntime = buildPreRuntimeContext({ uiLocale, machineReadable: preRuntime.machineReadable });
				renderOptions = { ...preRuntime.display, catalog: preRuntime.catalog.bundle };
				profile = {
					id: "core",
					source: "first-run choice",
					needsFirstRunInput: false,
				};
				firstRunChoice = true;
			} catch (error) {
				console.error(
					catalogText(preRuntime.catalog.bundle, CatalogMessageId.languageChoiceSaveFailed, {
						message: protectedSourceError(error instanceof Error ? error.message : String(error)),
					}),
				);
				profile = { id: "core", source: "default", needsFirstRunInput: false };
			}
		} else {
			profile = { id: "core", source: "default", needsFirstRunInput: false };
		}
	}

	// First-run choices must be saved before the session captures its language
	// contract. Neither response language nor artifact policy consults the UI
	// locale or OS. Without a runtime trust signal, project policy stays unread.
	const savedSettings = localizationConfig.status === "ok" ? localizationConfig.settings : undefined;
	const responseLanguage = resolveResponseLanguage({ config: savedSettings?.responseLanguage });
	const projectPolicy = readProjectArtifactPolicy(process.cwd(), { trusted: false });
	const artifactPolicy = resolveArtifactPolicy({
		...(projectPolicy.status === "ok" ? { project: projectPolicy.artifactPolicy } : {}),
		...(savedSettings?.artifactPolicy ? { config: savedSettings.artifactPolicy } : {}),
	});
	// Register before presentation so staged changes commit before prompt composition.
	const languageContract = createLanguageContractExtension({ responseLanguage, artifactPolicy });
	const updater = new JouzuUpdater({
		paths,
		currentVersion: metadata.jouzuVersion,
		executable,
		report: (message) => console.log(catalogMessageText(preRuntime.catalog.bundle, message)),
		catalog: preRuntime.catalog.bundle,
	});

	if (parsed.kind === "profile") {
		const selected = parsed.profile ?? profile.id;
		const bundled = loadBundledProfile(selected);
		if (parsed.operation === "plan") {
			const plan = planProfile(bundled, paths, metadata.jouzuVersion, preRuntime.catalog.bundle);
			console.log(parsed.json ? JSON.stringify(plan, null, 2) : formatProfilePlan(plan, renderOptions));
			if (plan.actions.some((action) => action.type === "conflict")) process.exitCode = 3;
			return;
		}
		const result = applyProfile(bundled, paths, metadata.jouzuVersion, preRuntime.catalog.bundle);
		writeProfileChoice(profileChoicePath, selected);
		console.log(formatProfilePlan(result.plan, renderOptions));
		console.log(
			result.changed
				? text(CatalogMessageId.profileApplied, { id: String(result.transactionId) })
				: text(CatalogMessageId.profileAlreadyConverged),
		);
		if (result.backupDir) console.log(text(CatalogMessageId.backupsPath, { path: result.backupDir }));
		return;
	}

	if (interactiveStartup) {
		await offerPiConfigurationImport(paths, {
			inheritedAgentDir: inheritedPiAgentDir,
			catalog: preRuntime.catalog.bundle,
		});
		ensureQuietStartupDefault(paths);
		suppressPiReleaseNotes(paths, metadata.piVersion);
		const bootstrap = ensureDefaultKeybindings(paths);
		if (bootstrap.message) console.error(catalogMessageText(preRuntime.catalog.bundle, bootstrap.message));
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
			throw new CatalogError(
				piImportDiagnostic
					? catalogMessage(CatalogMessageId.runtimePiLoadFailed, { diagnostic: piImportDiagnostic })
					: catalogMessage(CatalogMessageId.runtimePiLoadFailedUnavailable),
			);
		}
		if (piRuntimeVersion !== metadata.piVersion) {
			throw new CatalogError(
				catalogMessage(CatalogMessageId.runtimePiPinMismatch, {
					loaded: piRuntimeVersion,
					pinned: metadata.piVersion,
				}),
			);
		}
		console.log(
			catalogText(preRuntime.catalog.bundle, "jouzu.cli.version.jouzu", { version: metadata.displayVersion }),
		);
		console.log(catalogText(preRuntime.catalog.bundle, "jouzu.cli.version.pi", { version: piRuntimeVersion }));
		console.log(
			catalogText(preRuntime.catalog.bundle, "jouzu.cli.version.profileSchema", {
				version: metadata.profileSchemaVersion,
			}),
		);
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
		let catalogSources: Parameters<typeof createDoctorReport>[0]["catalogSources"];
		let catalogDiagnostic: string | undefined;
		// Read the UI locale catalog summary from the already-resolved pre-runtime
		// context instead of resolving it a second time. `resolveCatalog` never
		// throws for a missing or damaged catalog, so the summary is always present.
		const localeCatalog = summarizeCatalog(preRuntime.catalog);
		// The per-locale support states come from the shipped status record. The
		// reader returns an empty list for a missing or malformed record, so
		// `doctor` reports the fields as unavailable instead of failing.
		const catalogSupport = catalogSupportStates();
		try {
			updateStatus = updater.status();
		} catch (error) {
			updateDiagnostic = error instanceof Error ? error.message : String(error);
		}
		try {
			keybindingPlan = planKeybindings(paths, { catalog: preRuntime.catalog.bundle });
		} catch (error) {
			keybindingDiagnostic = error instanceof Error ? error.message : String(error);
		}
		try {
			releaseExtensionStatus = inspectReleaseExtensions();
			probeReleaseRuntimeCompatibility(releaseExtensionStatus);
		} catch (error) {
			releaseExtensionDiagnostic = error instanceof Error ? error.message : String(error);
		}
		try {
			catalogSources = loadActiveModelCatalogs(paths, process.env, preRuntime.catalog.bundle).map(
				({ source, document }) => ({
					sourceId: source.id,
					label: source.label,
					offerings: document.modelOfferings.length,
					thinkingLevelGaps: catalogThinkingLevelGaps(document),
					registrationGaps: catalogRegistrationGaps(document),
				}),
			);
		} catch (error) {
			catalogDiagnostic = error instanceof Error ? error.message : String(error);
		}
		const result = createDoctorReport({
			metadata,
			paths,
			profile,
			uiLocale,
			responseLanguage,
			artifactPolicy,
			projectPolicy,
			...(localeCatalog ? { catalog: localeCatalog } : {}),
			catalogSupport,
			render: { ...preRuntime.display, catalog: preRuntime.catalog.bundle },
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
			...(catalogSources ? { catalogSources } : {}),
			...(catalogDiagnostic ? { catalogDiagnostic } : {}),
		});
		console.log(parsed.json ? JSON.stringify(result.report, null, 2) : result.text);
		if (!result.healthy) process.exitCode = 1;
		return;
	}

	const bundled = loadBundledProfile(profile.id);
	applyProfile(bundled, paths, metadata.jouzuVersion, preRuntime.catalog.bundle);
	if (firstRunChoice) {
		writeProfileChoice(profileChoicePath, profile.id);
		console.log(
			profile.id === "ja" ? text(CatalogMessageId.profileJapaneseEnabled) : text(CatalogMessageId.profileCoreFallback),
		);
	}
	if (piImportDiagnostic || !pi || !piRuntimeVersion) {
		throw new CatalogError(
			piImportDiagnostic
				? catalogMessage(CatalogMessageId.runtimePiLoadFailed, { diagnostic: piImportDiagnostic })
				: catalogMessage(CatalogMessageId.runtimePiLoadFailedUnavailable),
		);
	}
	if (piRuntimeVersion !== metadata.piVersion) {
		throw new CatalogError(
			catalogMessage(CatalogMessageId.runtimePiPinMismatch, {
				loaded: piRuntimeVersion,
				pinned: metadata.piVersion,
			}),
		);
	}
	await offerShisaOnboarding({
		paths,
		jouzuVersion: metadata.jouzuVersion,
		interactive: interactiveStartup,
		catalog: preRuntime.catalog.bundle,
	});
	const [
		presentation,
		{ createJouzuModelPicker },
		{ createJouzuHelpExtension },
		{ createScrollbackExtension },
		{ createSessionUiExtension, SESSION_UI_MESSAGE_IDS, WorkDashboardController, selectWork },
	] = await Promise.all([
		import("./presentation.js"),
		import("./model-picker.js"),
		import("./help.js"),
		import("./scrollback.js"),
		import("./session-ui/index.js"),
	]);
	presentation.clearInteractiveStartup(parsed.args);
	// A source with no activated revision has nothing cached to serve Pi's initial
	// model selection, so it refreshes before the picker snapshots catalogs. Sources
	// that already have a revision keep serving and refresh in the background below.
	// The budget is shorter than /reload's: a catalog that needs longer is treated as
	// unreachable, and the session starts from cached and local configuration.
	if (interactiveStartup) {
		try {
			const pendingCatalogs = pendingStartupCatalogSources(paths, process.env, preRuntime.catalog.bundle);
			if (pendingCatalogs.length > 0) {
				presentation.writeStartupNotice(presentation.catalogStartupNotice(preRuntime.catalog.bundle));
				try {
					await refreshModelCatalogSources(paths, pendingCatalogs, {
						timeoutMs: STARTUP_CATALOG_TIMEOUT_MS,
						catalog: preRuntime.catalog.bundle,
					});
				} finally {
					presentation.clearStartupNotice();
				}
			}
		} catch {
			// Discovery and refresh are best-effort. The picker handles unreadable
			// catalog configuration and continues with local models.
		}
	}
	const releaseExtensionStatus = inspectReleaseExtensions();
	probeReleaseRuntimeCompatibility(releaseExtensionStatus);
	ensureReleaseRuntimeCompatibility(releaseExtensionStatus);
	const displayCatalog = createDisplayCatalog(preRuntime.catalog.bundle);
	preRuntime = { ...preRuntime, catalog: { ...preRuntime.catalog, bundle: displayCatalog.bundle } };
	const piArgs = withReleaseExtensionArguments(parsed.args, releaseExtensionStatus, preRuntime.catalog.bundle);
	const runtimeDiagnostics = createRuntimeDiagnostics(
		metadata,
		usesReleaseExtensions(parsed.args) ? releaseExtensionStatus.resolvedPackageRoots : {},
	);
	const releaseDiagnostics = createReleaseExtensionDiagnostics(releaseExtensionStatus, runtimeDiagnostics);
	const dashboardController = new WorkDashboardController();
	// Producers hide their own widgets through claims sent over Pi's extension event bus.
	let dashboardEvents: WidgetClaimChannel["events"];
	const dashboardVisibility = new DashboardVisibility();
	let dashboardMode = loadDashboardPolicy(paths).mode;
	const modelPicker = createJouzuModelPicker(paths, {
		onUiLocaleChanged: (locale) => {
			const resolved = resolveCatalog(locale);
			displayCatalog.update(resolved.bundle);
			preRuntime = { ...preRuntime, catalog: { ...resolved, bundle: displayCatalog.bundle } };
			dashboardController.invalidateDisplay();
		},
		onLanguageChanged: ({ responseLanguage, artifactPolicy }) =>
			languageContract.applyLanguage(responseLanguage, artifactPolicy),
		onDashboardChanged: () => {
			dashboardMode = loadDashboardPolicy(paths).mode;
			dashboardController.invalidateDisplay();
		},
		dashboardVisibility: (visible) => {
			if (visible) dashboardVisibility.show();
			else dashboardVisibility.hide();
			dashboardController.invalidateDisplay();
		},
		runtime: runtimeDiagnostics,
		jouzuVersion: metadata.jouzuVersion,
		catalog: preRuntime.catalog.bundle,
		...(parsed.options.uiLocale ? { uiLocaleCli: parsed.options.uiLocale } : {}),
		textguardFiles: parsed.options.textguardFiles,
		// Read at launch time: a child inherits whatever mode the session is in.
		textguardMode: () => nativeTextguard.currentMode(),
		profile: () => profile.id,
		applyProjectDefaultAtStartup: interactiveStartup && projectDefaultAppliesAtStartup(parsed.args),
		restoreLastModelAtStartup: interactiveStartup && projectDefaultAppliesAtStartup(parsed.args),
		startupArgs: parsed.args,
	});
	if (interactiveStartup) {
		// Best-effort catalog refresh in the background: a source is contacted only
		// when its credential is available, and cached revisions keep serving.
		void refreshAvailableModelCatalogs(paths, { catalog: preRuntime.catalog.bundle })
			.then((result) => {
				if (result) modelPicker.reloadCatalogs();
			})
			.catch(() => {});
	}
	const help = createJouzuHelpExtension(preRuntime.catalog.bundle);
	const voice = (await import("./voice/integration.js")).createVoiceExtension(paths, {
		catalog: preRuntime.catalog.bundle,
	});
	const effectiveKeyText = (action: "app.model.select" | "app.model.cycleForward") => {
		const raw = pi.keyText(action);
		return raw
			? raw
					.split("/")
					.map((key) => formatKeyId(key))
					.join("/")
			: text(CatalogMessageId.keybindingsBindingUnbound);
	};
	// The Session Line's shortcut hint is catalog text. Pi installs app-level
	// keybindings when the TUI starts, so resolve them when rendering hints.
	const paletteShortcutHint = () =>
		catalogText(preRuntime.catalog.bundle, SESSION_UI_MESSAGE_IDS.hintPaletteShortcuts, {
			select: effectiveKeyText("app.model.select"),
			cycle: effectiveKeyText("app.model.cycleForward"),
			help: "Ctrl+/",
		});
	const sessionUi = createSessionUiExtension({
		catalog: preRuntime.catalog.bundle,
		dashboard: {
			controller: dashboardController,
			mode: () => dashboardVisibility.mode(dashboardMode),
			attach: (ctx, resetVisibility) => {
				if (resetVisibility) dashboardVisibility.reset();
				const scope = flow?.ingress().branch().scope ?? {
					sessionId: ctx.sessionManager.getSessionId(),
					branchId: ctx.sessionManager.getLeafId() ?? "root",
				};
				const work = flow?.dashboardWork;
				dashboardController.attach(scope, [
					createChildWorkSource(modelPicker.workflowService),
					...(flow
						? [createFlowWorkSource(() => flow.dashboardStatus(), Date.now, 5_000, preRuntime.catalog.bundle)]
						: []),
					...(work
						? [
								createClaimedWorkSource({
									id: "tasks",
									channel: { events: dashboardEvents, claim: "tasks:widget:claim", ready: "tasks:widget:ready" },
									// The task store has no change notification; its file is small.
									pollIntervalMs: 1500,
									read: (current) => {
										const tasks = work.tasks();
										return tasks && taskWorkUnits(current, tasks);
									},
								}),
								createClaimedWorkSource({
									id: "jobs",
									channel: {
										events: dashboardEvents,
										claim: "background-tasks:widget:claim",
										ready: "background-tasks:widget:ready",
									},
									// Jobs publish changes; the poll catches jobs the producer forgets without publishing.
									pollIntervalMs: 5000,
									subscribe: (changed) => work.watchJobs(changed),
									read: (current) => {
										const jobs = work.jobs();
										return jobs && jobWorkUnits(current, jobs, preRuntime.catalog.bundle);
									},
								}),
							]
						: []),
				]);
				const policy = loadDashboardPolicy(paths);
				dashboardMode = policy.mode;
				if (resetVisibility && policy.error)
					ctx.ui.notify(
						catalogText(preRuntime.catalog.bundle, "jouzu.cli.settings.dashboardUnreadable", {
							message: policy.error,
						}),
						"warning",
					);
			},
		},
		getFastMode: ({ extensionStatuses }) => extensionStatuses.get(FAST_MODE_STATUS) === "on",
		getHints: () => [
			{
				id: "palette.shortcuts",
				text: paletteShortcutHint(),
				priority: 10,
				role: "muted",
			},
		],
		// Loop counts arrive as an extension status and child agents through the workflow service, so
		// both read on the Session Line while the status bar keeps workspace, branch, and context.
		getActivity: ({ extensionStatuses }) => {
			const loopStatus = extensionStatuses.get("multiloop");
			const snapshot = dashboardController.getSnapshot();
			const selection = snapshot ? selectWork(snapshot, Date.now(), 0) : undefined;
			const activity = sessionActivity({
				...(loopStatus ? { loopStatus } : {}),
				activeAgents: (snapshot && activeChildCount(snapshot)) ?? modelPicker.activeAgentCount(),
				activeJobs: snapshot?.sources.jobs?.units.filter((unit) => unit.state === "running").length ?? 0,
			});
			return selection?.attentionCount
				? {
						text: activity?.text ?? "",
						active: activity?.active ?? false,
						attentionCount: selection.attentionCount,
					}
				: activity;
		},
		onModelPicker: (query) =>
			modelPicker.open({ source: query ? "command" : "action", ...(query ? { initialSearchInput: query } : {}) }),
		onModelCycle: (direction) => modelPicker.cycleFavorite(direction),
		onScopedModelsCommand: () => modelPicker.handleScopedModelsCommand(),
	});
	const [{ TextGuardRuntime }, { createTextGuardReviewExtension }] = await Promise.all([
		import("./textguard-runtime.js"),
		import("./textguard-review.js"),
	]);
	const nativeTextguard = new TextGuardRuntime({
		cachePath: join(paths.cacheDir, "textguard", "scans.json"),
		approvalPath: join(paths.cacheDir, "textguard", "approvals.json"),
		files: parsed.options.textguardFiles,
		mode: parsed.options.textguardOff ? "off" : parsed.options.textguardStrict ? "strict" : "guarded",
	});
	// On by default so real sessions exercise it; `JOUZU_FLOW_CONTROL=0` turns it off for a session
	// whose behaviour it gets wrong. `/flow` shows what it is holding and releases it.
	// Imported lazily so `doctor` and `--help` keep working when the Pi runtime is unavailable.
	const flow =
		process.env.JOUZU_FLOW_CONTROL !== "0"
			? (await import("./flow-control/flow-runtime.js")).createFlowControlRuntime({
					root: join(paths.stateDir, "flow"),
					agentDir: paths.agentDir,
					interactive: interactiveStartup,
					runtimeReport: runtimeDiagnostics.report,
					catalog: preRuntime.catalog.bundle,
					onError: (error) =>
						console.error(
							catalogText(preRuntime.catalog.bundle, CatalogMessageId.flowRuntimeError, {
								message: error instanceof Error ? error.message : String(error),
							}),
						),
				})
			: undefined;
	const scrollbackSession = createScrollbackSessionObserver();
	const startPi = () =>
		pi.main(piArgs, {
			sessionInfoFooter: runtimeDiagnostics.summary,
			contentPolicyFactory: nativeTextguard.createPolicy,
			flowIngressFactory: async (context) => scrollbackSession.wrap(await flow?.flowIngressFactory(context)),
			extensionFactories: [
				...classicHostBuiltinOverrides(),
				createDirectToolPolicyExtension(),
				// First argument handler, so later handlers and the tool see normalized input.
				createToolArgumentExtension(),
				{
					name: "jouzu-dashboard-events",
					factory: (api) => {
						dashboardEvents = api.events;
					},
				},
				createSessionLabelsExtension(undefined, undefined, createLabelPolicy(paths)),
				...(flow ? flow.extensions : []),
				{ name: "jouzu-textguard-review", factory: createTextGuardReviewExtension(nativeTextguard) },
				languageContract.extension,
				presentation.createJouzuPresentationExtension(metadata, profile, {
					catalog: preRuntime.catalog.bundle,
					responseLanguageSection: () => languageContract.currentSection(),
				}),
				sessionUi,
				// Account commands must run before model-availability input checks.
				createShisaExtension({
					paths,
					jouzuVersion: metadata.jouzuVersion,
					catalog: preRuntime.catalog.bundle,
				}),
				modelPicker.extension,
				modelPicker.workflowExtension,
				createAstraCompatibilityExtension(),
				createFastModeExtension(preRuntime.catalog.bundle),
				createResponsesToolSchemaExtension(),
				voice,
				help,
				createScrollbackExtension({ isShellBusy: scrollbackSession.isShellBusy, catalog: preRuntime.catalog.bundle }),
				releaseDiagnostics,
			],
		});
	const runPi = async () => {
		const execute = () =>
			usesReleaseExtensions(parsed.args)
				? withReleaseExtensionConflictPolicy(pi, releaseExtensionStatus, startPi)
				: startPi();
		if (!interactiveStartup) return execute();
		const { withPiUiLocalization } = await import("./pi-ui-localization.js");
		const { withPiProseWrapping } = await import("./pi-prose-wrapping.js");
		return withPiUiLocalization(
			() => displayCatalog.bundle,
			() => withPiProseWrapping(execute),
			pi,
		);
	};
	try {
		await withJouzuOutput(runPi, {
			interactive: interactiveStartup,
			protectTitles: true,
			rewrite: !usesMachineReadableStdout(piArgs),
		});
	} finally {
		try {
			await nativeTextguard.close();
		} finally {
			await flow?.dispose();
		}
	}
}

export function handleMainCliError(error: unknown, catalog: CatalogBundle = defaultCatalog()): void {
	const text = (id: CliMessageId, args?: Parameters<typeof catalogText>[2]): string => catalogText(catalog, id, args);
	if (error instanceof PiImportError) {
		console.error(text(CliMessageId.piImport, { message: protectedSourceError(error.message) }));
		process.exitCode = error.exitCode;
		return;
	}
	if (error instanceof KeybindingConflictError) {
		console.error(text(CliMessageId.keybindingConflict, { plan: formatKeybindingPlan(error.plan, { catalog }) }));
		console.error(text(CliMessageId.keybindingConflictRecovery));
		process.exitCode = error.exitCode;
		return;
	}
	if (error instanceof KeybindingConfigError) {
		console.error(text(CliMessageId.keybindingConfig, { message: protectedSourceError(error.message) }));
		process.exitCode = error.exitCode;
		return;
	}
	if (error instanceof ProfileStateError) {
		console.error(text(CliMessageId.profileState, { message: protectedSourceError(error.message) }));
		console.error(text(CliMessageId.profileStateRecovery));
		process.exitCode = 1;
		return;
	}
	if (error instanceof ProfileConflictError) {
		console.error(text(CliMessageId.profileConflict, { plan: formatProfilePlan(error.plan, { catalog }) }));
		console.error(text(CliMessageId.profileConflictRecovery));
		process.exitCode = error.exitCode;
		return;
	}
	if (error instanceof UsageError) {
		console.error(text(CliMessageId.usage, { message: protectedSourceError(usageErrorMessage(error, catalog)) }));
		console.error(text(CliMessageId.usageHint));
		process.exitCode = error.exitCode;
		return;
	}
	if (error instanceof UiLocaleUsageError) {
		console.error(text(CliMessageId.usage, { message: protectedSourceError(error.message) }));
		console.error(text(CliMessageId.usageHint));
		process.exitCode = error.exitCode;
		return;
	}
	const message =
		error instanceof CatalogError
			? catalogMessageText(catalog, error.catalogMessage)
			: error instanceof Error
				? error.message
				: String(error);
	console.error(text(CliMessageId.generic, { message: protectedSourceError(message) }));
	process.exitCode = 1;
}
