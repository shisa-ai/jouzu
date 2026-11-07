/**
 * The recorded display surfaces of the pinned Pi and every bundled release
 * extension. This is the machine-readable half of the localization boundary:
 * it names the owner of each surface, the version the entry was recorded
 * against, how the surface renders, whether a localization hook is known, the
 * disposition, and the version condition that requires a re-check.
 *
 * Each inspection applies only to its recorded version. A changed owner needs
 * another inspection before the record can describe the running build.
 *
 * `recheckOn` is the `<owner>@<version>` pin this row was recorded against. A
 * row needs a re-check when the installed owner no longer reports that version,
 * so the condition is decided by comparing the pinned version in
 * `upstream/pi.lock.json` or `packages/cli/release-extensions.json`.
 */

/** The pinned Pi provenance this record was taken from. */
export const RELEASE_SURFACE_PI_PROVENANCE = {
	version: "1.5.0",
	tag: "v1.5.0",
	commit: "f9a26365568127461c47a07a37dcb42c140a3ac5",
} as const;

/** `pi`, `service`, or a bundled release-extension package ID. */
export type SurfaceOwner = string;

/** How the surface reaches the terminal. */
export type SurfaceRenderRoute = "Pi TUI" | "extension" | "browser";

/**
 * Whether the pinned version offers a way to replace the surface's text.
 * `none-known` means the pinned version was inspected and no hook was found;
 * it does not assert that no hook can exist in a later version.
 */
export type SurfaceLocalizationHook = "available" | "none-known" | "not-inspected";

/** What Jouzu decided to do with the surface. */
export type SurfaceDisposition = "translated" | "upstream-owned" | "not-inspected" | "out-of-scope";

export interface ReleaseSurface {
	/** A stable ID for one display path, for example `pi.palette.models`. */
	surfaceId: string;
	owner: SurfaceOwner;
	version: string;
	renderRoute: SurfaceRenderRoute;
	localizationHook: SurfaceLocalizationHook;
	disposition: SurfaceDisposition;
	/** The `<owner>@<version>` pin this row was recorded against. */
	recheckOn: string;
}

const PI_VERSION = RELEASE_SURFACE_PI_PROVENANCE.version;

function piSurface(surfaceId: string): ReleaseSurface {
	return {
		surfaceId,
		owner: "pi",
		version: PI_VERSION,
		renderRoute: "Pi TUI",
		localizationHook: "none-known",
		disposition: "upstream-owned",
		recheckOn: `pi@${PI_VERSION}`,
	};
}

function extensionSurface(
	surfaceId: string,
	owner: string,
	version: string,
	disposition: SurfaceDisposition,
	localizationHook: SurfaceLocalizationHook = "none-known",
): ReleaseSurface {
	return {
		surfaceId,
		owner,
		version,
		renderRoute: "extension",
		localizationHook,
		disposition,
		recheckOn: `${owner}@${version}`,
	};
}

function serviceSurface(surfaceId: string): ReleaseSurface {
	return {
		surfaceId,
		owner: "service",
		version: "unversioned",
		renderRoute: "browser",
		localizationHook: "not-inspected",
		disposition: "out-of-scope",
		recheckOn: "service@unversioned",
	};
}

/**
 * The recorded surfaces. The selection rule is: every startup, palette,
 * dialog, status and hint, error, and transcript surface of the pinned Pi's
 * interactive mode, plus the palette entries, tool names, and status labels of
 * every entry in `packages/cli/release-extensions.json`, plus the
 * service-owned account screens. Individual strings inside one surface are out
 * of scope; a surface is recorded once.
 */
