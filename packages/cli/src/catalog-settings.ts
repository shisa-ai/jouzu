import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, Input, matchesKey, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type HeldCatalogUpdate, heldCatalogSummary, heldCatalogUpdates } from "./catalog-held.js";
import {
	type CatalogEndpointDiscoveryOptions,
	type CatalogEndpointDiscoveryResult,
	type CatalogSource,
	type CatalogSourceAuth,
	CatalogSourceStore,
	catalogInsecureTransportWarning,
	discoverCatalogEndpoint,
	getCatalogSourceToken,
	normalizeCatalogSourceUrl,
	SHISA_API_CATALOG_CREDENTIAL_ENV,
	setCatalogSourceToken,
	validateCatalogSourceToken,
} from "./catalog-sources.js";
import {
	CatalogMessageId,
	type CatalogMessageRef,
	catalogMessage,
	catalogMessageText,
	catalogText,
	defaultCatalog,
} from "./cli-messages.js";
import { formatContextClamp, loadContextPolicy, stepContextClamp, writeContextPolicy } from "./context-clamp.js";
import { DASHBOARD_MODES, loadDashboardPolicy, writeDashboardPolicy } from "./dashboard-policy.js";
import { formatEffectiveKeybinding, formatEffectiveKeyPair, formatKeyId } from "./keybinding-hints.js";
import type { LabelPolicyStore } from "./label-policy.js";
import { isShippedUiLocale, languageSelfName } from "./language-choice.js";
import type { LanguageContractInput } from "./language-contract.js";
import {
	ARTIFACT_LANGUAGES,
	ARTIFACT_POLICY_FIELDS,
	type ArtifactPolicy,
	DEFAULT_ARTIFACT_POLICY,
	formatArtifactPolicy,
	RESPONSE_LANGUAGES,
	type ResolvedArtifactPolicy,
	type ResolvedResponseLanguage,
	type ResponseLanguagePreference,
	resolveArtifactPolicy,
	resolveResponseLanguage,
} from "./language-settings.js";
import { type CatalogBundle, resolveCatalog } from "./locale-catalog.js";
import {
	deferralNotice,
	detectLocalizationDeferral,
	displayLanguageFixed,
	type LocalizationActivity,
	type LocalizationDeferral,
	reapprovalNotice,
	upstreamSwitchNotice,
} from "./localization-deferral.js";
import {
	applyLocalization,
	type LocalizationApplyResult,
	type LocalizationField,
	type LocalizationPlan,
	LocalizationRecoveryError,
	type LocalizationRequest,
	type LocalizationSessionOverride,
	planLocalization,
	type ResolvedLocalizationUiLocale,
	readLocalizationSessionOverride,
	resetLocalization,
} from "./localization-ops.js";
import {
	activateDiscoveredCatalog,
	type CatalogRefreshResult,
	type CatalogSyncStatus,
	getCatalogSourceStatus,
	loadActiveCatalogForSource,
	type RefreshCatalogOptions,
	refreshCatalogSource,
} from "./model-catalog-sync.js";
import {
	type PaletteComponent,
	type PaletteComponentContext,
	type PaletteKeyHint,
	type PaletteRoute,
	paletteChoice,
	paletteHeightBudget,
	paletteInnerWidth,
	renderPaletteDivider,
	renderPaletteField,
	renderPaletteHeading,
	renderPaletteKeyBar,
	renderPaletteTabs,
} from "./palette.js";
import type { JouzuPaths } from "./paths.js";
import { renderBrandWordmark } from "./presentation.js";
import type { RuntimeDiagnostics } from "./runtime-diagnostics.js";
import type { SessionUiStyleRole, SessionUiStyles } from "./session-ui/index.js";
import { readShisaAccountStatus, type ShisaAccountStatus } from "./shisa-link/account.js";
import { onShisaAuthChange, setShisaSignedOut } from "./shisa-link/credentials.js";
import { resolveShisaGatewayUrl, type ShisaLoginCompletion } from "./shisa-link/device-flow.js";
import { loginShisa } from "./shisa-link/login.js";
import { logoutShisa, shisaLogoutMessage } from "./shisa-link/logout.js";
import {
	fitTerminalText,
	renderTerminalFrameBorder,
	renderTerminalFrameRow,
	renderTerminalFrameTitle,
	sanitizeTerminalText,
	terminalTextWidth,
} from "./terminal-layout.js";
import {
	type LocalizationConfigState,
	type LocalizationSettings,
	osLocaleCandidates,
	readLocalizationSettings,
	resolveUiLocale,
	UI_LOCALE_PREFERENCES,
	type UiLocale,
	type UiLocalePreference,
} from "./ui-locale.js";

export interface CatalogSettingsOptions {
	context: PaletteComponentContext;
	paths: JouzuPaths;
	env?: NodeJS.ProcessEnv;
	discover?: (input: string, options: CatalogEndpointDiscoveryOptions) => Promise<CatalogEndpointDiscoveryResult>;
	refresh?: (
		paths: JouzuPaths,
		source: CatalogSource,
		options?: RefreshCatalogOptions,
	) => Promise<CatalogRefreshResult>;
	onDashboardChanged?: () => void;
	labelPolicy?: LabelPolicyStore;
	onCatalogsChanged?: () => void;
	/** Host hook that asks the user to accept or reject held catalog revisions. */
	onReviewHeldCatalog?: (updates: HeldCatalogUpdate[]) => Promise<void>;
	/** Host hook after a Shisa sign-in or sign-out: refresh providers, catalogs, and model availability. */
	onAccountChanged?: (change: { signedIn: boolean }) => Promise<void> | void;
	runtime?: Pick<RuntimeDiagnostics, "about">;
	initialRoute?: PaletteRoute;
	/** Client version reported to the Shisa device flow; the account row needs it to sign in. */
	jouzuVersion?: string;
	/** The `--jouzu-ui-locale` value, so the Language view can report the `cli` source. */
	uiLocaleCli?: string;
	/** Refresh the host's display catalog after a confirmed, persisted UI choice. */
	onUiLocaleChanged?: (locale: UiLocale) => void;
	/** Notify the active contract only after response/artifact choices are saved. */
	onLanguageChanged?: (language: LanguageContractInput) => void;
	/**
	 * A snapshot of the work in progress that a language change must not
	 * disturb. The host supplies the signals it can observe; an absent field
	 * reads as inactive.
	 */
	activity?: () => LocalizationActivity;
	/**
	 * The current session identity. A saved apply clears only this session's
	 * legacy override, and the view reads any remaining override back so it can
	 * show the effective value and its `session` source.
	 */
	sessionId?: string;
	/** Test seams for the account row. */
	login?: typeof loginShisa;
	logout?: typeof logoutShisa;
	openBrowser?: (url: string) => void;
}

type FormField = "label" | "url" | "auth" | "credential" | "token";

interface SourceView {
	source: CatalogSource;
	status: CatalogSyncStatus;
	offerings: Array<{ providerId: string; modelId: string; name: string }>;
}

interface SourceForm {
	mode: "add" | "edit";
	sourceId?: string;
	label: Input;
	url: Input;
	authType: "none" | "bearer";
	credential: Input;
	token: Input;
	field: FormField;
}

/** Compose complete sentences using the catalog's spacing, without adding punctuation. */
export function composeCatalogSaveMessage(catalog: CatalogBundle, base: string, notes: readonly string[]): string {
	return notes.reduce(
		(message, note) => catalogText(catalog, CatalogMessageId.settingsSavedWithNotes, { base: message, notes: note }),
		base,
	);
}

function warnHint(styles: SessionUiStyles, value: string, width: number, line: (value?: string) => string): string[] {
	return wrapTextWithAnsi(value, width).map((warningLine) =>
		line(styles.apply("palette.message.warning", warningLine)),
	);
}

/** The selected-source warning for a held revision, with the key that opens its review. */
function heldWarningText(catalog: CatalogBundle, status: CatalogSyncStatus): string | undefined {
	const held = status.configured ? status.held?.[0] : undefined;
	if (!held) return undefined;
	return catalogText(catalog, CatalogMessageId.settingsHeldWarning, {
		summary: heldCatalogSummary(catalog, held),
		key: "U",
	});
}

function sourceStatusText(view: SourceView): string {
	const status = view.status;
	if (status.configured && status.conflict) return "reserved-id conflict";
	if (!view.source.enabled) return "disabled";
	if (status.configured && status.credentialName && status.credentialAvailable === false) {
		return `${status.credentialName} not set`;
	}
	if (status.configured && status.held?.length) return "update held";
	return status.status;
}

/** Colour the status column so a broken source is visible without reading it. */
function sourceStatusRole(view: SourceView): SessionUiStyleRole {
	const status = view.status;
	if (status.configured && status.conflict) return "palette.message.error";
	if (!view.source.enabled) return "palette.status.off";
	if (status.configured && status.credentialName && status.credentialAvailable === false)
		return "palette.status.attention";
	if (status.configured && status.held?.length) return "palette.status.attention";
	if (status.status === "active") return "palette.status.ready";
	if (status.status === "stale") return "palette.status.attention";
	return "palette.status.off";
}

const SOURCE_LABEL_COLUMN = 22;
const FORM_LABEL_COLUMN = 14;
const LANGUAGE_LABEL_COLUMN = 20;

/**
 * The session id a component without a host session uses when reading and
 * clearing legacy session overrides. A real session always passes its own id.
 */
const DEFAULT_LOCALIZATION_SESSION_ID = "settings";

/**
 * Catalog-only IDs for the apply, reset, and receipt text. They live in
 * `locales/<locale>/localization-settings.ftl`, not the shared message table,
 * so a parallel lane can edit `cli.ftl` without a conflict.
 */
const LOCALIZATION_SETTINGS_MESSAGE_IDS = {
	confirmHeading: "jouzu.cli.localization.settings.confirm.heading",
	resetHeading: "jouzu.cli.localization.settings.reset.heading",
	recovery: "jouzu.cli.localization.settings.recovery",
	resetConfirm: "jouzu.cli.localization.settings.reset.confirm",
	noChange: "jouzu.cli.localization.settings.no.change",
	change: "jouzu.cli.localization.settings.change",
	applied: "jouzu.cli.localization.settings.applied",
	appliedNoBackup: "jouzu.cli.localization.settings.applied.no.backup",
	resetDone: "jouzu.cli.localization.settings.reset.done",
	resetDoneNoBackup: "jouzu.cli.localization.settings.reset.done.no.backup",
	savedRestart: "jouzu.cli.localization.settings.saved.restart",
	notices: "jouzu.cli.localization.settings.notices",
	applyFailed: "jouzu.cli.localization.settings.apply.failed",
	resetFailed: "jouzu.cli.localization.settings.reset.failed",
	hintApply: "jouzu.cli.localization.settings.hint.apply",
	hintReset: "jouzu.cli.localization.settings.hint.reset",
} as const;

/** The label of each language field, for the confirmation summary. */
const LOCALIZATION_FIELD_LABEL_IDS: Readonly<Record<LocalizationField, CatalogMessageId>> = {
	uiLocale: CatalogMessageId.settingsLabelDisplayLanguage,
	responseLanguage: CatalogMessageId.settingsLabelResponseLanguage,
	artifactPolicy: CatalogMessageId.settingsLabelArtifactPolicy,
};

/** Language controls at the start of the Settings pane. */
type LanguageItem = "ui" | "response" | "artifact";

/**
 * The artifact-policy preview presets, in cycle order. `default` is the built-in
 * mixed policy; every other preset applies one artifact language to all fields.
 */
const ARTIFACT_POLICY_PRESETS = ["default", ...ARTIFACT_LANGUAGES] as const;
type ArtifactPolicyPreset = (typeof ARTIFACT_POLICY_PRESETS)[number];

/** Expand a preview preset into a full artifact policy. */
function artifactPolicyForPreset(preset: ArtifactPolicyPreset): ArtifactPolicy {
	if (preset === "default") return DEFAULT_ARTIFACT_POLICY;
	return { comments: preset, documentation: preset, commits: preset, reviews: preset };
}

/** The preset a policy is currently on, or `default` for a mixed policy. */
function artifactPresetFor(policy: ArtifactPolicy): ArtifactPolicyPreset {
	const values = ARTIFACT_POLICY_FIELDS.map((field) => policy[field]);
	const first = values[0];
	if (first !== undefined && values.every((value) => value === first)) return first;
	return "default";
}

/** The shipped interface locale preferences, in the UI-locale set's order. */
const SHIPPED_UI_LOCALE_PREFERENCES: readonly UiLocalePreference[] = UI_LOCALE_PREFERENCES.filter(
	(preference) => preference === "auto" || isShippedUiLocale(preference),
);

/** The response-language preferences, in the language set's order. */
const RESPONSE_LANGUAGE_PREFERENCES: readonly ResponseLanguagePreference[] = ["auto", ...RESPONSE_LANGUAGES];

/** Plain-text token warning for a source URL, prefixed for list rendering. */
function transportWarningText(catalog: CatalogBundle, url: string): string | undefined {
	const warning = catalogInsecureTransportWarning(url, catalog);
	return warning ? `  ${catalogText(catalog, CatalogMessageId.settingsWarning, { message: warning })}` : undefined;
}

/** Plain-text warning for a bearer source with no usable token. */
function credentialWarningText(catalog: CatalogBundle, status: CatalogSyncStatus): string | undefined {
	if (!status.configured || !status.credentialName || status.credentialAvailable) return undefined;
	return `  ${catalogText(catalog, CatalogMessageId.settingsWarningTokenNotSet, { name: status.credentialName })}`;
}

