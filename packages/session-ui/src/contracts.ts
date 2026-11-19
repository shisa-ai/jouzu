import type { WorkAttentionType, WorkKind } from "./work-dashboard.js";

export type SessionUiSemanticRole = "text" | "muted" | "accent" | "success" | "warning" | "error";

export interface SessionUiHint {
	id: string;
	text: string;
	priority: number;
	role: SessionUiSemanticRole;
}

export interface SessionUiHintSource {
	getHint(): SessionUiHint | undefined;
}

/** Status text other extensions published through `ctx.ui.setStatus`, keyed by extension. */
export interface SessionUiActivityContext {
	extensionStatuses: ReadonlyMap<string, string>;
}

/**
 * Work the Session Line reports instead of the shortcut hint: a running loop, active child
 * agents, or loop state that outlives the turn. `active` animates the marker while work moves.
 */
export interface SessionUiActivity {
	text: string;
	active: boolean;
	/** Distinct unresolved units; retained even when detail or model identity cannot fit. */
	attentionCount?: number;
}

export interface SessionUiClock {
	now(): number;
}

export const SYSTEM_SESSION_UI_CLOCK: SessionUiClock = Object.freeze({
	now: () => Date.now(),
});

/** The stable catalog IDs for the Session UI's own display text. */
export const SESSION_UI_MESSAGE_IDS = Object.freeze({
	lineFast: "jouzu.cli.session.line.fast",
	lineNoModel: "jouzu.cli.session.line.noModel",
	lineAttention: "jouzu.cli.session.line.attention",
	statusHealth: "jouzu.cli.session.status.health",
	statusContextUnknown: "jouzu.cli.session.status.contextUnknown",
	statusDetached: "jouzu.cli.session.status.detached",
	hintPaletteShortcuts: "jouzu.cli.session.hint.paletteShortcuts",
	dashboardSectionAgent: "jouzu.cli.session.dashboard.section.agent",
	dashboardSectionJob: "jouzu.cli.session.dashboard.section.job",
	dashboardSectionTask: "jouzu.cli.session.dashboard.section.task",
	dashboardSectionLoop: "jouzu.cli.session.dashboard.section.loop",
	dashboardSectionGoal: "jouzu.cli.session.dashboard.section.goal",
	dashboardSectionPrompt: "jouzu.cli.session.dashboard.section.prompt",
	dashboardSectionFlow: "jouzu.cli.session.dashboard.section.flow",
	dashboardAttentionResult: "jouzu.cli.session.dashboard.attention.result",
	dashboardAttentionInput: "jouzu.cli.session.dashboard.attention.input",
	dashboardAttentionRecovery: "jouzu.cli.session.dashboard.attention.recovery",
	dashboardAttentionAuthority: "jouzu.cli.session.dashboard.attention.authority",
	dashboardStale: "jouzu.cli.session.dashboard.stale",
	dashboardElapsedSeconds: "jouzu.cli.session.dashboard.elapsed.seconds",
	dashboardElapsedMinutes: "jouzu.cli.session.dashboard.elapsed.minutes",
	dashboardElapsedHours: "jouzu.cli.session.dashboard.elapsed.hours",
	dashboardElapsedHoursMinutes: "jouzu.cli.session.dashboard.elapsed.hoursMinutes",
});

/**
 * The stable catalog IDs for slash-command autocomplete descriptions, keyed by
 * the autocomplete suggestion `value` (the command name without a leading `/`).
 */