export const RELEASE_SURFACES: readonly ReleaseSurface[] = [
	// Pinned Pi — startup screen.
	piSurface("pi.startup.header"),
	piSurface("pi.startup.logo"),
	piSurface("pi.startup.firstRun"),
	piSurface("pi.startup.announcement"),
	// Pinned Pi — palette views and selectors.
	piSurface("pi.palette.models"),
	piSurface("pi.palette.thinking"),
	piSurface("pi.palette.scopedModels"),
	piSurface("pi.palette.sessions"),
	piSurface("pi.palette.theme"),
	piSurface("pi.palette.settings"),
	piSurface("pi.palette.projectTrust"),
	piSurface("pi.palette.resources"),
	piSurface("pi.palette.branchTree"),
	piSurface("pi.palette.userMessages"),
	piSurface("pi.palette.showImages"),
	piSurface("pi.palette.providers"),
	piSurface("pi.palette.radiusLogin"),
	// Pinned Pi — dialogs.
	piSurface("pi.dialog.login"),
	piSurface("pi.dialog.extension"),
	piSurface("pi.dialog.bugReport"),
	// Pinned Pi — status and hint lines.
	piSurface("pi.status.footer"),
	piSurface("pi.status.indicator"),
	piSurface("pi.status.keyHints"),
	piSurface("pi.status.loader"),
	piSurface("pi.status.hotkeys"),
	// Pinned Pi — error screens and process output.
	piSurface("pi.error.authGuidance"),
	piSurface("pi.error.crashNotice"),
	piSurface("pi.cli.help"),
	piSurface("pi.cli.resumeHint"),
	// Pinned Pi — transcript.
	piSurface("pi.transcript.assistantMessage"),
	piSurface("pi.transcript.toolExecution"),
	// Bundled release extensions.
	extensionSurface("pi-schedule-prompt.commands", "pi-schedule-prompt", "0.4.1", "upstream-owned"),
	extensionSurface("pi-schedule-prompt.tools", "pi-schedule-prompt", "0.4.1", "out-of-scope"),
	extensionSurface("pi-schedule-prompt.status", "pi-schedule-prompt", "0.4.1", "upstream-owned"),
	extensionSurface(
		"@vanillagreen/pi-background-tasks.tools",
		"@vanillagreen/pi-background-tasks",
		"2.0.0",
		"out-of-scope",
	),
	extensionSurface(
		"@vanillagreen/pi-background-tasks.status",
		"@vanillagreen/pi-background-tasks",
		"2.0.0",
		"upstream-owned",
	),
	extensionSurface("pi-webaio.tools", "pi-webaio", "1.0.5", "out-of-scope"),
	extensionSurface("pi-webaio.status", "pi-webaio", "1.0.5", "upstream-owned"),
	extensionSurface("jouzu-camoufox-adapter.tools", "jouzu-camoufox-adapter", "1", "out-of-scope"),
	extensionSurface("jouzu-camoufox-adapter.labels", "jouzu-camoufox-adapter", "1", "translated", "available"),
	extensionSurface("pi-code-previews.commands", "pi-code-previews", "0.1.36", "upstream-owned"),
	extensionSurface("pi-code-previews.status", "pi-code-previews", "0.1.36", "not-inspected", "not-inspected"),
	extensionSurface("@lhl/pi-tasks.commands", "@lhl/pi-tasks", "0.6.1", "upstream-owned"),
	extensionSurface("@lhl/pi-tasks.tools", "@lhl/pi-tasks", "0.6.1", "out-of-scope"),
	extensionSurface("@lhl/pi-tasks.status", "@lhl/pi-tasks", "0.6.1", "upstream-owned"),
	extensionSurface("pi-multiloop.commands", "pi-multiloop", "0.4.1", "upstream-owned"),
	extensionSurface("pi-multiloop.tools", "pi-multiloop", "0.4.1", "out-of-scope"),
	extensionSurface("pi-multiloop.status", "pi-multiloop", "0.4.1", "upstream-owned"),
	extensionSurface("@sting8k/pi-vcc.commands", "@sting8k/pi-vcc", "0.7.2", "upstream-owned"),
	extensionSurface("@sting8k/pi-vcc.tools", "@sting8k/pi-vcc", "0.7.2", "out-of-scope"),
	extensionSurface("pi-skill-dollar.autocomplete", "pi-skill-dollar", "0.2.0", "upstream-owned"),
	// Service-owned account screens.
	serviceSurface("service.account.dashboard"),
	serviceSurface("service.account.signIn"),
];

export interface ReleaseSurfaceRecheck {
	surfaceId: string;
	owner: string;
	recordedVersion: string;
	currentVersion?: string;
}

/** Missing or changed owners need inspection; this never updates the recorded evidence. */
export function releaseSurfacesNeedingRecheck(
	versions: Readonly<Record<string, string | undefined>>,
	surfaces: readonly ReleaseSurface[] = RELEASE_SURFACES,
): ReleaseSurfaceRecheck[] {
	return surfaces
		.filter((surface) => surface.owner !== "service" && versions[surface.owner] !== surface.version)
		.map((surface) => ({
			surfaceId: surface.surfaceId,
			owner: surface.owner,
			recordedVersion: surface.version,
			currentVersion: versions[surface.owner],
		}));
}

export interface ReleaseSurfaceSummary {
	/** Every record passed in, including one with an unknown disposition. */
	total: number;
	translated: number;
	upstreamOwned: number;
	notInspected: number;
	outOfScope: number;
	/**
	 * Records whose `disposition` is missing or is not one of the four known
	 * values. They are never counted as translated.
	 */
	unknown: number;
}

/**
 * Count the surfaces by disposition. A record with a missing or unknown
 * disposition lands in `unknown` and never in `translated`, so a record that
 * has not been decided cannot inflate the translated tally.
 */
export function summarizeReleaseSurfaces(
	surfaces: readonly (ReleaseSurface | undefined | null)[] = RELEASE_SURFACES,
): ReleaseSurfaceSummary {
	const summary: ReleaseSurfaceSummary = {
		total: 0,
		translated: 0,
		upstreamOwned: 0,
		notInspected: 0,
		outOfScope: 0,
		unknown: 0,
	};
	for (const surface of surfaces) {
		summary.total += 1;
		switch (surface?.disposition) {
			case "translated":
				summary.translated += 1;
				break;
			case "upstream-owned":
				summary.upstreamOwned += 1;
				break;
			case "not-inspected":
				summary.notInspected += 1;
				break;
			case "out-of-scope":
				summary.outOfScope += 1;
				break;
			default:
				summary.unknown += 1;
				break;
		}
	}
	return summary;
}