/**
 * Mask a rendered input line: every printable character becomes a bullet, so a
 * pasted bearer token is never rendered. Control sequences (cursor marker,
 * ANSI escapes) and spacing keep their width.
 */
function maskRenderedInput(rendered: string): string {
	let masked = "";
	let index = 0;
	if (rendered.startsWith("> ")) {
		masked = "> ";
		index = 2;
	}
	while (index < rendered.length) {
		if (rendered[index] === "\x1b") {
			// Copy one control sequence verbatim: an SGR escape ends at "m", the
			// cursor marker at the bell character.
			const sgr = rendered.indexOf("m", index);
			const marker = rendered.indexOf("\x07", index);
			const end = marker >= 0 && (sgr < 0 || marker < sgr) ? marker : sgr;
			if (end >= 0) {
				masked += rendered.slice(index, end + 1);
				index = end + 1;
				continue;
			}
		}
		const character = Array.from(rendered.slice(index, index + 2))[0] ?? rendered[index];
		const codePoint = character.codePointAt(0) ?? 0;
		const control = codePoint <= 0x1f || codePoint === 0x7f;
		masked += control || character === " " ? character : "•";
		index += character.length;
	}
	return masked;
}

export class CatalogSettingsComponent implements PaletteComponent, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly styles: SessionUiStyles;
	private baseCatalog: CatalogBundle;
	private catalog: CatalogBundle;
	private readonly close: () => void;
	private readonly paths: JouzuPaths;
	private readonly env: NodeJS.ProcessEnv;
	private readonly store: CatalogSourceStore;
	private readonly discover: CatalogSettingsOptions["discover"];
	private readonly refreshSource: NonNullable<CatalogSettingsOptions["refresh"]>;
	private readonly onCatalogsChanged?: () => void;
	private readonly onReviewHeldCatalog?: (updates: HeldCatalogUpdate[]) => Promise<void>;
	private readonly onAccountChanged?: (change: { signedIn: boolean }) => Promise<void> | void;
	private readonly wordmark: string;
	private readonly runtime?: Pick<RuntimeDiagnostics, "about">;
	private readonly jouzuVersion?: string;
	private readonly login: typeof loginShisa;
	private readonly logout: typeof logoutShisa;
	private readonly openBrowser?: (url: string) => void;
	private aboutFocused = false;
	private aboutOffset = 0;
	private aboutRows = 1;
	private scrollOffset = 0;
	private pageAnchor?: { key: string; offset: number };
	private modalOffset = 0;
	private modalCapacity = 1;
	private modalTotal = 0;
	private modalIdentity: unknown;
	private modalManual = false;
	private bodyCapacity = 1;
	private focusRows = new Map<string, number>();
	private scrollToSection = true;
	/** Keep the selected control in view after keyboard focus movement. */
	private ensureFocusVisible = false;
	/** Page/Home/End scrolling owns the viewport until the selection moves again. */
	private manualScroll = false;
	/** A Home/End request that the next document render consumes. */
	private scrollToTop = false;
	private scrollToBottom = false;
	/** The last rendered document and viewport sizes, used by page scrolling. */
	private contentRows = 0;
	private viewportRows = 1;
	private views: SourceView[] = [];
	private selectedIndex = 0;
	private labelsFocused = false;
	private readonly labelPolicy?: LabelPolicyStore;
	private dashboardFocused = false;
	private readonly onDashboardChanged?: () => void;
	private contextFocused = false;

	private account: ShisaAccountStatus;
	private accountFocused = false;

	private confirmLogout = false;
	private readonly unsubscribeAuth: () => void;
	private maxContextTokens?: number;
	/** The focused language control, when focus is in the Language section. */
	private languageFocused?: LanguageItem = "ui";
	/** The interface language being previewed inside Settings, if any. */
	private previewUiLocale?: UiLocalePreference;
	/** The response language being previewed inside Settings, if any. */
	private previewResponseLanguage?: ResponseLanguagePreference;
	/** The artifact-policy preset being previewed inside Settings, if any. */
	private previewArtifactPolicy?: ArtifactPolicyPreset;
	/** The pending confirmation for the previewed change, if any. */
	private languageConfirm?: { request: LocalizationRequest; plan: LocalizationPlan };
	/** Whether a reset of every language setting is waiting for confirmation. */
	private languageResetConfirm = false;
	/** The last apply or reset receipt, shown until the next input. */
	private languageReceipt?: {
		kind: "apply" | "reset";
		backupDir?: string;
		transactionId: string;
		notices: number;
		uiLocaleChanged: boolean;
	};
	private readonly uiLocaleCli?: string;
	private readonly onUiLocaleChanged?: CatalogSettingsOptions["onUiLocaleChanged"];
	private readonly onLanguageChanged?: CatalogSettingsOptions["onLanguageChanged"];
	private readonly activity?: () => LocalizationActivity;
	private readonly sessionId: string;
	private expandedSourceId?: string;
	private expandedOffset = 0;
	/** Offering rows the last render granted the expanded source; paging steps by this. */
	private expandedCapacity = 0;
	private messageOffset = 0;
	private messageCapacity = 0;
	private messageIdentity = "";
	private form?: SourceForm;
	private confirmRemove = false;
	private busy = false;
	private message?: { level: "error" | "info" | "warning"; text: string };
	private controller?: AbortController;
	private disposed = false;
	private _focused = false;

	constructor(options: CatalogSettingsOptions) {
		this.labelPolicy = options.labelPolicy;
		this.onDashboardChanged = options.onDashboardChanged;
		this.tui = options.context.tui;
		this.theme = options.context.theme;
		this.keybindings = options.context.keybindings;
		this.styles = options.context.styles;
		// A caller without a resolved catalog (a unit test, for example) renders
		// from the English bundle rather than resolving the locale again.
		this.catalog = options.context.catalog ?? defaultCatalog();
		this.baseCatalog = this.catalog;
		this.close = options.context.close;
		this.paths = options.paths;
		this.env = options.env ?? process.env;
		this.store = new CatalogSourceStore(this.paths, { env: this.env, catalog: this.catalog });
		this.discover = options.discover ?? discoverCatalogEndpoint;
		this.refreshSource = options.refresh ?? refreshCatalogSource;
		this.onCatalogsChanged = options.onCatalogsChanged;
		this.onReviewHeldCatalog = options.onReviewHeldCatalog;
		this.onAccountChanged = options.onAccountChanged;
		this.wordmark = renderBrandWordmark(this.theme);
		this.runtime = options.runtime;
		this.jouzuVersion = options.jouzuVersion;
		this.uiLocaleCli = options.uiLocaleCli;
		this.onUiLocaleChanged = options.onUiLocaleChanged;
		this.onLanguageChanged = options.onLanguageChanged;
		this.activity = options.activity;
		this.sessionId = options.sessionId ?? DEFAULT_LOCALIZATION_SESSION_ID;
		this.login = options.login ?? loginShisa;
		this.logout = options.logout ?? logoutShisa;
		this.openBrowser = options.openBrowser;
		this.account = readShisaAccountStatus(this.paths, this.env);
		// Sign-in and sign-out elsewhere in the session (the /logout menu, a child
		// process) must reach this row without reopening Settings.
		this.unsubscribeAuth = onShisaAuthChange(this.paths, () => {
			if (this.disposed) return;
			this.account = readShisaAccountStatus(this.paths, this.env);
			this.tui.requestRender();
		});
		this.reloadViews();
		this.reloadContextPolicy();
		this.restoreRoute(options.initialRoute);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.syncInputFocus();
	}

	route(route: PaletteRoute): void {
		if (route.view !== "settings" || !this.allowsGlobalNavigation()) return;
		this.reloadViews();
		this.restoreRoute(route);
		this.tui.requestRender();
	}

	snapshotRoute(): PaletteRoute {
		return {
			view: "settings",
			query: JSON.stringify({
				focus: this.focusKey(),
				scroll: this.scrollOffset,
				expanded: this.expandedSourceId,
				offering: this.expandedOffset,
			}),
		};
	}

	/** Deep links focus sections; retained routes restore the same control and viewport. */
	private restoreRoute(route?: PaletteRoute): void {
		if (route?.resume && route.query?.startsWith("{")) {
			try {
				const state = JSON.parse(route.query);
				if (typeof state.focus === "string") this.focusControl(state.focus);
				if (Number.isSafeInteger(state.scroll)) this.scrollOffset = Math.max(0, state.scroll);
				if (typeof state.expanded === "string") this.expandedSourceId = state.expanded;
				if (Number.isSafeInteger(state.offering)) this.expandedOffset = Math.max(0, state.offering);
				this.scrollToSection = false;
				this.manualScroll = true;
				return;
			} catch {
				// A stale route falls back to the first control without writing state.
			}
		}
		this.manualScroll = false;
		this.focusControl(
			route?.query === "about" && this.runtime
				? "about:0"
				: route?.query === "catalogs"
					? this.views[0]
						? `source:${this.views[0].source.id}`
						: "catalogs"
					: "ui",
		);
		this.scrollToSection = true;
	}

	allowsGlobalNavigation(): boolean {
		return (
			!this.form &&
			!this.confirmRemove &&
			!this.confirmLogout &&
			!this.busy &&
			!this.previewActive &&
			!this.languageConfirm &&
			!this.languageResetConfirm
		);
	}

	private focusKey(): string {
		if (this.languageFocused) return this.languageFocused;
		if (this.accountFocused) return "account";
		if (this.contextFocused) return "context";
		if (this.dashboardFocused) return "dashboard";
		if (this.labelsFocused) return "labels";
		if (this.aboutFocused) return `about:${this.aboutOffset}`;
		return this.selected() ? `source:${this.selected()?.source.id}` : "catalogs";
	}

	private focusControl(key: string): void {
		this.languageFocused = key === "ui" || key === "response" || key === "artifact" ? key : undefined;
		this.accountFocused = key === "account";
		this.contextFocused = key === "context";
		this.dashboardFocused = key === "dashboard" && Boolean(this.onDashboardChanged);
		this.labelsFocused = key === "labels" && Boolean(this.labelPolicy);
		this.aboutFocused = key.startsWith("about:") && Boolean(this.runtime);
		if (this.aboutFocused) this.aboutOffset = Math.max(0, Number.parseInt(key.slice(6), 10) || 0);
		if (key.startsWith("source:")) {
			const index = this.views.findIndex((view) => view.source.id === key.slice(7));
			this.selectedIndex = Math.max(0, index);
		}
	}

	private focusOrder(): string[] {
		return [
			"ui",
			"response",
			"artifact",
			"account",
			"context",
			...(this.onDashboardChanged ? ["dashboard"] : []),
			...(this.labelPolicy ? ["labels"] : []),
			...(this.views.length ? this.views.map((view) => `source:${view.source.id}`) : ["catalogs"]),
			...(this.runtime ? Array.from({ length: this.aboutRows }, (_, index) => `about:${index}`) : []),
		];
	}

	/** Navigation follows controls, not whichever rows happened to fit the previous frame. */
	private moveFocus(direction: -1 | 1, page = false): void {
		const order = this.focusOrder();
		const index = Math.max(0, order.indexOf(this.focusKey()));
		let next = Math.max(0, Math.min(order.length - 1, index + direction));
		if (page) {
			const row = this.focusRows.get(order[index]) ?? 0;
			const target = row + direction * Math.max(1, this.bodyCapacity - 1);
			while (next + direction >= 0 && next + direction < order.length) {
				const nextRow = this.focusRows.get(order[next + direction]);
				if (nextRow === undefined || (direction > 0 ? nextRow > target : nextRow < target)) break;
				next += direction;
			}
		}
		this.focusControl(order[next]);
		this.ensureFocusVisible = true;
		this.manualScroll = false;
		this.scrollToTop = false;
		this.scrollToBottom = false;
		this.message = undefined;
		this.languageReceipt = undefined;
		this.tui.requestRender();
	}

	/**
	 * Scroll the document by one viewport without moving the selection out of
	 * view. Page keys reach nonselectable rows too, so a long About report or
	 * help text cannot be stranded below the last focusable control.
	 */
	private pageScroll(direction: -1 | 1): void {
		const maximum = Math.max(0, this.contentRows - this.viewportRows);
		if (maximum === 0) return;
		const step = Math.max(1, this.viewportRows - 1);
		const next = Math.max(0, Math.min(maximum, this.scrollOffset + direction * step));
		if (next === this.scrollOffset) return;
		this.scrollOffset = next;
		this.ensureFocusVisible = false;
		this.manualScroll = true;
		this.scrollToTop = false;
		this.scrollToBottom = false;
		this.message = undefined;
		this.languageReceipt = undefined;
		// Keep a focusable row selected when the new viewport has one.
		const current = this.focusRows.get(this.focusKey());
		if (current === undefined || current < next || current >= next + this.viewportRows) {
			const visible = [...this.focusRows.entries()].filter(([, row]) => row >= next && row < next + this.viewportRows);
			if (visible.length > 0) {
				const chosen = direction > 0 ? visible[visible.length - 1] : visible[0];
				// Focus can add or remove catalog details above the next page.
				this.pageAnchor = { key: chosen[0], offset: chosen[1] - next };
				this.focusControl(chosen[0]);
			}
		}
		this.tui.requestRender();
	}

	/** Jump to the first or last document row, including trailing nonselectable text. */
	private scrollToEdge(edge: "top" | "bottom"): void {
		const order = this.focusOrder();
		this.focusControl(edge === "top" ? order[0] : order[order.length - 1]);
		this.scrollToTop = edge === "top";
		this.scrollToBottom = edge === "bottom";
		this.scrollToSection = false;
		this.ensureFocusVisible = false;
		this.manualScroll = true;
		this.message = undefined;
		this.languageReceipt = undefined;
		this.tui.requestRender();
	}

	private selected(): SourceView | undefined {
		return this.views[this.selectedIndex];
	}

	private reloadViews(preferredId?: string): void {
		const retainedId = preferredId ?? this.selected()?.source.id;
		try {
			const sources = this.store.list();
			this.views = sources.map((source) => {
				const document = loadActiveCatalogForSource(this.paths, source);
				return {
					source,
					status: getCatalogSourceStatus(this.paths, source, new Date(), this.env, this.catalog),
					offerings: (document?.modelOfferings ?? []).map((offering) => ({
						providerId: sanitizeTerminalText(offering.providerId),
						modelId: sanitizeTerminalText(offering.modelId),
						name: sanitizeTerminalText(offering.name ?? offering.modelId),
					})),
				};
			});
			const retainedIndex = retainedId ? this.views.findIndex((view) => view.source.id === retainedId) : -1;
			this.selectedIndex =
				retainedIndex >= 0 ? retainedIndex : Math.min(this.selectedIndex, Math.max(0, this.views.length - 1));
		} catch (error) {
			this.views = [];
			this.message = {
				level: "error",
				text: catalogText(this.catalog, CatalogMessageId.settingsLoadFailed, {
					message: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
				}),
			};
		}
	}

	private formFields(): FormField[] {
		if (!this.form) return [];
		return this.form.authType === "bearer" ? ["label", "url", "auth", "credential", "token"] : ["label", "url", "auth"];
	}

	private activeInput(): Input | undefined {
		if (!this.form) return undefined;
		if (this.form.field === "label") return this.form.label;
		if (this.form.field === "url") return this.form.url;
		if (this.form.field === "credential") return this.form.credential;
		if (this.form.field === "token") return this.form.token;
		return undefined;
	}

	private syncInputFocus(): void {
		if (!this.form) return;
		this.form.label.focused = this._focused && this.form.field === "label";
		this.form.url.focused = this._focused && this.form.field === "url";
		this.form.credential.focused = this._focused && this.form.field === "credential";
		this.form.token.focused = this._focused && this.form.field === "token";
	}

	private startForm(mode: "add" | "edit"): void {
		const selected = mode === "edit" ? this.selected()?.source : undefined;
		if (mode === "edit" && !selected) return;
		this.focusControl(selected ? `source:${selected.id}` : "catalogs");
		const label = new Input();
		const url = new Input();
		const credential = new Input();
		const token = new Input();
		label.setValue(selected?.label ?? "");
		url.setValue(selected?.url ?? "");
		credential.setValue(
			selected?.auth.type === "bearer" ? selected.auth.credentialRef.slice(4) : "JOUZU_MODEL_CATALOG_TOKEN",
		);
		// A saved token is never echoed back into the form; the field stays empty
		// and the hint says one exists.
		this.form = {
			mode,
			...(selected ? { sourceId: selected.id } : {}),
			label,
			url,
			authType: selected?.auth.type ?? "none",
			credential,
			token,
			field: "label",
		};
		this.message = undefined;
		this.confirmRemove = false;
		this.syncInputFocus();
		this.tui.requestRender();
	}

	private cycleFormField(delta: number): void {
		if (!this.form) return;
		const fields = this.formFields();
		const index = fields.indexOf(this.form.field);
		this.form.field = fields[(index + delta + fields.length) % fields.length];
		this.syncInputFocus();
		this.tui.requestRender();
	}

	private toggleAuth(): void {
		if (!this.form) return;
		this.form.authType = this.form.authType === "none" ? "bearer" : "none";
		this.form.field = "auth";
		this.syncInputFocus();
		this.tui.requestRender();
	}

	private async saveForm(): Promise<void> {
		const form = this.form;
		if (!form || this.busy) return;
		const label = form.label.getValue().trim();
		const inputUrl = form.url.getValue().trim();
		const credentialName = form.credential.getValue().trim();
		const auth: CatalogSourceAuth =
			form.authType === "none" ? { type: "none" } : { type: "bearer", credentialRef: `env:${credentialName}` };
		const enteredToken = form.token.getValue().trim();
		try {
			// Validate before anything is written, so a bad token cannot strand a saved source.
			if (enteredToken) validateCatalogSourceToken(enteredToken);
		} catch (error) {
			this.message = {
				level: "error",
				text: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
			};
			this.tui.requestRender();
			return;
		}
		let storedToken: string | undefined;
		try {
			storedToken = form.sourceId ? getCatalogSourceToken(this.paths, form.sourceId) : undefined;
		} catch (error) {
			this.message = {
				level: "error",
				text: catalogText(this.catalog, CatalogMessageId.settingsSavedTokensUnreadable, {
					message: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
				}),
			};
			this.tui.requestRender();
			return;
		}
		const envToken = form.authType === "bearer" ? this.env[credentialName]?.trim() || undefined : undefined;
		const effectiveToken = form.authType === "none" ? undefined : (envToken ?? enteredToken ?? storedToken);
		// A bearer source without any usable token is still saved, just unchecked:
		// the user sets the variable or saves a token afterwards and refreshes.
		const skipDiscovery = form.authType === "bearer" && !effectiveToken;
		this.busy = true;
		this.message = { level: "info", text: catalogText(this.catalog, CatalogMessageId.settingsSaving) };
		this.controller?.abort();
		const controller = new AbortController();
		this.controller = controller;
		this.tui.requestRender();
		let heldUpdate: HeldCatalogUpdate[] = [];
		try {
			let discovered: CatalogEndpointDiscoveryResult | undefined;
			if (!skipDiscovery) {
				discovered = await this.discover?.(inputUrl, {
					auth,
					env: this.env,
					signal: controller.signal,
					catalog: this.catalog,
					...(effectiveToken ? { bearerToken: effectiveToken } : {}),
				});
				if (!discovered) throw new Error("catalog endpoint discovery returned no result");
				if (this.disposed || controller.signal.aborted) return;
			}
			let refreshed: CatalogRefreshResult | undefined;
			const activate = (source: CatalogSource) => {
				if (!discovered) return;
				refreshed = activateDiscoveredCatalog(this.paths, source, discovered, this.env, this.catalog);
				if (refreshed.status === "error" || refreshed.status === "rejected") throw new Error(refreshed.message);
			};
			const url = discovered?.url ?? normalizeCatalogSourceUrl(inputUrl);
			const source =
				form.mode === "edit" && form.sourceId
					? this.store.update(form.sourceId, { label, url, auth }, activate)
					: this.store.add({ label, url, auth }, activate);
			if (enteredToken && auth.type === "bearer") setCatalogSourceToken(this.paths, source.id, enteredToken);
			this.form = undefined;
			this.reloadViews(source.id);
			const count = refreshed?.catalogStatus.configured
				? (refreshed.catalogStatus.offeringCount ?? discovered?.document.modelOfferings.length ?? 0)
				: (discovered?.document.modelOfferings.length ?? 0);
			const notes: string[] = [];
			if (skipDiscovery)
				notes.push(
					catalogText(this.catalog, CatalogMessageId.settingsNoteTokenNotSet, {
						name: sanitizeTerminalText(credentialName),
					}),
				);
			if (enteredToken && envToken)
				notes.push(
					catalogText(this.catalog, CatalogMessageId.settingsNoteTokenPrecedence, {
						name: sanitizeTerminalText(credentialName),
					}),
				);
			const base =
				refreshed?.status === "quarantined"
					? catalogText(this.catalog, CatalogMessageId.settingsSavedQuarantined, {
							label: sanitizeTerminalText(source.label),
							reasons: heldCatalogSummary(this.catalog, {
								revision: refreshed.revision,
								digest: refreshed.digest,
								sequence: "",
								reasons: refreshed.reasons,
								receivedAt: "",
								changes: refreshed.changes,
							}),
						})
					: discovered
						? catalogText(this.catalog, CatalogMessageId.settingsSavedWithCount, {
								label: sanitizeTerminalText(source.label),
								count,
							})
						: catalogText(this.catalog, CatalogMessageId.settingsSavedWithoutCheck, {
								label: sanitizeTerminalText(source.label),
							});
			this.message = {
				level: notes.length > 0 ? "warning" : "info",
				text: composeCatalogSaveMessage(this.catalog, base, notes),
			};
			this.onCatalogsChanged?.();
			if (refreshed) heldUpdate = heldCatalogUpdates([{ source, result: refreshed }]);
		} catch (error) {
			if (this.disposed || controller.signal.aborted) return;
			this.message = {
				level: "error",
				text: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
			};
		} finally {
			if (this.controller === controller) this.controller = undefined;
			if (controller.signal.aborted && !this.disposed)
				this.message = { level: "info", text: catalogText(this.catalog, CatalogMessageId.settingsSaveCanceled) };
			this.busy = false;
			this.tui.requestRender();
		}
		if (heldUpdate.length > 0) await this.reviewHeld(heldUpdate);
	}

	/** Open the host's accept-or-reject review for held revisions, then show the result. */
	private async reviewHeld(updates: HeldCatalogUpdate[]): Promise<void> {
		if (this.disposed || updates.length === 0 || !this.onReviewHeldCatalog) return;
		await this.onReviewHeldCatalog(updates);
		if (this.disposed) return;
		this.reloadViews(updates[0].source.id);
		this.tui.requestRender();
	}

	/** The held revisions of the selected source, as review requests. */
	private selectedHeld(): HeldCatalogUpdate[] {
		const view = this.selected();
		if (!view?.status.configured) return [];
		return (view.status.held ?? []).map((held) => ({ source: view.source, held }));
	}

	private async refreshSelected(): Promise<void> {
		const view = this.selected();
		if (!view || this.busy || !view.source.enabled) return;
		this.busy = true;
		this.message = {
			level: "info",
			text: catalogText(this.catalog, CatalogMessageId.settingsRefreshing, {
				label: sanitizeTerminalText(view.source.label),
			}),
		};
		this.tui.requestRender();
		let held: HeldCatalogUpdate[] = [];
		try {
			const result = await this.refreshSource(this.paths, view.source, { env: this.env });
			if (this.disposed) return;
			if (result.status === "error" || result.status === "rejected") throw new Error(result.message);
			this.reloadViews(view.source.id);
			held = heldCatalogUpdates([{ source: view.source, result }]);
			this.message =
				held.length > 0
					? {
							level: "warning",
							text: catalogText(this.catalog, CatalogMessageId.settingsHeldWarning, {
								summary: heldCatalogSummary(this.catalog, held[0].held),
								key: "U",
							}),
						}
					: {
							level: "info",
							text:
								result.status === "not-modified"
									? catalogText(this.catalog, CatalogMessageId.settingsRefreshUpToDate)
									: catalogText(this.catalog, CatalogMessageId.settingsRefreshStatus, { status: result.status }),
						};
			this.onCatalogsChanged?.();
		} catch (error) {
			if (this.disposed) return;
			this.reloadViews(view.source.id);
			this.message = {
				level: "error",
				text: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
			};
		} finally {
			this.busy = false;
			this.tui.requestRender();
		}
		await this.reviewHeld(held);
	}

	private reloadContextPolicy(): void {
		const policy = loadContextPolicy(this.paths);
		this.maxContextTokens = policy.maxContextTokens;
		if (policy.error && !this.message) {
			this.message = {
				level: "warning",
				text: catalogText(this.catalog, CatalogMessageId.settingsContextLimitNotApplied, {
					message: sanitizeTerminalText(policy.error),
				}),
			};
		}
	}

	/** Store one ladder step and ask the host to recompose provider models. */
	private stepContextLimit(direction: -1 | 1): void {
		const next = stepContextClamp(this.maxContextTokens, direction);
		try {
			writeContextPolicy(this.paths, next);
		} catch (error) {
			this.message = {
				level: "error",
				text: catalogText(this.catalog, CatalogMessageId.settingsContextLimitNotSaved, {
					message: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
				}),
			};
			this.tui.requestRender();
			return;
		}
		this.maxContextTokens = next;
		this.message = {
			level: "info",
			text:
				next === undefined
					? catalogText(this.catalog, CatalogMessageId.settingsContextLimitOff)
					: catalogText(this.catalog, CatalogMessageId.settingsContextLimitSet, {
							limit: formatContextClamp(next),
						}),
		};
		this.onCatalogsChanged?.();
		this.tui.requestRender();
	}

	/**
	 * The activity a language change must respect. The component's own
	 * destructive confirmations are included, so the display language is fixed
	 * while the user is answering one, whatever the host reports.
	 */
	private activityState(): LocalizationActivity {
		const external = this.activity?.() ?? {};
		return {
			...external,
			destructiveConfirmation: this.confirmRemove || this.confirmLogout || external.destructiveConfirmation === true,
		};
	}

	/** Whether any Language-view row is being previewed inside Settings. */
	private get previewActive(): boolean {
		return (
			this.previewUiLocale !== undefined ||
			this.previewResponseLanguage !== undefined ||
			this.previewArtifactPolicy !== undefined
		);
	}

	/** The saved settings and the legacy config projection the UI-locale resolver reads. */
	private savedLanguageState(): { config: LocalizationConfigState; settings?: LocalizationSettings } {
		const state = readLocalizationSettings(this.paths.configDir, this.catalog);
		if (state.status === "ok") {
			return { config: { status: "ok", preference: state.preference }, settings: state.settings };
		}
		if (state.status === "future") return { config: { status: "future", schemaVersion: state.schemaVersion } };
		if (state.status === "invalid") return { config: { status: "invalid", reason: state.reason } };
		return { config: { status: "absent" } };
	}

	/**
	 * The effective display, response, and artifact language state, resolved from
	 * the same inputs the runtime uses. The Language view never writes from here.
	 */
	private languageState(): {
		uiLocale: ResolvedLocalizationUiLocale;
		responseLanguage: ResolvedResponseLanguage;
		artifactPolicy: ResolvedArtifactPolicy;
	} {
		const saved = this.savedLanguageState();
		const override = this.sessionOverride();
		const savedPreference = saved.config.status === "ok";
		let uiLocale: ResolvedLocalizationUiLocale;
		if (!savedPreference && override.uiLocale !== undefined && override.uiLocale !== "auto") {
			uiLocale = { requested: override.uiLocale, effective: override.uiLocale, source: "session" };
		} else {
			const resolved = resolveUiLocale({
				...(this.uiLocaleCli ? { cli: this.uiLocaleCli } : {}),
				...(this.env.JOUZU_UI_LOCALE ? { env: this.env.JOUZU_UI_LOCALE } : {}),
				config: saved.config,
				os: osLocaleCandidates(this.env),
			});
			uiLocale = {
				requested: resolved.requested,
				effective: resolved.effective,
				source: resolved.source,
				...(resolved.fallback ? { fallback: resolved.fallback } : {}),
			};
		}
		const responseLanguage = resolveResponseLanguage({
			session: override.responseLanguage,
			config: saved.settings?.responseLanguage,
		});
		const artifactPolicy = resolveArtifactPolicy({
			...(override.artifactPolicy ? { session: override.artifactPolicy } : {}),
			...(saved.settings?.artifactPolicy ? { config: saved.settings.artifactPolicy } : {}),
		});
		return { uiLocale, responseLanguage, artifactPolicy };
	}

	/**
	 * The current session's language override, or an empty one when it has none.
	 * An unreadable store is reported when a change is applied; the view falls
	 * back to the saved settings rather than failing to render.
	 */
	private sessionOverride(): LocalizationSessionOverride {
		try {
			return readLocalizationSessionOverride(this.paths.stateDir, this.sessionId);
		} catch {
			return {};
		}
	}

	/** The supported display locale a preference resolves to, following `auto`. */
	private previewEffectiveUiLocale(preference: UiLocalePreference): UiLocale {
		if (preference === "auto") {
			return resolveUiLocale({ cli: "auto", os: osLocaleCandidates(this.env) }).effective;
		}
		return preference;
	}

	/** The display label for a response-language preference. */
	private responseLanguageLabel(value: ResponseLanguagePreference): string {
		return value === "auto"
			? catalogText(this.catalog, CatalogMessageId.languageAuto)
			: languageSelfName(value, this.catalog);
	}

	/**
	 * Point the Settings view at the previewed interface catalog. Only this view's
	 * own text changes: no file, prompt, or session state is touched.
	 */
	private applyPreviewCatalog(): void {
		if (displayLanguageFixed(this.activityState())) {
			// A destructive confirmation fixes the display language: the prompt and
			// its object must read the same from the moment they appear until the
			// user answers. No preview is applied while it is open.
			this.catalog = this.baseCatalog;
			return;
		}
		if (this.previewUiLocale === undefined) {
			this.catalog = this.baseCatalog;
			return;
		}
		this.catalog = resolveCatalog(this.previewEffectiveUiLocale(this.previewUiLocale)).bundle;
	}

	/** Cycle the focused Language-view row, previewing the value inside Settings. */
	private cycleLanguageItem(direction: -1 | 1): void {
		const item = this.languageFocused;
		if (!item) return;
		// A language change waits while other work is in progress. Nothing is
		// changed: the selection, the input, the scroll position, and running work
		// stay as they were, and the reason is shown.
		const deferral = detectLocalizationDeferral(this.activityState(), this.catalog);
		if (deferral.deferred) {
			this.showDeferralMessage(deferral);
			return;
		}
		const state = this.languageState();
		const step = <T>(options: readonly T[], current: T): T => {
			const index = options.indexOf(current);
			return options[(Math.max(0, index) + direction + options.length) % options.length];
		};
		if (item === "ui") {
			this.previewUiLocale = step(SHIPPED_UI_LOCALE_PREFERENCES, this.previewUiLocale ?? state.uiLocale.requested);
		} else if (item === "response") {
			this.previewResponseLanguage = step(
				RESPONSE_LANGUAGE_PREFERENCES,
				this.previewResponseLanguage ?? state.responseLanguage.effective,
			);
		} else {
			this.previewArtifactPolicy = step(
				ARTIFACT_POLICY_PRESETS,
				this.previewArtifactPolicy ?? artifactPresetFor(state.artifactPolicy.effective),
			);
		}
		this.applyPreviewCatalog();
		this.message = {
			level: "info",
			text: catalogText(this.catalog, CatalogMessageId.settingsLanguagePreviewNotice, {
				cancel: formatEffectiveKeybinding(this.keybindings, "tui.select.cancel"),
			}),
		};
		this.messageOffset = 0;
		this.tui.requestRender();
	}

	/**
	 * Drop the Settings-only preview. Returns false when there was nothing to
	 * cancel, so the caller can close Settings instead. No file is written.
	 */
	private cancelLanguagePreview(): boolean {
		if (!this.previewActive) return false;
		this.clearLanguagePreviews();
		this.applyPreviewCatalog();
		this.message = {
			level: "info",
			text: catalogText(this.catalog, CatalogMessageId.settingsLanguagePreviewCanceled),
		};
		this.messageOffset = 0;
		this.tui.requestRender();
		return true;
	}

	/** Drop every Settings-only preview. No file is written. */
	private clearLanguagePreviews(): void {
		this.previewUiLocale = undefined;
		this.previewResponseLanguage = undefined;
		this.previewArtifactPolicy = undefined;
	}

	/** Re-resolve the panel's own catalog from the new effective display language. */
	private refreshLanguageCatalog(): void {
		this.baseCatalog = resolveCatalog(this.languageState().uiLocale.effective).bundle;
		this.applyPreviewCatalog();
	}

	/** Show why a language change waits, naming the confirmation keys when relevant. */
	private showDeferralMessage(deferral: LocalizationDeferral): void {
		const parts: string[] = [];
		const notice = deferralNotice(deferral, this.catalog);
		if (notice) parts.push(notice);
		if (deferral.primary === "confirmation") {
			// The change is not an answer to the confirmation. Name the keys that
			// are, so the operation is never re-approved by a language change.
			parts.push(
				reapprovalNotice(
					formatEffectiveKeybinding(this.keybindings, "tui.select.confirm"),
					formatEffectiveKeybinding(this.keybindings, "tui.select.cancel"),
					this.catalog,
				),
			);
		}
		this.message = { level: "warning", text: parts.join(" ") };
		this.messageOffset = 0;
		this.tui.requestRender();
	}

	/** Keep explicit previews until confirmation; equal effective values can still be saved. */
	private pendingLanguageRequest(): LocalizationRequest {
		if (!this.previewActive) {
			// Enter on one session-overridden row can promote it without previewing
			// a different value. Do not promote other rows or fill absent policy fields.
			const override = this.sessionOverride();
			if (this.languageFocused === "ui" && override.uiLocale !== undefined) return { uiLocale: override.uiLocale };
			if (this.languageFocused === "response" && override.responseLanguage !== undefined) {
				return { responseLanguage: override.responseLanguage };
			}
			if (this.languageFocused === "artifact" && override.artifactPolicy !== undefined) {
				return { artifactPolicy: override.artifactPolicy };
			}
			return {};
		}
		return {
			...(this.previewUiLocale !== undefined ? { uiLocale: this.previewUiLocale } : {}),
			...(this.previewResponseLanguage !== undefined ? { responseLanguage: this.previewResponseLanguage } : {}),
			...(this.previewArtifactPolicy !== undefined
				? { artifactPolicy: artifactPolicyForPreset(this.previewArtifactPolicy) }
				: {}),
		};
	}

	/** Compare the confirmed request with the current effective preference. */
	private languageChangeRows(
		request: LocalizationRequest,
	): Array<{ field: LocalizationField; from: string; to: string }> {
		const state = this.languageState();
		const rows: Array<{ field: LocalizationField; from: string; to: string }> = [];
		if (request.uiLocale !== undefined) {
			rows.push({
				field: "uiLocale",
				from: this.responseLanguageLabel(state.uiLocale.requested),
				to: this.responseLanguageLabel(request.uiLocale),
			});
		}
		if (request.responseLanguage !== undefined) {
			rows.push({
				field: "responseLanguage",
				from: this.responseLanguageLabel(state.responseLanguage.effective),
				to: this.responseLanguageLabel(request.responseLanguage),
			});
		}
		if (request.artifactPolicy !== undefined) {
			rows.push({
				field: "artifactPolicy",
				from: formatArtifactPolicy(state.artifactPolicy.effective),
				to: formatArtifactPolicy({ ...state.artifactPolicy.effective, ...request.artifactPolicy }),
			});
		}
		return rows;
	}

	/** Plan the persistent change and keep the plan for the confirmation summary. */
	private planLanguageChange(request: LocalizationRequest): {
		request: LocalizationRequest;
		plan: LocalizationPlan;
	} {
		return {
			request,
			plan: planLocalization(this.paths, {
				sessionId: this.sessionId,
				scope: "environment",
				request,
				env: this.env,
				catalog: this.catalog,
			}),
		};
	}

	/** Open the persistent-change confirmation for the current previews, or name why it waits. */
	private openLanguageConfirm(): void {
		const deferral = detectLocalizationDeferral(this.activityState(), this.catalog);
		if (deferral.deferred) {
			this.showDeferralMessage(deferral);
			return;
		}
		const request = this.pendingLanguageRequest();
		if (Object.keys(request).length === 0) {
			this.message = {
				level: "info",
				text: catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.noChange),
			};
			this.messageOffset = 0;
			this.tui.requestRender();
			return;
		}
		this.languageConfirm = this.planLanguageChange(request);
		this.message = undefined;
		this.messageOffset = 0;
		this.tui.requestRender();
	}

	/** Read the persisted result, not the plan's pre-apply effective values. */
	private notifyLanguageChange(result: LocalizationApplyResult): void {
		if (result.changed && result.plan.actions.some((action) => action.field === "uiLocale"))
			this.onUiLocaleChanged?.(this.languageState().uiLocale.effective);
		if (
			result.changed &&
			result.plan.actions.some((action) => action.field === "responseLanguage" || action.field === "artifactPolicy")
		) {
			this.onLanguageChanged?.(this.languageState());
		}
	}

	/** Apply the confirmed change through the operations layer and show the receipt. */
	private applyLanguageConfirm(): void {
		const confirm = this.languageConfirm;
		if (!confirm) return;
		const deferral = detectLocalizationDeferral(this.activityState(), this.catalog);
		if (deferral.deferred) {
			this.showDeferralMessage(deferral);
			return;
		}
		if (confirm.plan.conflicts.length > 0) {
			this.message = {
				level: "error",
				text: catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.applyFailed, {
					message: confirm.plan.conflicts[0]?.reason ?? "conflict",
				}),
			};
			this.messageOffset = 0;
			this.tui.requestRender();
			return;
		}
		try {
			const result = applyLocalization(this.paths, {
				sessionId: this.sessionId,
				scope: "environment",
				request: confirm.request,
				env: this.env,
				catalog: this.catalog,
			});
			this.notifyLanguageChange(result);
			this.languageConfirm = undefined;
			this.clearLanguagePreviews();
			this.refreshLanguageCatalog();
			this.languageReceipt = {
				kind: "apply",
				...(result.backupDir ? { backupDir: result.backupDir } : {}),
				transactionId: result.transactionId,
				notices: result.notices.length,
				uiLocaleChanged: result.plan.actions.some((action) => action.field === "uiLocale"),
			};
			this.message = { level: "info", text: this.languageReceiptText() };
		} catch (error) {
			this.message = {
				level: "error",
				text:
					error instanceof LocalizationRecoveryError
						? sanitizeTerminalText(error.message)
						: catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.applyFailed, {
								message: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
							}),
			};
		}
		this.messageOffset = 0;
		this.tui.requestRender();
	}

	/** Ask before resetting every language setting. */
	private openLanguageResetConfirm(): void {
		const deferral = detectLocalizationDeferral(this.activityState(), this.catalog);
		if (deferral.deferred) {
			this.showDeferralMessage(deferral);
			return;
		}
		this.languageResetConfirm = true;
		this.message = undefined;
		this.messageOffset = 0;
		this.tui.requestRender();
	}

	/** Reset every language setting through the operations layer and show the receipt. */
	private applyLanguageReset(): void {
		const deferral = detectLocalizationDeferral(this.activityState(), this.catalog);
		if (deferral.deferred) {
			this.showDeferralMessage(deferral);
			return;
		}
		try {
			const result = resetLocalization(this.paths, {
				sessionId: this.sessionId,
				env: this.env,
				catalog: this.catalog,
			});
			this.notifyLanguageChange(result);
			this.languageResetConfirm = false;
			this.clearLanguagePreviews();
			this.refreshLanguageCatalog();
			this.languageReceipt = {
				kind: "reset",
				...(result.backupDir ? { backupDir: result.backupDir } : {}),
				transactionId: result.transactionId,
				notices: result.notices.length,
				uiLocaleChanged: result.plan.actions.some((action) => action.field === "uiLocale"),
			};
			this.message = { level: "info", text: this.languageReceiptText() };
		} catch (error) {
			this.message = {
				level: "error",
				text:
					error instanceof LocalizationRecoveryError
						? sanitizeTerminalText(error.message)
						: catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.resetFailed, {
								message: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
							}),
			};
		}
		this.messageOffset = 0;
		this.tui.requestRender();
	}

	/** The receipt text for the last apply or reset, including the backup and transaction. */
	private languageReceiptText(): string {
		const receipt = this.languageReceipt;
		if (!receipt) return "";
		let text: string;
		if (receipt.kind === "reset") {
			text = receipt.backupDir
				? catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.resetDone, {
						backup: receipt.backupDir,
						transaction: receipt.transactionId,
					})
				: catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.resetDoneNoBackup, {
						transaction: receipt.transactionId,
					});
		} else {
			text = receipt.backupDir
				? catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.applied, {
						backup: receipt.backupDir,
						transaction: receipt.transactionId,
					})
				: catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.appliedNoBackup, {
						transaction: receipt.transactionId,
					});
		}
		if (receipt.notices > 0) {
			text += ` ${catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.notices, {
				count: String(receipt.notices),
			})}`;
		}
		if (receipt.uiLocaleChanged) {
			text += ` ${catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.savedRestart)}`;
		}
		return text;
	}

	/** Scroll complete modal content without dropping fields or recovery instructions. */
	private fitModalBody(lines: string[], budget: number, width: number, selected = 0): string[] {
		const identity = this.form ?? this.languageConfirm ?? this.languageResetConfirm;
		if (identity !== this.modalIdentity) {
			this.modalIdentity = identity;
			this.modalOffset = 0;
			this.modalManual = false;
		}
		this.modalTotal = lines.length;
		const overflow = lines.length > budget;
		this.modalCapacity = Math.max(1, budget - (overflow ? 1 : 0));
		if (!this.modalManual) {
			if (selected < this.modalOffset) this.modalOffset = selected;
			if (selected >= this.modalOffset + this.modalCapacity) this.modalOffset = selected - this.modalCapacity + 1;
		}
		this.modalOffset = Math.max(0, Math.min(this.modalOffset, lines.length - this.modalCapacity));
		const end = Math.min(lines.length, this.modalOffset + this.modalCapacity);
		const visible = lines.slice(this.modalOffset, end);
		if (overflow && budget > 1)
			visible.push(
				renderTerminalFrameRow(
					this.styles.apply(
						"palette.hint",
						this.scrollIndicator(this.modalOffset, end, lines.length, paletteInnerWidth(width)),
					),
					width,
					{ border: (value) => this.styles.apply("palette.border", value) },
				),
			);
		return visible;
	}

	/** The confirmation summary: the pending change and the recovery path. */
	private renderLanguageConfirm(width: number, line: (value?: string) => string, budget: number): string[] {
		const confirm = this.languageConfirm;
		if (!confirm) return [];
		const innerWidth = paletteInnerWidth(width);
		const items: Array<{ rank: number; text: string }> = [
			{
				rank: 0,
				text: line(
					renderPaletteHeading(
						catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.confirmHeading),
						innerWidth,
						this.theme,
						this.styles,
					),
				),
			},
		];
		for (const row of this.languageChangeRows(confirm.request)) {
			items.push({
				rank: 1,
				text: line(
					renderPaletteField({
						label: catalogText(this.catalog, LOCALIZATION_FIELD_LABEL_IDS[row.field]),
						labelRole: "palette.identity",
						value: catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.change, {
							from: row.from,
							to: row.to,
						}),
						labelWidth: LANGUAGE_LABEL_COLUMN,
						innerWidth,
						selected: false,
						theme: this.theme,
						styles: this.styles,
					}),
				),
			});
		}
		for (const recoveryLine of wrapTextWithAnsi(
			`  ${catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.recovery)}`,
			innerWidth,
		)) {
			items.push({ rank: 0, text: line(this.styles.apply("palette.hint", recoveryLine)) });
		}
		return this.fitModalBody(
			items.map((item) => item.text),
			budget,
			width,
		);
	}

	/** The reset confirmation: what reset does and the recovery path. */
	private renderLanguageResetConfirm(width: number, line: (value?: string) => string, budget: number): string[] {
		const innerWidth = paletteInnerWidth(width);
		const items: Array<{ rank: number; text: string }> = [
			{
				rank: 0,
				text: line(
					renderPaletteHeading(
						catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.resetHeading),
						innerWidth,
						this.theme,
						this.styles,
					),
				),
			},
		];
		for (const confirmLine of wrapTextWithAnsi(
			`  ${catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.resetConfirm)}`,
			innerWidth,
		)) {
			items.push({ rank: 1, text: line(this.styles.apply("palette.message.warning", confirmLine)) });
		}
		for (const recoveryLine of wrapTextWithAnsi(
			`  ${catalogText(this.catalog, LOCALIZATION_SETTINGS_MESSAGE_IDS.recovery)}`,
			innerWidth,
		)) {
			items.push({ rank: 0, text: line(this.styles.apply("palette.hint", recoveryLine)) });
		}
		return this.fitModalBody(
			items.map((item) => item.text),
			budget,
			width,
		);
	}

	/** The Language view's heading and three rows, each carrying its own selection flag. */
	private languageItems(
		innerWidth: number,
		line: (value?: string) => string,
	): Array<{ text: string; selected: boolean }> {
		const state = this.languageState();
		const previewSource = catalogText(this.catalog, CatalogMessageId.settingsLanguageSourcePreview);
		const row = (labelId: CatalogMessageId, value: string, source: string, item: LanguageItem) => ({
			text: line(
				renderPaletteField({
					label: catalogText(this.catalog, labelId),
					labelRole: "palette.identity",
					value,
					meta: source,
					labelWidth: LANGUAGE_LABEL_COLUMN,
					innerWidth,
					selected: this.languageFocused === item,
					theme: this.theme,
					styles: this.styles,
				}),
			),
			selected: this.languageFocused === item,
		});

		const uiEffective =
			this.previewUiLocale === undefined
				? state.uiLocale.effective
				: this.previewEffectiveUiLocale(this.previewUiLocale);
		const responseEffective = this.previewResponseLanguage ?? state.responseLanguage.effective;
		const artifactEffective =
			this.previewArtifactPolicy !== undefined
				? artifactPolicyForPreset(this.previewArtifactPolicy)
				: state.artifactPolicy.effective;

		return [
			row(
				CatalogMessageId.settingsLabelDisplayLanguage,
				this.previewUiLocale === undefined
					? languageSelfName(uiEffective, this.catalog)
					: this.responseLanguageLabel(this.previewUiLocale),
				this.previewUiLocale !== undefined ? previewSource : state.uiLocale.source,
				"ui",
			),
			row(
				CatalogMessageId.settingsLabelResponseLanguage,
				this.responseLanguageLabel(responseEffective),
				this.previewResponseLanguage !== undefined ? previewSource : state.responseLanguage.source,
				"response",
			),
			row(
				CatalogMessageId.settingsLabelArtifactPolicy,
				formatArtifactPolicy(artifactEffective),
				this.previewArtifactPolicy !== undefined ? previewSource : state.artifactPolicy.source,
				"artifact",
			),
		];
	}

	handleInput(data: string): void {
		if (this.form || this.languageConfirm || this.languageResetConfirm) {
			const first = matchesKey(data, "ctrl+home");
			const last = matchesKey(data, "ctrl+end");
			const up = this.messageCapacity === 0 && this.keybindings.matches(data, "tui.select.pageUp");
			const down = this.messageCapacity === 0 && this.keybindings.matches(data, "tui.select.pageDown");
			if (up || down || first || last) {
				this.modalManual = true;
				this.modalOffset = first
					? 0
					: last
						? Math.max(0, this.modalTotal - this.modalCapacity)
						: Math.max(
								0,
								Math.min(this.modalTotal - this.modalCapacity, this.modalOffset + (down ? 1 : -1) * this.modalCapacity),
							);
				this.tui.requestRender();
				return;
			}
			if (this.form && this.modalManual && !this.keybindings.matches(data, "tui.select.cancel")) {
				this.modalManual = false;
				this.tui.requestRender();
				return;
			}
		}
		if (this.message && this.message.text === this.messageIdentity && this.messageCapacity > 0) {
			const previous = this.keybindings.matches(data, "tui.select.pageUp");
			const next = this.keybindings.matches(data, "tui.select.pageDown");
			if (previous || next) {
				this.messageOffset = Math.max(0, this.messageOffset + (next ? 1 : -1) * this.messageCapacity);
				this.tui.requestRender();
				return;
			}
		}
		if (this.languageConfirm) {
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				this.applyLanguageConfirm();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.languageConfirm = undefined;
				this.tui.requestRender();
				return;
			}
			return;
		}
		if (this.languageResetConfirm) {
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				this.applyLanguageReset();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.languageResetConfirm = false;
				this.tui.requestRender();
				return;
			}
			return;
		}
		if (this.form) {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				if (this.busy) {
					this.controller?.abort();
				} else {
					const closeEmptySetup = this.form.mode === "add" && this.views.length === 0;
					this.form = undefined;
					this.syncInputFocus();
					if (closeEmptySetup) this.close();
				}
				this.tui.requestRender();
				return;
			}
			if (this.busy) return;
			if (this.keybindings.matches(data, "tui.select.up")) {
				this.cycleFormField(-1);
				return;
			}
			if (this.keybindings.matches(data, "tui.select.down")) {
				this.cycleFormField(1);
				return;
			}
			if (this.form.field === "auth" && (matchesKey(data, "left") || matchesKey(data, "right"))) {
				this.toggleAuth();
				return;
			}
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				void this.saveForm();
				return;
			}
			if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) return;
			this.activeInput()?.handleInput(data);
			this.message = undefined;
			this.tui.requestRender();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.confirmRemove) {
				this.confirmRemove = false;
				this.tui.requestRender();
				return;
			}
			if (this.confirmLogout) {
				this.confirmLogout = false;
				this.message = undefined;
				this.tui.requestRender();
				return;
			}
			// A running sign-in or sign-out owns the panel: cancel it here rather than
			// closing Settings and leaving the device flow polling unseen.
			if (this.busy && this.controller) {
				this.controller.abort();
				this.tui.requestRender();
				return;
			}
			if (!this.cancelLanguagePreview()) this.close();
			return;
		}
		if (this.busy) return;
		if (this.confirmLogout) {
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				this.confirmLogout = false;
				void this.disconnectShisa();
			}
			return;
		}
		if (!this.confirmRemove) {
			const up = this.keybindings.matches(data, "tui.select.up");
			const down = this.keybindings.matches(data, "tui.select.down");
			const pageUp = this.keybindings.matches(data, "tui.select.pageUp");
			const pageDown = this.keybindings.matches(data, "tui.select.pageDown");
			if (up || down) {
				this.moveFocus(up ? -1 : 1);
				return;
			}
			if (pageUp || pageDown) {
				if (this.focusKey().startsWith("source:") && this.expandedSourceId && this.expandedCapacity > 0) {
					this.expandedOffset = Math.max(0, this.expandedOffset + (pageUp ? -1 : 1) * this.expandedCapacity);
					this.tui.requestRender();
				} else this.pageScroll(pageUp ? -1 : 1);
				return;
			}
			// Pi has no select-scope Home/End actions; there is no live text field here.
			if (matchesKey(data, "home") || matchesKey(data, "end")) {
				this.scrollToEdge(matchesKey(data, "home") ? "top" : "bottom");
				return;
			}
		}
		if (this.languageFocused) {
			if (matchesKey(data, "left") || matchesKey(data, "right"))
				this.cycleLanguageItem(matchesKey(data, "left") ? -1 : 1);
			else if (this.keybindings.matches(data, "tui.select.confirm")) this.openLanguageConfirm();
			else if (data === "r") this.openLanguageResetConfirm();
			return;
		}
		if (this.aboutFocused) return;
		if (this.labelsFocused) {
			if (
				matchesKey(data, "left") ||
				matchesKey(data, "right") ||
				data === " " ||
				this.keybindings.matches(data, "tui.select.confirm")
			) {
				try {
					const enabled = !this.labelPolicy?.load().enabled;
					this.labelPolicy?.write(enabled);
					this.message = {
						level: "info",
						text: catalogText(this.catalog, CatalogMessageId.settingsAutoLabelsSaved, {
							state: enabled ? "on" : "off",
						}),
					};
				} catch (error) {
					this.message = {
						level: "error",
						text: catalogText(this.catalog, CatalogMessageId.settingsAutoLabelsNotSaved, {
							message: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
						}),
					};
				}
			}
			this.tui.requestRender();
			return;
		}
		if (this.dashboardFocused) {
			if (
				matchesKey(data, "left") ||
				matchesKey(data, "right") ||
				this.keybindings.matches(data, "tui.select.confirm")
			) {
				try {
					const current = loadDashboardPolicy(this.paths);
					const index = DASHBOARD_MODES.indexOf(current.mode);
					const mode = DASHBOARD_MODES[(index + (matchesKey(data, "left") ? 2 : 1)) % 3];
					writeDashboardPolicy(this.paths, mode);
					this.onDashboardChanged?.();
					this.message = {
						level: "info",
						text: catalogText(this.catalog, CatalogMessageId.settingsDashboardSaved, { mode }),
					};
				} catch (error) {
					this.message = {
						level: "error",
						text: catalogText(this.catalog, CatalogMessageId.settingsDashboardNotSaved, {
							message: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
						}),
					};
				}
			}
			this.tui.requestRender();
			return;
		}
		if (this.accountFocused) {
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				if (!this.account.signedIn) {
					void this.connectShisa();
					return;
				}
				this.openBrowser?.(this.account.dashboardUrl);
				this.message = {
					level: "info",
					text: this.openBrowser
						? catalogText(this.catalog, CatalogMessageId.settingsDashboardOpened, {
								url: this.account.dashboardUrl,
							})
						: catalogText(this.catalog, CatalogMessageId.settingsDashboardAddress, {
								url: this.account.dashboardUrl,
							}),
				};
				this.messageOffset = 0;
				this.tui.requestRender();
				return;
			}
			if (data === "d" && this.account.signedIn) {
				this.confirmLogout = true;
				this.message = {
					level: "error",
					text: catalogText(this.catalog, CatalogMessageId.settingsSignOutConfirm, {
						confirm: formatEffectiveKeybinding(this.keybindings, "tui.select.confirm"),
						cancel: formatEffectiveKeybinding(this.keybindings, "tui.select.cancel"),
					}),
				};
				this.messageOffset = 0;
				this.tui.requestRender();
				return;
			}
			return;
		}
		if (this.confirmRemove) {
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				const source = this.selected()?.source;
				if (source) {
					this.store.remove(source.id);
					this.expandedSourceId = undefined;
					this.reloadViews();
					this.message = {
						level: "info",
						text: catalogText(this.catalog, CatalogMessageId.settingsRemoved, {
							label: sanitizeTerminalText(source.label),
						}),
					};
					this.onCatalogsChanged?.();
				}
				this.confirmRemove = false;
				this.tui.requestRender();
			}
			return;
		}
		if (this.contextFocused) {
			if (matchesKey(data, "left") || matchesKey(data, "right"))
				this.stepContextLimit(matchesKey(data, "right") ? 1 : -1);
			return;
		}
		if (matchesKey(data, "right") && this.selected()) {
			this.expandedSourceId = this.selected()?.source.id;
			this.expandedOffset = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "left") && this.expandedSourceId) {
			this.expandedSourceId = undefined;
			this.expandedOffset = 0;
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const source = this.selected()?.source;
			if (source && this.store.isCodeOwned(source)) {
				this.message = {
					level: "info",
					text: catalogText(this.catalog, CatalogMessageId.settingsBuiltInSource, {
						label: sanitizeTerminalText(source.label),
						key: formatKeyId("space"),
					}),
				};
				this.tui.requestRender();
				return;
			}
			this.startForm(this.selected() ? "edit" : "add");
			return;
		}
		if (data === "a") {
			this.startForm("add");
			return;
		}
		if (data === "r") {
			void this.refreshSelected();
			return;
		}
		if (data === "u" && !this.busy && this.selectedHeld().length > 0) {
			void this.reviewHeld(this.selectedHeld());
			return;
		}
		if (data === "d" && this.selected()) {
			const selected = this.selected()?.source;
			if (selected && this.store.isCodeOwned(selected)) {
				this.message = {
					level: "info",
					text: catalogText(this.catalog, CatalogMessageId.settingsBuiltInCannotRemove, {
						label: sanitizeTerminalText(selected.label),
						key: formatKeyId("space"),
					}),
				};
				this.tui.requestRender();
				return;
			}
			this.confirmRemove = true;
			this.message = {
				level: "error",
				text: catalogText(this.catalog, CatalogMessageId.settingsRemoveConfirm, {
					confirm: formatEffectiveKeybinding(this.keybindings, "tui.select.confirm"),
					cancel: formatEffectiveKeybinding(this.keybindings, "tui.select.cancel"),
				}),
			};
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "space") && this.selected()) {
			const source = this.selected()?.source;
			if (!source) return;
			const updated = this.store.setEnabled(source.id, !source.enabled);
			this.reloadViews(updated.id);
			this.message = {
				level: "info",
				text: catalogText(this.catalog, CatalogMessageId.settingsSourceToggled, {
					label: sanitizeTerminalText(updated.label),
					state: updated.enabled ? "enabled" : "disabled",
				}),
			};
			this.onCatalogsChanged?.();
			this.tui.requestRender();
		}
	}

	/** Keep every form row reachable and follow the focused field until manual paging. */
	private renderForm(width: number, line: (value?: string) => string, budget: number): string[] {
		const items = this.formItems(width);
		const warning = items.filter((item) => item.rank === 0 && !item.text.includes("→"));
		const pinWarning = warning.length > 0 && warning.length + 2 <= budget;
		const body = pinWarning ? items.filter((item) => !warning.includes(item)) : items;
		const selected = Math.max(
			0,
			body.findIndex((item) => item.rank === 0 && item.text.includes("→")),
		);
		return [
			...(pinWarning ? warning.map((item) => line(item.text)) : []),
			...this.fitModalBody(
				body.map((item) => line(item.text)),
				budget - (pinWarning ? warning.length : 0),
				width,
				selected,
			),
		];
	}

	/** Body rows the form can never shed: every field plus the transport warning. */
	private formRequired(width: number): number {
		const form = this.form;
		if (!form) return 0;
		const innerWidth = paletteInnerWidth(width);
		const fields = form.authType === "bearer" ? 5 : 3;
		const transportWarning = transportWarningText(this.catalog, form.url.getValue().trim());
		const warningLines = transportWarning ? wrapTextWithAnsi(transportWarning, innerWidth).length : 0;
		return fields + warningLines;
	}

	private formItems(width: number): Array<{ rank: number; text: string }> {
		const form = this.form;
		if (!form) return [];
		const text = (id: CatalogMessageId): string => catalogText(this.catalog, id);
		const innerWidth = paletteInnerWidth(width);
		const field = (id: FormField, label: string, value: string) =>
			renderPaletteField({
				label,
				value,
				labelWidth: FORM_LABEL_COLUMN,
				innerWidth,
				selected: form.field === id,
				theme: this.theme,
				styles: this.styles,
			});
		const inputWidth = Math.max(1, innerWidth - FORM_LABEL_COLUMN - 3);
		const editedSource = form.sourceId
			? this.views.find((view) => view.source.id === form.sourceId)?.source
			: undefined;
		const heading =
			form.mode === "add"
				? catalogText(this.catalog, CatalogMessageId.settingsFormAddHeading)
				: catalogText(this.catalog, CatalogMessageId.settingsFormEditHeading, {
						label: sanitizeTerminalText(editedSource?.label ?? "catalog"),
					});
		const items: Array<{ rank: number; text: string }> = [
			{ rank: 2, text: renderPaletteHeading(heading, innerWidth, this.theme, this.styles) },
			{
				rank: form.field === "label" ? 0 : 1,
				text: field("label", text(CatalogMessageId.settingsFieldLabel), form.label.render(inputWidth)[0] ?? ""),
			},
			{
				rank: form.field === "url" ? 0 : 1,
				text: field("url", text(CatalogMessageId.settingsFieldUrl), form.url.render(inputWidth)[0] ?? ""),
			},
		];
		const transportWarning = transportWarningText(this.catalog, form.url.getValue().trim());
		if (transportWarning) {
			for (const warningLine of wrapTextWithAnsi(transportWarning, innerWidth)) {
				items.push({ rank: 0, text: this.styles.apply("palette.message.warning", warningLine) });
			}
		}
		items.push({
			rank: form.field === "auth" ? 0 : 1,
			text: field(
				"auth",
				text(CatalogMessageId.settingsFieldAuth),
				paletteChoice(
					form.authType === "none"
						? text(CatalogMessageId.settingsAuthNone)
						: text(CatalogMessageId.settingsAuthBearer),
				),
			),
		});
		if (form.authType === "bearer") {
			const credentialName = form.credential.getValue().trim();
			const credentialValue = credentialName ? this.env[credentialName] : undefined;
			const credentialAvailable = typeof credentialValue === "string" && Boolean(credentialValue.trim());
			let savedToken = false;
			try {
				savedToken = form.sourceId ? getCatalogSourceToken(this.paths, form.sourceId) !== undefined : false;
			} catch {
				savedToken = false;
			}
			const enteredToken = form.token.getValue().trim();
			items.push({
				rank: form.field === "credential" ? 0 : 1,
				text: field(
					"credential",
					text(CatalogMessageId.settingsFieldCredential),
					form.credential.render(inputWidth)[0] ?? "",
				),
			});
			for (const hintLine of wrapTextWithAnsi(
				`${" ".repeat(FORM_LABEL_COLUMN + 2)}Enter the variable name, not the token. Set it before launching Jouzu, for example with export NAME=… in ~/.bashrc or ~/.zshrc. The environment value is never saved.`,
				innerWidth,
			)) {
				items.push({ rank: 4, text: this.styles.apply("palette.hint", hintLine) });
			}
			if (credentialName) {
				for (const hintLine of wrapTextWithAnsi(
					`${" ".repeat(FORM_LABEL_COLUMN + 2)}${catalogText(
						this.catalog,
						CatalogMessageId.settingsCredentialAvailability,
						{
							name: sanitizeTerminalText(credentialName),
							state: credentialAvailable ? "set" : savedToken ? "saved" : "unset",
						},
					)}`,
					innerWidth,
				)) {
					items.push({ rank: 3, text: this.styles.apply("palette.hint", hintLine) });
				}
			}
			items.push({
				rank: form.field === "token" ? 0 : 1,
				text: field(
					"token",
					text(CatalogMessageId.settingsFieldToken),
					maskRenderedInput(form.token.render(inputWidth)[0] ?? ""),
				),
			});
			for (const hintLine of wrapTextWithAnsi(
				`${" ".repeat(FORM_LABEL_COLUMN + 2)}Optional: enter a token to save it in Jouzu's private credential store. The variable takes precedence when set.`,
				innerWidth,
			)) {
				items.push({ rank: 4, text: this.styles.apply("palette.hint", hintLine) });
			}
			if (savedToken && !enteredToken) {
				for (const hintLine of wrapTextWithAnsi(
					`${" ".repeat(FORM_LABEL_COLUMN + 2)}A token is saved for this source; leave this empty to keep it, or enter a new one to replace it.`,
					innerWidth,
				)) {
					items.push({ rank: 4, text: this.styles.apply("palette.hint", hintLine) });
				}
			}
			if (enteredToken && credentialAvailable) {
				for (const hintLine of wrapTextWithAnsi(
					`${" ".repeat(FORM_LABEL_COLUMN + 2)}Warning: ${sanitizeTerminalText(credentialName)} is set and takes precedence over the saved token.`,
					innerWidth,
				)) {
					items.push({ rank: 3, text: this.styles.apply("palette.message.warning", hintLine) });
				}
			}
		}
		return items;
	}

	private hints(): PaletteKeyHint[] {
		const text = (id: string): string => catalogText(this.catalog, id);
		const confirm = formatEffectiveKeybinding(this.keybindings, "tui.select.confirm");
		const cancel = formatEffectiveKeybinding(this.keybindings, "tui.select.cancel");
		const move = formatEffectiveKeyPair(this.keybindings, "tui.select.up", "tui.select.down");
		if (this.form)
			return [
				{ key: confirm, label: text(CatalogMessageId.settingsHintSave) },
				{ key: move, label: text(CatalogMessageId.settingsHintField) },
				{ key: "←→", label: text(CatalogMessageId.settingsHintChangeAuth) },
				{ key: cancel, label: text(CatalogMessageId.settingsHintCancel) },
			];
		if (this.confirmRemove)
			return [
				{ key: confirm, label: text(CatalogMessageId.settingsHintRemove) },
				{ key: cancel, label: text(CatalogMessageId.settingsHintCancel) },
			];
		if (this.confirmLogout)
			return [
				{ key: confirm, label: text(CatalogMessageId.settingsHintSignOut) },
				{ key: cancel, label: text(CatalogMessageId.settingsHintCancel) },
			];
		if (this.busy && this.accountFocused)
			return [
				{ key: cancel, label: text(CatalogMessageId.settingsHintCancel) },
				{ key: move, label: text(CatalogMessageId.settingsHintMove) },
			];
		if (this.accountFocused)
			return this.account.signedIn
				? [
						{ key: confirm, label: text(CatalogMessageId.settingsHintDashboard) },
						{ key: "D", label: text(CatalogMessageId.settingsHintSignOut) },
						{ key: "Tab", label: text(CatalogMessageId.settingsHintSection) },
						{ key: move, label: text(CatalogMessageId.settingsHintMove) },
						{ key: cancel, label: text(CatalogMessageId.settingsHintClose) },
					]
				: [
						{ key: confirm, label: text(CatalogMessageId.settingsHintConnect) },
						{ key: "Tab", label: text(CatalogMessageId.settingsHintSection) },
						{ key: move, label: text(CatalogMessageId.settingsHintMove) },
						{ key: cancel, label: text(CatalogMessageId.settingsHintClose) },
					];
		if (this.languageConfirm)
			return [
				{ key: confirm, label: text(LOCALIZATION_SETTINGS_MESSAGE_IDS.hintApply) },
				{ key: cancel, label: text(CatalogMessageId.settingsHintCancel) },
			];
		if (this.languageResetConfirm)
			return [
				{ key: confirm, label: text(LOCALIZATION_SETTINGS_MESSAGE_IDS.hintReset) },
				{ key: cancel, label: text(CatalogMessageId.settingsHintCancel) },
			];
		if (this.languageFocused)
			return [
				{ key: confirm, label: text(LOCALIZATION_SETTINGS_MESSAGE_IDS.hintApply) },
				{ key: "←→", label: text(CatalogMessageId.settingsHintLanguage) },
				{ key: "R", label: text(LOCALIZATION_SETTINGS_MESSAGE_IDS.hintReset) },
				{ key: move, label: text(CatalogMessageId.settingsHintMove) },
				{
					key: cancel,
					label: this.previewActive
						? text(CatalogMessageId.settingsHintCancelPreview)
						: text(CatalogMessageId.settingsHintClose),
				},
			];
		if (this.aboutFocused)
			return [
				{ key: move, label: text(CatalogMessageId.settingsHintScroll) },
				{ key: "Tab/Shift+Tab", label: text(CatalogMessageId.settingsHintSection) },
				{ key: cancel, label: text(CatalogMessageId.settingsHintClose) },
			];
		if (this.labelsFocused)
			return [
				{ key: `${confirm}/Space/←→`, label: text(CatalogMessageId.settingsHintAutoLabels) },
				{ key: move, label: text(CatalogMessageId.settingsHintMove) },
				{ key: cancel, label: text(CatalogMessageId.settingsHintClose) },
			];
		if (this.dashboardFocused)
			return [
				{ key: `${confirm}/←→`, label: text(CatalogMessageId.settingsHintDisplayMode) },
				{ key: "Tab", label: text(CatalogMessageId.settingsHintSection) },
				{ key: move, label: text(CatalogMessageId.settingsHintMove) },
				{ key: cancel, label: text(CatalogMessageId.settingsHintClose) },
			];
		if (this.contextFocused)
			return [
				{ key: "←→", label: text(CatalogMessageId.settingsHintContextLimit) },
				{ key: "Tab", label: text(CatalogMessageId.settingsHintSection) },
				{ key: move, label: text(CatalogMessageId.settingsHintMove) },
				{ key: cancel, label: text(CatalogMessageId.settingsHintClose) },
			];
		return [
			{ key: confirm, label: text(CatalogMessageId.settingsHintEdit) },
			...(this.selectedHeld().length > 0 ? [{ key: "U", label: text(CatalogMessageId.settingsHintReviewUpdate) }] : []),
			{ key: "A", label: text(CatalogMessageId.settingsHintAdd) },
			{ key: "R", label: text(CatalogMessageId.settingsHintRefresh) },
			{ key: "D", label: text(CatalogMessageId.settingsHintRemove) },
			{ key: "Space", label: text(CatalogMessageId.settingsHintEnable) },
			{ key: "←→", label: text(CatalogMessageId.settingsHintModels) },
			{ key: "Tab", label: text(CatalogMessageId.settingsHintSection) },
			{ key: move, label: text(CatalogMessageId.settingsHintMove) },
			{ key: cancel, label: text(CatalogMessageId.settingsHintClose) },
		];
	}

	private selectedDetailGroups(
		view: SourceView,
		innerWidth: number,
		line: (value?: string) => string,
	): { detail: string[]; warning: string[]; conflict: string[] } {
		const status = view.status;
		const credential =
			status.configured && status.credentialName
				? status.credentialLogin && !status.credentialEnv && !status.credentialStored
					? ` ${catalogText(this.catalog, CatalogMessageId.settingsCredentialLogin)}`
					: ` ${catalogText(this.catalog, CatalogMessageId.settingsCredentialState, {
							name: status.credentialName,
							state: status.credentialEnv ? "set" : status.credentialStored ? "stored" : "unset",
						})}`
				: "";
		const detail = [
			line(
				this.styles.apply(
					"palette.detail",
					fitTerminalText(
						`    ${sanitizeTerminalText(view.source.url)}${sanitizeTerminalText(credential)}`,
						innerWidth,
					),
				),
			),
		];
		const warning: string[] = [];
		const transportWarning = transportWarningText(this.catalog, view.source.url);
		if (transportWarning) warning.push(...warnHint(this.styles, transportWarning, innerWidth, line));
		const credentialWarning = credentialWarningText(this.catalog, status);
		if (credentialWarning) warning.push(...warnHint(this.styles, credentialWarning, innerWidth, line));
		const heldWarning = heldWarningText(this.catalog, status);
		if (heldWarning) warning.push(...warnHint(this.styles, heldWarning, innerWidth, line));
		const conflict: string[] = [];
		if (status.configured && status.conflict) {
			conflict.push(
				...wrapTextWithAnsi(`    ${sanitizeTerminalText(status.conflict)}`, innerWidth).map((conflictLine) =>
					line(this.styles.apply("palette.hint", conflictLine)),
				),
			);
		}
		return { detail, warning, conflict };
	}

	/** Body rows the sources list can never shed: the selected row and its full warnings. */
	private sourcesRequired(width: number): number {
		if (this.views.length === 0) return 2;
		const innerWidth = paletteInnerWidth(width);
		const selected = this.views[this.selectedIndex];
		const warnings = [
			transportWarningText(this.catalog, selected.source.url),
			credentialWarningText(this.catalog, selected.status),
			heldWarningText(this.catalog, selected.status),
		];
		const warningLines = warnings.reduce(
			(total, warning) => total + (warning ? wrapTextWithAnsi(warning, innerWidth).length : 0),
			0,
		);
		return 1 + warningLines;
	}

	/** The global ceiling row, rendered above the catalog list and dropped when the list needs its room. */
	/**
	 * One row for the Shisa account: connection state and organization when signed
	 * in, and a neutral connection state when signed out. The dashboard address and
	 * connect key ride in the metadata column, which truncates before the value.
	 */
	private accountRow(innerWidth: number, line: (value?: string) => string): string {
		const confirm = formatEffectiveKeybinding(this.keybindings, "tui.select.confirm");
		const identity =
			this.account.credential === "environment"
				? catalogText(this.catalog, CatalogMessageId.settingsAccountConnectedDetail, {
						detail: SHISA_API_CATALOG_CREDENTIAL_ENV,
					})
				: this.account.org
					? catalogText(this.catalog, CatalogMessageId.settingsAccountConnectedDetail, {
							detail: sanitizeTerminalText(this.account.org),
						})
					: catalogText(this.catalog, CatalogMessageId.settingsAccountConnected);
		const value = this.account.signedIn
			? this.styles.apply("palette.status.ready", identity)
			: this.styles.apply(
					"palette.status.off",
					catalogText(this.catalog, CatalogMessageId.settingsAccountNotConnected),
				);
		// The metadata column truncates before the value, so it carries the shorter of
		// the two: the dashboard address without its scheme, or the connect key.
		const meta = this.account.signedIn
			? this.account.dashboardUrl.replace(/^https?:\/\//u, "")
			: catalogText(this.catalog, CatalogMessageId.settingsAccountConnectMeta, { key: confirm });
		return line(
			renderPaletteField({
				label: catalogText(this.catalog, CatalogMessageId.settingsLabelAccount),
				labelRole: "palette.identity",
				value,
				meta,
				labelWidth: SOURCE_LABEL_COLUMN,
				innerWidth,
				selected: this.accountFocused,
				theme: this.theme,
				styles: this.styles,
			}),
		);
	}

	/** Sign in through the same device flow as `/login shisa`, reported in this panel. */
	private async connectShisa(): Promise<void> {
		if (!this.jouzuVersion) {
			this.message = { level: "error", text: catalogText(this.catalog, CatalogMessageId.settingsLoginHint) };
			this.tui.requestRender();
			return;
		}
		this.busy = true;
		this.controller = new AbortController();
		const signal = this.controller.signal;
		const reportText = (level: "error" | "info" | "warning", text: string) => {
			if (this.disposed) return;
			this.message = { level, text };
			this.messageOffset = 0;
			this.tui.requestRender();
		};
		const report = (level: "error" | "info" | "warning", message: CatalogMessageRef) =>
			reportText(level, catalogMessageText(this.catalog, message));
		const cancel = formatEffectiveKeybinding(this.keybindings, "tui.select.cancel");
		report("info", catalogMessage(CatalogMessageId.settingsSignInRequestingCode, { cancel }));
		let completion: ShisaLoginCompletion | undefined;
		try {
			await this.login(
				{
					signal,
					onDeviceCode: ({ verificationUri, userCode }) =>
						report(
							"info",
							catalogMessage(CatalogMessageId.settingsSignInDeviceCode, {
								uri: sanitizeTerminalText(verificationUri),
								code: sanitizeTerminalText(userCode),
								cancel,
							}),
						),
					onAuth: ({ url }) => this.openBrowser?.(url),
					onPrompt: async () => {
						throw new Error(catalogText(this.catalog, CatalogMessageId.settingsSignInUnexpectedPrompt));
					},
					onSelect: async () => undefined,
					onProgress: (text: string) => reportText("info", sanitizeTerminalText(text)),
				},
				{
					paths: this.paths,
					jouzuVersion: this.jouzuVersion,
					gatewayUrl: resolveShisaGatewayUrl(this.env),
					onCompletion: (value) => {
						completion = value;
					},
					...(this.openBrowser ? { openBrowser: this.openBrowser } : {}),
				},
			);
			setShisaSignedOut(this.paths, false);
			this.account = readShisaAccountStatus(this.paths, this.env);
			this.reloadViews();
			this.onCatalogsChanged?.();
			try {
				await this.onAccountChanged?.({ signedIn: true });
			} catch {
				// The host owns its own recovery message; the credential is already saved.
			}
			if (completion?.acknowledged === false) {
				// The device flow saves the credential before acknowledgement, so an
				// incomplete confirmation is a warning with a recovery action, never a
				// plain success screen.
				report(
					"warning",
					completion.reason === "cancelled"
						? catalogMessage(CatalogMessageId.shisaSignInConfirmInterrupted)
						: catalogMessage(CatalogMessageId.shisaSignInConfirmFailed),
				);
			} else {
				report("info", catalogMessage(CatalogMessageId.settingsSignInConnected));
			}
		} catch {
			// Remote errors can carry credentials; keep the panel's recovery text local.
			report(
				"error",
				signal.aborted
					? catalogMessage(CatalogMessageId.shisaOnboardingCancelled)
					: catalogMessage(CatalogMessageId.settingsSignInCouldNotComplete),
			);
		} finally {
			this.busy = false;
			this.controller = undefined;
			if (!this.disposed) this.tui.requestRender();
		}
	}

	/** Revoke and remove this device's key, through the same path as `/logout shisa`. */
	private async disconnectShisa(): Promise<void> {
		this.busy = true;
		this.controller = new AbortController();
		try {
			const result = await this.logout({ paths: this.paths, signal: this.controller.signal });
			this.account = readShisaAccountStatus(this.paths, this.env);
			this.reloadViews();
			this.onCatalogsChanged?.();
			try {
				await this.onAccountChanged?.({ signedIn: false });
			} catch {
				// The host owns its own recovery message; local sign-out already completed.
			}
			this.message = {
				level: result.localCleared ? "info" : "error",
				text: shisaLogoutMessage(result, Boolean(this.env.SHISA_API_KEY?.trim())),
			};
		} catch {
			this.message = {
				level: "error",
				text: catalogText(this.catalog, CatalogMessageId.settingsSignOutFailed),
			};
		} finally {
			this.busy = false;
			this.controller = undefined;
			this.messageOffset = 0;
			if (!this.disposed) this.tui.requestRender();
		}
	}

	private contextRow(innerWidth: number, line: (value?: string) => string): string {
		return line(
			renderPaletteField({
				label: catalogText(this.catalog, CatalogMessageId.settingsLabelContextLimit),
				labelRole: "palette.identity",
				value: this.styles.apply("palette.detail", paletteChoice(formatContextClamp(this.maxContextTokens))),
				labelWidth: SOURCE_LABEL_COLUMN,
				innerWidth,
				selected: this.contextFocused,
				theme: this.theme,
				styles: this.styles,
			}),
		);
	}

	/**
	 * One-frame paging indicator, kept to a single line so the trailer
	 * reservation below always holds: the key names yield before the range.
	 */
	private pagingHintText(start: number, end: number, count: number, innerWidth: number): string {
		const range = `${start + 1}-${end}/${count}`;
		const keys = formatEffectiveKeyPair(this.keybindings, "tui.select.pageUp", "tui.select.pageDown");
		const full = `    ${range} · ${keys}`;
		if (terminalTextWidth(full) <= innerWidth) return full;
		return fitTerminalText(`    ${range}`, innerWidth);
	}

	/** One document, with anchors for every control and report line. Only its viewport is clipped. */
	private renderSettings(width: number, line: (value?: string) => string, budget: number): string[] {
		this.expandedCapacity = 0;
		this.bodyCapacity = budget;
		this.focusRows.clear();
		const innerWidth = paletteInnerWidth(width);
		const lines: string[] = [];
		const add = (key: string, text: string): void => {
			this.focusRows.set(key, lines.length);
			lines.push(text);
		};
		const heading = (id: CatalogMessageId, meta = "") =>
			line(renderPaletteHeading(catalogText(this.catalog, id), innerWidth, this.theme, this.styles, meta));
		lines.push(heading(CatalogMessageId.settingsHeadingLanguage));
		this.languageItems(innerWidth, line).forEach((item, index) => {
			add(["ui", "response", "artifact"][index], item.text);
		});
		for (const text of wrapTextWithAnsi(`  ${upstreamSwitchNotice(this.catalog)}`, innerWidth))
			lines.push(line(this.styles.apply("palette.hint", text)));
		add("account", this.accountRow(innerWidth, line));
		if (!this.account.signedIn)
			for (const text of wrapTextWithAnsi(
				catalogText(this.catalog, CatalogMessageId.shisaOnboardingPointCredits),
				innerWidth,
			))
				lines.push(line(this.styles.apply("palette.hint", text)));
		add("context", this.contextRow(innerWidth, line));
		const dashboardRow = this.onDashboardChanged
			? line(
					renderPaletteField({
						label: catalogText(this.catalog, CatalogMessageId.settingsLabelDashboard),
						labelRole: "palette.identity",
						value: this.styles.apply("palette.detail", paletteChoice(loadDashboardPolicy(this.paths).mode)),
						labelWidth: SOURCE_LABEL_COLUMN,
						innerWidth,
						selected: this.dashboardFocused,
						theme: this.theme,
						styles: this.styles,
					}),
				)
			: undefined;
		const labelPolicyState = this.labelPolicy?.load();
		const labelsRow = this.labelPolicy
			? line(
					renderPaletteField({
						label: catalogText(this.catalog, CatalogMessageId.settingsLabelAutoLabels),
						labelRole: "palette.identity",
						value: this.styles.apply(
							"palette.detail",
							paletteChoice(
								catalogText(this.catalog, CatalogMessageId.settingsAutoLabelsState, {
									state: labelPolicyState?.error ? "error" : labelPolicyState?.enabled ? "on" : "off",
								}),
							),
						),
						labelWidth: SOURCE_LABEL_COLUMN,
						innerWidth,
						selected: this.labelsFocused,
						theme: this.theme,
						styles: this.styles,
					}),
				)
			: undefined;
		if (dashboardRow) add("dashboard", dashboardRow);
		if (labelsRow) add("labels", labelsRow);
		const active = this.views.filter((view) => view.source.enabled && view.status.status === "active").length;
		const catalogHeading = lines.length;
		lines.push(
			heading(
				CatalogMessageId.settingsHeadingModelCatalogs,
				`${active}/${this.views.length} ${catalogText(this.catalog, CatalogMessageId.catalogStateActive)}`,
			),
		);
		if (this.views.length === 0) {
			add(
				"catalogs",
				line(
					renderPaletteField({
						label: catalogText(this.catalog, CatalogMessageId.settingsFormAddHeading),
						labelWidth: 0,
						innerWidth,
						selected: this.focusKey() === "catalogs",
						theme: this.theme,
						styles: this.styles,
					}),
				),
			);
		}
		let selectedEnd = 0;
		let expandedRange: { start: number; end: number; capacity: number } | undefined;
		for (const view of this.views) {
			const key = `source:${view.source.id}`;
			const isSelected = this.focusKey() === key;
			const expanded = this.expandedSourceId === view.source.id;
			const count = view.status.configured
				? (view.status.offeringCount ?? view.offerings.length)
				: view.offerings.length;
			add(
				key,
				line(
					renderPaletteField({
						label: `${expanded ? "▾" : "▸"} ${fitTerminalText(sanitizeTerminalText(view.source.label), SOURCE_LABEL_COLUMN - 2)}`,
						labelRole: "palette.identity",
						value: this.styles.apply(sourceStatusRole(view), sourceStatusText(view)),
						meta: catalogText(this.catalog, CatalogMessageId.settingsModelCount, { count }),
						labelWidth: SOURCE_LABEL_COLUMN,
						innerWidth,
						selected: isSelected,
						theme: this.theme,
						styles: this.styles,
					}),
				),
			);
			const extras = this.selectedDetailGroups(view, innerWidth, line);
			if (isSelected) lines.push(...extras.warning);
			if (expanded) {
				const capacity = Math.max(
					1,
					Math.min(view.offerings.length, isSelected ? budget - extras.warning.length - 3 : 1),
				);
				this.expandedOffset = Math.min(this.expandedOffset, Math.max(0, view.offerings.length - capacity));
				const start = lines.length;
				for (const offering of view.offerings.slice(this.expandedOffset, this.expandedOffset + capacity)) {
					lines.push(
						line(
							renderPaletteField({
								label: `    ${catalogText(this.catalog, CatalogMessageId.settingsOfferingRow, {
									provider: offering.providerId,
									model: offering.modelId,
								})}`,
								labelRole: "palette.identity",
								value: this.styles.apply("palette.detail", offering.name),
								labelWidth: SOURCE_LABEL_COLUMN + 12,
								innerWidth,
								selected: false,
								theme: this.theme,
								styles: this.styles,
							}),
						),
					);
				}
				if (!view.offerings.length)
					lines.push(
						line(
							this.styles.apply(
								"palette.empty",
								`    ${catalogText(this.catalog, CatalogMessageId.settingsEmptyNoOfferings)}`,
							),
						),
					);
				else if (view.offerings.length > capacity)
					lines.push(
						line(
							this.styles.apply(
								"palette.hint",
								this.pagingHintText(
									this.expandedOffset,
									Math.min(view.offerings.length, this.expandedOffset + capacity),
									view.offerings.length,
									innerWidth,
								),
							),
						),
					);
				expandedRange = { start, end: lines.length, capacity };
			}
			if (isSelected) {
				selectedEnd = lines.length;
				// Warnings and offerings have priority; details remain in the same scrollable document.
				lines.push(...extras.detail, ...extras.conflict);
			}
		}
		const aboutHeading = lines.length;
		if (this.runtime) {
			lines.push(heading(CatalogMessageId.settingsViewAbout));
			const report = this.runtime
				.about()
				.split("\n")
				.flatMap((text) => wrapTextWithAnsi(sanitizeTerminalText(text), Math.max(1, innerWidth - 2)));
			this.aboutRows = Math.max(1, report.length);
			this.aboutOffset = Math.min(this.aboutOffset, this.aboutRows - 1);
			for (const [index, text] of report.entries()) {
				const selected = this.aboutFocused && this.aboutOffset === index;
				add(
					`about:${index}`,
					line(
						`${selected ? this.styles.apply("palette.marker", "→") : " "} ${this.styles.apply("palette.value", text)}`,
					),
				);
			}
		}
		const selectedRow = this.focusRows.get(this.focusKey()) ?? 0;
		const contentRows = lines.length;
		const overflowing = contentRows > budget;
		const viewportRows = overflowing ? Math.max(1, budget - 1) : budget;
		this.contentRows = contentRows;
		this.viewportRows = viewportRows;
		this.bodyCapacity = viewportRows;
		const maximumOffset = Math.max(0, contentRows - viewportRows);
		if (this.scrollToTop) {
			this.scrollOffset = 0;
			this.scrollToTop = false;
			this.ensureFocusVisible = false;
		} else if (this.scrollToBottom) {
			this.scrollOffset = maximumOffset;
			this.scrollToBottom = false;
			this.ensureFocusVisible = false;
		} else if (this.scrollToSection) {
			this.scrollOffset = this.aboutFocused ? aboutHeading : this.languageFocused ? 0 : catalogHeading;
			this.scrollToSection = false;
			this.ensureFocusVisible = true;
		} else if (this.pageAnchor) {
			const row = this.focusRows.get(this.pageAnchor.key);
			if (row !== undefined) this.scrollOffset = row - this.pageAnchor.offset;
		}
		this.pageAnchor = undefined;
		if (this.ensureFocusVisible || !this.manualScroll) {
			const end = Math.max(selectedRow + 1, selectedEnd);
			if (selectedRow < this.scrollOffset) this.scrollOffset = selectedRow;
			if (end > this.scrollOffset + viewportRows) this.scrollOffset = Math.max(selectedRow, end - viewportRows);
			this.ensureFocusVisible = false;
		}
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maximumOffset));
		if (
			expandedRange &&
			expandedRange.start >= this.scrollOffset &&
			expandedRange.end <= this.scrollOffset + viewportRows
		)
			this.expandedCapacity = expandedRange.capacity;
		const visible = lines.slice(this.scrollOffset, this.scrollOffset + viewportRows);
		if (!overflowing) return visible;
		const end = Math.min(contentRows, this.scrollOffset + viewportRows);
		return [
			...visible,
			line(this.styles.apply("palette.hint", this.scrollIndicator(this.scrollOffset, end, contentRows, innerWidth))),
		];
	}

	/** One-row position indicator for a document taller than the viewport. */
	private scrollIndicator(start: number, end: number, total: number, innerWidth: number): string {
		const above = start;
		const below = total - end;
		const parts: string[] = [];
		if (above > 0) parts.push(`↑ ${above}`);
		parts.push(`${start + 1}-${end}/${total}`);
		if (below > 0) parts.push(`↓ ${below}`);
		return fitTerminalText(`  ${parts.join(" · ")}`, innerWidth);
	}

	/** Use the same row cap as the Palette overlay and its outer margins. */
	private heightBudget(): number {
		return paletteHeightBudget(Number(this.tui.terminal?.rows ?? 24));
	}

	/** Page complete messages rather than discard failure details or recovery instructions. */
	private fitMessage(messageLines: string[], maxLines: number, width: number): string[] {
		this.messageCapacity = 0;
		if (messageLines.length <= maxLines) {
			this.messageOffset = 0;
			return messageLines;
		}
		this.messageCapacity = Math.max(1, maxLines - 1);
		this.messageOffset = Math.min(this.messageOffset, Math.max(0, messageLines.length - this.messageCapacity));
		const end = Math.min(messageLines.length, this.messageOffset + this.messageCapacity);
		return [
			...messageLines.slice(this.messageOffset, end),
			this.pagingHintText(this.messageOffset, end, messageLines.length, width),
		];
	}

	render(width: number): string[] {
		const title = `${this.wordmark} ${this.theme.bold(this.styles.apply("palette.title", catalogText(this.catalog, CatalogMessageId.paletteTabSettings)))}`;
		if (width < 12 || this.heightBudget() < 4) return [fitTerminalText(title, Math.max(1, width))];
		const border = (value: string) => this.styles.apply("palette.border", value);
		const frameOptions = { border };
		const line = (value = "") => renderTerminalFrameRow(value, width, frameOptions);
		const innerWidth = paletteInnerWidth(width);
		const head = [renderTerminalFrameTitle(title, width, frameOptions)];
		if (
			!this.form &&
			!this.confirmRemove &&
			!this.confirmLogout &&
			!this.languageConfirm &&
			!this.languageResetConfirm
		) {
			head.push(line(renderPaletteTabs("settings", this.theme, this.styles, this.catalog)));
			head.push(renderPaletteDivider(width, this.styles));
		}
		const baseTail = [
			...renderPaletteKeyBar(
				this.hints(),
				innerWidth,
				this.theme,
				this.styles,
				Math.max(1, this.heightBudget() - head.length - 3),
			).map(line),
			renderTerminalFrameBorder(width, { ...frameOptions, left: "╰", right: "╯" }),
		];
		const budget = this.heightBudget();
		// Keep complete messages available through paging. On short terminals,
		// non-focused form rows yield before the message, warning, or controls.
		const message = this.message;
		const messageLines = message ? wrapTextWithAnsi(message.text, innerWidth) : [];
		const bodyMin = this.form
			? this.formRequired(width)
			: this.languageConfirm || this.languageResetConfirm
				? 3
				: this.languageFocused
					? 3
					: this.focusKey().startsWith("source:")
						? this.sourcesRequired(width)
						: 1;
		if (messageLines.length && head.length > 1 && budget - head.length - baseTail.length - 1 - bodyMin < 2)
			head.splice(1, 2);
		let messageRoom = Math.max(0, budget - head.length - baseTail.length - 1 - bodyMin);
		if (messageLines.length && messageRoom < 2 && this.form) {
			const minimum = this.formItems(width).filter((item) => item.rank === 0).length + 2;
			messageRoom = Math.max(0, budget - head.length - baseTail.length - 1 - minimum);
		}
		if (this.messageIdentity !== (message?.text ?? "")) this.messageOffset = 0;
		this.messageIdentity = message?.text ?? "";
		this.messageCapacity = 0;
		let shownMessage: string[] = [];
		if (message && messageLines.length > 0 && messageRoom >= 2) {
			const role =
				message.level === "error"
					? "palette.message.error"
					: message.level === "warning"
						? "palette.message.warning"
						: "palette.message.info";
			shownMessage = this.fitMessage(messageLines, messageRoom, innerWidth).map((messageLine, index, lines) =>
				this.styles.apply(this.messageCapacity > 0 && index === lines.length - 1 ? "palette.hint" : role, messageLine),
			);
		}
		const tail = [
			...(shownMessage.length > 0 ? [line(), ...shownMessage.map((messageLine) => line(messageLine))] : []),
			...baseTail,
		];
		if (budget < head.length + baseTail.length + 1 && head.length > 1) head.splice(1, 2);
		while (baseTail.length > 2 && budget < head.length + baseTail.length + 1) baseTail.splice(baseTail.length - 2, 1);
		if (budget < 4) return [head[0], ...baseTail].slice(0, budget).map((value) => fitTerminalText(value, width));
		const bodyBudget = Math.max(1, budget - head.length - tail.length);
		const body = this.form
			? this.renderForm(width, line, bodyBudget)
			: this.languageConfirm
				? this.renderLanguageConfirm(width, line, bodyBudget)
				: this.languageResetConfirm
					? this.renderLanguageResetConfirm(width, line, bodyBudget)
					: this.renderSettings(width, line, bodyBudget);
		return [...head, ...body, ...tail].map((value) => fitTerminalText(value, width));
	}

	invalidate(): void {
		this.form?.label.invalidate();
		this.form?.url.invalidate();
		this.form?.credential.invalidate();
		this.form?.token.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribeAuth();
		this.controller?.abort();
		this.controller = undefined;
	}
}