export const SESSION_UI_SLASH_COMMAND_IDS: Readonly<Record<string, string>> = Object.freeze({
	settings: "jouzu.cli.session.slash.settings",
	model: "jouzu.cli.session.slash.model",
	tree: "jouzu.cli.session.slash.tree",
	thinking: "jouzu.cli.session.slash.thinking",
	export: "jouzu.cli.session.slash.export",
	import: "jouzu.cli.session.slash.import",
	share: "jouzu.cli.session.slash.share",
	bug: "jouzu.cli.session.slash.bug",
	copy: "jouzu.cli.session.slash.copy",
	name: "jouzu.cli.session.slash.name",
	session: "jouzu.cli.session.slash.session",
	changelog: "jouzu.cli.session.slash.changelog",
	hotkeys: "jouzu.cli.session.slash.hotkeys",
	fork: "jouzu.cli.session.slash.fork",
	clone: "jouzu.cli.session.slash.clone",
	trust: "jouzu.cli.session.slash.trust",
	login: "jouzu.cli.session.slash.login",
	logout: "jouzu.cli.session.slash.logout",
	new: "jouzu.cli.session.slash.new",
	compact: "jouzu.cli.session.slash.compact",
	resume: "jouzu.cli.session.slash.resume",
	reload: "jouzu.cli.session.slash.reload",
	quit: "jouzu.cli.session.slash.quit",
	catalogs: "jouzu.cli.session.slash.catalogs",
	about: "jouzu.cli.session.slash.about",
	fast: "jouzu.cli.session.slash.fast",
	scrollback: "jouzu.cli.session.slash.scrollback",
	flow: "jouzu.cli.session.slash.flow",
	mcp: "jouzu.cli.session.slash.mcp",
	llama: "jouzu.cli.session.slash.llama",
	tasks: "jouzu.cli.session.slash.tasks",
	goal: "jouzu.cli.session.slash.goal",
	multiloop: "jouzu.cli.session.slash.multiloop",
	"schedule-prompt": "jouzu.cli.session.slash.schedulePrompt",
	bg: "jouzu.cli.session.slash.bg",
	"bg:list": "jouzu.cli.session.slash.bgList",
	"bg:next": "jouzu.cli.session.slash.bgNext",
	"bg:clear": "jouzu.cli.session.slash.bgClear",
	"bg:run": "jouzu.cli.session.slash.bgRun",
	"bg:stop": "jouzu.cli.session.slash.bgStop",
	"pi-vcc": "jouzu.cli.session.slash.piVcc",
	"pi-vcc-recall": "jouzu.cli.session.slash.piVccRecall",
	"code-preview-health": "jouzu.cli.session.slash.codePreviewHealth",
	"code-preview-settings": "jouzu.cli.session.slash.codePreviewSettings",
	"jouzu-review": "jouzu.cli.session.slash.jouzuReview",
	"skill:jouzu-reference": "jouzu.cli.session.slash.skillJouzuReference",
	"skill:jouzu-clear-writing": "jouzu.cli.session.slash.skillJouzuClearWriting",
	"skill:jouzu-analysis": "jouzu.cli.session.slash.skillJouzuAnalysis",
	"skill:jouzu-anti-slop": "jouzu.cli.session.slash.skillJouzuAntiSlop",
	"skill:jouzu-delegation": "jouzu.cli.session.slash.skillJouzuDelegation",
	"skill:jouzu-source-check": "jouzu.cli.session.slash.skillJouzuSourceCheck",
	"skill:multiloop": "jouzu.cli.session.slash.skillMultiloop",
});

/**
 * Pi commands that appear without a source tag: the interactive built-ins and
 * the built-in extension commands. `pi.getCommands()` returns extension, prompt,
 * and skill commands only, and built-in registrations carry no source tag. This
 * set lets the editor recognize an untagged built-in without treating an
 * untagged user command as one. The editor removes `/scoped-models` before
 * localization, so that built-in does not need an entry.
 */
export const SESSION_UI_BUILTIN_SLASH_COMMANDS: ReadonlySet<string> = new Set([
	"settings",
	"model",
	"tree",
	"thinking",
	"export",
	"import",
	"share",
	"bug",
	"copy",
	"name",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"trust",
	"login",
	"logout",
	"new",
	"compact",
	"resume",
	"reload",
	"quit",
	"mcp",
	"llama",
]);

/**
 * English registration descriptions for bundled extension commands that register
 * canonical English text. They identify the bundled registration in a non-English
 * catalog without trusting its name alone. Commands whose registration is already
 * localized are recognized by the active catalog value, and built-ins carry no
 * source tag.
 */
export const SESSION_UI_SLASH_COMMAND_CANONICAL_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
	tasks: "Manage tasks — view, create, clear completed. '/tasks auto' enters auto-advance mode.",
	goal: "Set one objective and work toward it; a lightweight multiloop run",
	multiloop: "Start, resume, or manage autonomous iteration loops",
	"schedule-prompt": "Manage scheduled prompts interactively",
	bg: "Background shell task dashboard and controls.",
	"bg:list": "Show tracked background tasks",
	"bg:next": "Move the next bash command to a background task",
	"bg:clear": "Remove finished background tasks",
	"bg:run": "Spawn a background shell task: /bg:run <command>",
	"bg:stop": "Terminate a running background task: /bg:stop <id>",
	"pi-vcc": "Compact conversation with pi-vcc structured summary",
	"pi-vcc-recall":
		"Recall earlier parts of this session. Plain keywords work best; add scope:all to reach edited or retried turns.",
	"code-preview-health": "Show code preview renderer health and settings",
	"code-preview-settings": "Configure code preview settings",
});

/** Full registered descriptions for bundled commands whose catalog text is a shorter display form. */
export const SESSION_UI_BUNDLED_SLASH_COMMAND_DESCRIPTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze(
	{
		"skill:multiloop": [
			"Run and manage autonomous work — quick goals through /goal, and measured optimization, punchlist, research, and development loops through /multiloop. Use when the user sets a persistent objective, or requests repeated measured improvement, a bounded development loop, a research sweep, or punch-list completion.",
		],
	},
);

/**
 * Full descriptions registered by installed Jouzu resources whose catalog text
 * is a shorter display form. Ownership matches these exact descriptions, so a
 * user resource with the same name but different text stays untouched.
 */
export const SESSION_UI_INSTALLED_SLASH_COMMAND_DESCRIPTIONS: Readonly<Record<string, readonly string[]>> =
	Object.freeze({
		"skill:jouzu-reference": [
			"Look up Jouzu settings, language, models/catalogs, profiles, session and trace locations, controls, and troubleshooting. Use for product questions or authorized configuration changes.",
		],
		"skill:jouzu-clear-writing": [
			"Draft, revise, or audit durable user-facing technical artifacts without changing facts. Use for documentation, README text, release notes, issues, prompts, tool descriptions, CLI help, diagnostics, or other prose intended to persist or leave the current chat.",
		],
		"skill:jouzu-analysis": [
			"Write, revise, or review analysis documents that turn evidence into findings or recommendations. Use for technical comparisons, benchmark reports, evaluations, incident analyses, design tradeoffs, or decision memos.",
		],
		"skill:jouzu-anti-slop": [
			"Remove filler, marketing language, and unsupported emphasis from existing prose without losing facts, qualifiers, or exact technical content. Use for a filler-removal pass over a draft, README, release note, issue, pull request, or documentation, or to check a document against recurring filler patterns.",
		],
		"skill:jouzu-delegation": [
			"Write and review subagent assignments, steering messages, and resume handoffs. Use before delegating work or correcting a child run to define one objective, supply verified context, set acceptance checks and a stopping point, and diagnose failures without changing the user's model selection.",
		],
		"skill:jouzu-source-check": [
			"Research and fact-check claims or sources through claim classification, primary evidence, counterevidence, confidence, and cross-source synthesis. Use for URLs, articles, papers, reports, transcripts, disputed claims, or requests to assess evidence quality.",
		],
		"jouzu-review": ["Review the current change as a release-minded coding assista..."],
	});

export type SessionUiMessageId = (typeof SESSION_UI_MESSAGE_IDS)[keyof typeof SESSION_UI_MESSAGE_IDS];

/**
 * The locale catalog the Session UI reads its text from.
 *
 * It is the structural subset of the CLI's `CatalogBundle` that the renderer
 * needs, so this package stays independent of the CLI while the startup path
 * passes the catalog it resolved. The catalog may forward to a newly active
 * bundle after a language change; readers resolve it on each access.
 */
export interface SessionUiCatalog {
	format(id: string, args?: Readonly<Record<string, string | number>>): string;
}

/**
 * The work dashboard's own display text, read from the current catalog.
 *
 * The section titles and attention phrases are keyed by the internal work kind
 * and attention type, which stay the identity values for ordering and
 * comparison; only the resolved words are catalog text. The two composed
 * strings are catalog patterns rather than concatenation: `markStale` wraps a
 * row's status, and `formatElapsed` fills a duration pattern.
 */
export interface SessionUiWorkDashboardText {
	/** Section titles keyed by the internal work kind. */
	readonly sections: Readonly<Record<WorkKind, string>>;
	/** Attention phrases keyed by the internal attention type. */
	readonly attention: Readonly<Record<WorkAttentionType, string>>;
	/** Wrap a row's status text with the marker that its producer's data is stale. */
	readonly markStale: (status: string) => string;
	/** Compact elapsed time: 45s, 12m, 1h, or 1h 5m. */
	readonly formatElapsed: (ms: number) => string;
}

/**
 * The Session UI's own display text, read from the current catalog.
 *
 * A render function takes this view instead of resolving a locale itself. The
 * getters resolve the active catalog on each read, so a language change reaches
 * the next frame without recreating a renderer. Protected values (provider
 * names, model IDs, paths, URLs) are data and are not part of this view.
 */
export interface SessionUiText {
	/** Paid priority processing is active for this session's model. */
	readonly fast: string;
	/** Fixed effort labels; unknown provider-defined values remain unchanged. */
	readonly thinkingLevels?: Readonly<Record<string, string>>;
	readonly thinkingPlaceholder?: string;
	/** Shown in place of a model identity the session has not reported. */
	readonly noModel: string;
	/** The Session Line's label for unresolved work when no activity detail fits. */
	readonly attention: string;
	/** The status bar's marker when a status source failed. */
	readonly statusHealth: string;
	/** The status bar's context placeholder when the usage percentage is unknown. */
	readonly statusContextUnknown: string;
	/** The status bar's branch placeholder when the repository has no branch. */
	readonly statusDetached: string;
	/** The work dashboard's section titles, attention phrases, and composed patterns. */
	readonly dashboard: SessionUiWorkDashboardText;
	/**
	 * Catalog-only slash-command descriptions keyed by command name, read from the
	 * current catalog. This view does not know command provenance; the prompt
	 * editor applies ownership before using a description.
	 */
	readonly slashCommands?: Readonly<Record<string, string>>;
}

/** Resolve slash-command autocomplete descriptions from a catalog. */
export function resolveSlashCommandDescriptions(catalog: SessionUiCatalog): Readonly<Record<string, string>> {
	const descriptions: Record<string, string> = {};
	for (const [command, id] of Object.entries(SESSION_UI_SLASH_COMMAND_IDS)) {
		const value = catalog.format(id);
		if (typeof value === "string" && value.length > 0 && value !== id) {
			descriptions[command] = value;
		}
	}
	return Object.freeze(descriptions);
}

/** Resolve the Session UI display text from a catalog. */
export function sessionUiText(catalog: SessionUiCatalog): SessionUiText {
	const ids = SESSION_UI_MESSAGE_IDS;
	// Each read resolves the current catalog. A locale change therefore reaches the next render or
	// autocomplete completion without rebuilding the editor or any other surface.
	const dashboard: SessionUiWorkDashboardText = {
		get sections() {
			return {
				agent: catalog.format(ids.dashboardSectionAgent),
				job: catalog.format(ids.dashboardSectionJob),
				task: catalog.format(ids.dashboardSectionTask),
				loop: catalog.format(ids.dashboardSectionLoop),
				goal: catalog.format(ids.dashboardSectionGoal),
				prompt: catalog.format(ids.dashboardSectionPrompt),
				flow: catalog.format(ids.dashboardSectionFlow),
			};
		},
		get attention() {
			return {
				result: catalog.format(ids.dashboardAttentionResult),
				input: catalog.format(ids.dashboardAttentionInput),
				recovery: catalog.format(ids.dashboardAttentionRecovery),
				authority: catalog.format(ids.dashboardAttentionAuthority),
			};
		},
		markStale: (status) => catalog.format(ids.dashboardStale, { status }),
		formatElapsed: (ms) => {
			const seconds = Math.max(0, Math.floor(ms / 1000));
			if (seconds < 60) return catalog.format(ids.dashboardElapsedSeconds, { count: seconds });
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) return catalog.format(ids.dashboardElapsedMinutes, { count: minutes });
			const hours = Math.floor(minutes / 60);
			return minutes % 60
				? catalog.format(ids.dashboardElapsedHoursMinutes, { hours, minutes: minutes % 60 })
				: catalog.format(ids.dashboardElapsedHours, { count: hours });
		},
	};
	return {
		get thinkingLevels() {
			return Object.fromEntries(
				["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
					level,
					catalog.format(`jouzu.cli.piUi.effort.${level}`),
				]),
			);
		},
		get thinkingPlaceholder() {
			return catalog.format("jouzu.cli.piUi.thinking.placeholder");
		},
		get fast() {
			return catalog.format(ids.lineFast);
		},
		get noModel() {
			return catalog.format(ids.lineNoModel);
		},
		get attention() {
			return catalog.format(ids.lineAttention);
		},
		get statusHealth() {
			return catalog.format(ids.statusHealth);
		},
		get statusContextUnknown() {
			return catalog.format(ids.statusContextUnknown);
		},
		get statusDetached() {
			return catalog.format(ids.statusDetached);
		},
		get slashCommands() {
			return resolveSlashCommandDescriptions(catalog);
		},
		dashboard,
	};
}
