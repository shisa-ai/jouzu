import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, Input, matchesKey, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
	setCatalogSourceToken,
	validateCatalogSourceToken,
} from "./catalog-sources.js";
import { formatEffectiveKeybinding, formatEffectiveKeyPair } from "./keybinding-hints.js";
import {
	formatContextClamp,
	loadContextPolicy,
	stepContextClamp,
	writeContextPolicy,
} from "./context-clamp.js";
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
	paletteInnerWidth,
	renderPaletteDivider,
	renderPaletteField,
	renderPaletteHeading,
	renderPaletteKeyBar,
	renderPaletteTabs,
} from "./palette.js";
import type { JouzuPaths } from "./paths.js";
import { detectBannerColorMode, renderBrandGradient } from "./presentation.js";
import type { SessionUiStyleRole, SessionUiStyles } from "./session-ui/index.js";
import {
	fitTerminalText,
	renderTerminalFrameBorder,
	renderTerminalFrameRow,
	renderTerminalFrameTitle,
	sanitizeTerminalText,
	terminalTextWidth,
} from "./terminal-layout.js";

interface CatalogSettingsOptions {
	context: PaletteComponentContext;
	paths: JouzuPaths;
	env?: NodeJS.ProcessEnv;
	discover?: (input: string, options: CatalogEndpointDiscoveryOptions) => Promise<CatalogEndpointDiscoveryResult>;
	refresh?: (
		paths: JouzuPaths,
		source: CatalogSource,
		options?: RefreshCatalogOptions,
	) => Promise<CatalogRefreshResult>;
	onCatalogsChanged?: () => void;
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

function countLabel(count: number): string {
	return `${count} model${count === 1 ? "" : "s"}`;
}

function warnHint(styles: SessionUiStyles, value: string, width: number, line: (value?: string) => string): string[] {
	return wrapTextWithAnsi(value, width).map((warningLine) =>
		line(styles.apply("palette.message.warning", warningLine)),
	);
}

function sourceStatusText(view: SourceView): string {
	const status = view.status;
	if (status.configured && status.conflict) return "reserved-id conflict";
	if (!view.source.enabled) return "disabled";
	if (status.configured && status.credentialName && status.credentialAvailable === false) {
		return `${status.credentialName} not set`;
	}
	return status.status;
}

/** Colour the status column so a broken source is visible without reading it. */
function sourceStatusRole(view: SourceView): SessionUiStyleRole {
	const status = view.status;
	if (status.configured && status.conflict) return "palette.message.error";
	if (!view.source.enabled) return "palette.status.off";
	if (status.configured && status.credentialName && status.credentialAvailable === false)
		return "palette.status.attention";
	if (status.status === "active") return "palette.status.ready";
	if (status.status === "stale") return "palette.status.attention";
	return "palette.status.off";
}

const SOURCE_LABEL_COLUMN = 22;
const FORM_LABEL_COLUMN = 14;
/** Body rows the global context ceiling row spends: one, and it yields before the selected source. */
const CONTEXT_SECTION_ROWS = 1;

/** Plain-text token warning for a source URL, prefixed for list rendering. */
function transportWarningText(url: string): string | undefined {
	const warning = catalogInsecureTransportWarning(url);
	return warning ? `  Warning: ${warning}` : undefined;
}

/** Plain-text warning for a bearer source with no usable token. */
function credentialWarningText(status: CatalogSyncStatus): string | undefined {
	if (!status.configured || !status.credentialName || status.credentialAvailable) return undefined;
	return `  Warning: token variable ${status.credentialName} is not set and no token is saved for this source. Set it or save a token, then refresh.`;
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
	private readonly close: () => void;
	private readonly paths: JouzuPaths;
	private readonly env: NodeJS.ProcessEnv;
	private readonly store: CatalogSourceStore;
	private readonly discover: CatalogSettingsOptions["discover"];
	private readonly refreshSource: NonNullable<CatalogSettingsOptions["refresh"]>;
	private readonly onCatalogsChanged?: () => void;
	private readonly wordmark: string;
	private views: SourceView[] = [];
	private selectedIndex = 0;
	private contextFocused = false;
	/** Whether the last render kept the context ceiling row; a dropped row cannot take focus. */
	private contextRowVisible = true;
	private maxContextTokens?: number;
	private contextPolicyError?: string;
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
		this.tui = options.context.tui;
		this.theme = options.context.theme;
		this.keybindings = options.context.keybindings;
		this.styles = options.context.styles;
		this.close = options.context.close;
		this.paths = options.paths;
		this.env = options.env ?? process.env;
		this.store = new CatalogSourceStore(this.paths, { env: this.env });
		this.discover = options.discover ?? discoverCatalogEndpoint;
		this.refreshSource = options.refresh ?? refreshCatalogSource;
		this.onCatalogsChanged = options.onCatalogsChanged;
		this.wordmark = renderBrandGradient("JOUZU", detectBannerColorMode());
		this.reloadViews();
		this.reloadContextPolicy();
		if (this.views.length === 0 && !this.message) this.startForm("add");
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.syncInputFocus();
	}

	route(route: PaletteRoute): void {
		if (route.view !== "settings") return;
		this.reloadViews();
		this.tui.requestRender();
	}

	allowsGlobalNavigation(): boolean {
		return !this.form && !this.confirmRemove && !this.busy;
	}

	private selected(): SourceView | undefined {
		return this.views[this.selectedIndex];
	}

	private reloadViews(preferredId?: string): void {
		try {
			const sources = this.store.list();
			this.views = sources.map((source) => {
				const document = loadActiveCatalogForSource(this.paths, source);
				return {
					source,
					status: getCatalogSourceStatus(this.paths, source, new Date(), this.env),
					offerings: (document?.modelOfferings ?? []).map((offering) => ({
						providerId: sanitizeTerminalText(offering.providerId),
						modelId: sanitizeTerminalText(offering.modelId),
						name: sanitizeTerminalText(offering.name ?? offering.modelId),
					})),
				};
			});
			const retainedId = preferredId ?? this.selected()?.source.id;
			const retainedIndex = retainedId ? this.views.findIndex((view) => view.source.id === retainedId) : -1;
			this.selectedIndex =
				retainedIndex >= 0 ? retainedIndex : Math.min(this.selectedIndex, Math.max(0, this.views.length - 1));
		} catch (error) {
			this.views = [];
			this.message = {
				level: "error",
				text: `Catalog settings could not be loaded: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
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
		this.contextFocused = false;
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
				text: `Saved tokens could not be read: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
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
		this.message = { level: "info", text: "Saving catalog…" };
		this.controller?.abort();
		const controller = new AbortController();
		this.controller = controller;
		this.tui.requestRender();
		try {
			let discovered: CatalogEndpointDiscoveryResult | undefined;
			if (!skipDiscovery) {
				discovered = await this.discover?.(inputUrl, {
					auth,
					env: this.env,
					signal: controller.signal,
					...(effectiveToken ? { bearerToken: effectiveToken } : {}),
				});
				if (!discovered) throw new Error("catalog endpoint discovery returned no result");
				if (this.disposed || controller.signal.aborted) return;
			}
			let refreshed: CatalogRefreshResult | undefined;
			const activate = (source: CatalogSource) => {
				if (!discovered) return;
				refreshed = activateDiscoveredCatalog(this.paths, source, discovered, this.env);
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
					`token variable ${sanitizeTerminalText(credentialName)} is not set and no token is saved; set it or save a token, then press R to refresh`,
				);
			if (enteredToken && envToken)
				notes.push(
					`${sanitizeTerminalText(credentialName)} is set in this Jouzu process and takes precedence over the saved token`,
				);
			const base =
				refreshed?.status === "quarantined"
					? `Saved ${sanitizeTerminalText(source.label)}. Catalog revision quarantined: ${refreshed.reasons.join(", ")}.`
					: `Saved ${sanitizeTerminalText(source.label)}${discovered ? ` with ${countLabel(count)}` : " without checking the catalog"}.`;
			this.message =
				notes.length > 0 ? { level: "warning", text: `${base} ${notes.join(". ")}.` } : { level: "info", text: base };
			this.onCatalogsChanged?.();
		} catch (error) {
			if (this.disposed || controller.signal.aborted) return;
			this.message = {
				level: "error",
				text: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
			};
		} finally {
			if (this.controller === controller) this.controller = undefined;
			if (controller.signal.aborted && !this.disposed) this.message = { level: "info", text: "Catalog save canceled." };
			this.busy = false;
			this.tui.requestRender();
		}
	}

	private async refreshSelected(): Promise<void> {
		const view = this.selected();
		if (!view || this.busy || !view.source.enabled) return;
		this.busy = true;
		this.message = { level: "info", text: `Refreshing ${sanitizeTerminalText(view.source.label)}…` };
		this.tui.requestRender();
		try {
			const result = await this.refreshSource(this.paths, view.source, { env: this.env });
			if (this.disposed) return;
			if (result.status === "error" || result.status === "rejected") throw new Error(result.message);
			this.reloadViews(view.source.id);
			this.message = {
				level: "info",
				text: result.status === "not-modified" ? "Catalog is up to date." : `Catalog ${result.status}.`,
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
	}

	private reloadContextPolicy(): void {
		const policy = loadContextPolicy(this.paths);
		this.maxContextTokens = policy.maxContextTokens;
		this.contextPolicyError = policy.error;
		if (policy.error && !this.message) {
			this.message = {
				level: "warning",
				text: `Context limit was not applied: ${sanitizeTerminalText(policy.error)}. Models use their declared windows.`,
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
				text: `Context limit was not saved: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
			};
			this.tui.requestRender();
			return;
		}
		this.maxContextTokens = next;
		this.contextPolicyError = undefined;
		this.message = {
			level: "info",
			text:
				next === undefined
					? "Context limit off. Models use their declared windows."
					: `Context limit ${formatContextClamp(next)} tokens. Models above it report ${formatContextClamp(next)} and compact sooner.`,
		};
		this.onCatalogsChanged?.();
		this.tui.requestRender();
	}

	private moveSelection(delta: number): void {
		this.contextFocused = false;
		this.selectedIndex = Math.max(0, Math.min(this.views.length - 1, this.selectedIndex + delta));
		this.expandedOffset = 0;
		this.confirmRemove = false;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.message && this.message.text === this.messageIdentity && this.messageCapacity > 0) {
			const previous = this.keybindings.matches(data, "tui.select.pageUp");
			const next = this.keybindings.matches(data, "tui.select.pageDown");
			if (previous || next) {
				this.messageOffset = Math.max(0, this.messageOffset + (next ? 1 : -1) * this.messageCapacity);
				this.tui.requestRender();
				return;
			}
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
			} else {
				this.close();
			}
			return;
		}
		if (this.busy) return;
		if (this.confirmRemove) {
			if (this.keybindings.matches(data, "tui.select.confirm")) {
				const source = this.selected()?.source;
				if (source) {
					this.store.remove(source.id);
					this.expandedSourceId = undefined;
					this.reloadViews();
					this.message = { level: "info", text: `Removed ${sanitizeTerminalText(source.label)}.` };
					this.onCatalogsChanged?.();
				}
				this.confirmRemove = false;
				this.tui.requestRender();
			}
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			if (this.contextFocused) return;
			if (this.selectedIndex === 0 && this.views.length > 0 && this.contextRowVisible) {
				this.contextFocused = true;
				this.tui.requestRender();
				return;
			}
			this.moveSelection(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			if (this.contextFocused) {
				this.contextFocused = false;
				this.tui.requestRender();
				return;
			}
			this.moveSelection(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp") && this.expandedSourceId) {
			// Page by the capacity the last render actually granted so windows stay
			// contiguous: no offering row is unreachable when the page is smaller
			// than the default eight.
			this.expandedOffset = Math.max(0, this.expandedOffset - this.expandedCapacity);
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown") && this.expandedSourceId) {
			this.expandedOffset += this.expandedCapacity;
			this.tui.requestRender();
			return;
		}
		if (this.contextFocused && (matchesKey(data, "left") || matchesKey(data, "right"))) {
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
					text: `${sanitizeTerminalText(source.label)} is a built-in Jouzu catalog source. Space enables or disables it; its endpoint and credential reference stay managed.`,
				};
				this.tui.requestRender();
				return;
			}
			this.startForm("edit");
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
		if (data === "d" && this.selected()) {
			const selected = this.selected()?.source;
			if (selected && this.store.isCodeOwned(selected)) {
				this.message = {
					level: "info",
					text: `${sanitizeTerminalText(selected.label)} is built in and cannot be removed. Space disables it.`,
				};
				this.tui.requestRender();
				return;
			}
			this.confirmRemove = true;
			this.message = {
				level: "error",
				text: `Press ${formatEffectiveKeybinding(this.keybindings, "tui.select.confirm")} to remove this catalog source; ${formatEffectiveKeybinding(this.keybindings, "tui.select.cancel")} cancels.`,
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
				text: `${sanitizeTerminalText(updated.label)} ${updated.enabled ? "enabled" : "disabled"}.`,
			};
			this.onCatalogsChanged?.();
			this.tui.requestRender();
		}
	}

	/**
	 * Form rows ranked by what yields first when the terminal is too short for
	 * the whole form: guidance hints (4), the credential-availability note (3),
	 * the heading (2), then non-focused field rows (1). Rank 0 — the full
	 * transport warning and the focused field — never drops. On a terminal too
	 * short even for the rank-0 rows the render exceeds the budget rather than
	 * hide mandatory content; the overlay then clips its bottom edge.
	 */
	private renderForm(width: number, line: (value?: string) => string, budget: number): string[] {
		const items = this.formItems(width);
		while (items.length > budget) {
			let dropIndex = -1;
			let dropRank = 0;
			for (let index = 0; index < items.length; index += 1) {
				if (items[index].rank > dropRank) {
					dropRank = items[index].rank;
					dropIndex = index;
				}
			}
			if (dropIndex < 0) break;
			items.splice(dropIndex, 1);
		}
		return items.map((item) => line(item.text));
	}

	/** Body rows the form can never shed: every field plus the transport warning. */
	private formRequired(width: number): number {
		const form = this.form;
		if (!form) return 0;
		const innerWidth = paletteInnerWidth(width);
		const fields = form.authType === "bearer" ? 5 : 3;
		const transportWarning = transportWarningText(form.url.getValue().trim());
		const warningLines = transportWarning ? wrapTextWithAnsi(transportWarning, innerWidth).length : 0;
		return fields + warningLines;
	}

	private formItems(width: number): Array<{ rank: number; text: string }> {
		const form = this.form;
		if (!form) return [];
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
			form.mode === "add" ? "Add catalog" : `Edit ${sanitizeTerminalText(editedSource?.label ?? "catalog")}`;
		const items: Array<{ rank: number; text: string }> = [
			{ rank: 2, text: renderPaletteHeading(heading, innerWidth, this.theme, this.styles) },
			{ rank: form.field === "label" ? 0 : 1, text: field("label", "Label", form.label.render(inputWidth)[0] ?? "") },
			{ rank: form.field === "url" ? 0 : 1, text: field("url", "URL or host", form.url.render(inputWidth)[0] ?? "") },
		];
		const transportWarning = transportWarningText(form.url.getValue().trim());
		if (transportWarning) {
			for (const warningLine of wrapTextWithAnsi(transportWarning, innerWidth)) {
				items.push({ rank: 0, text: this.styles.apply("palette.message.warning", warningLine) });
			}
		}
		items.push({
			rank: form.field === "auth" ? 0 : 1,
			text: field("auth", "Authentication", paletteChoice(form.authType === "none" ? "None" : "Bearer token")),
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
				text: field("credential", "Token variable", form.credential.render(inputWidth)[0] ?? ""),
			});
			for (const hintLine of wrapTextWithAnsi(
				`${" ".repeat(FORM_LABEL_COLUMN + 2)}Enter the variable name, not the token. The environment value is never saved.`,
				innerWidth,
			)) {
				items.push({ rank: 4, text: this.styles.apply("palette.hint", hintLine) });
			}
			if (credentialName) {
				const availability = credentialAvailable
					? "set"
					: savedToken
						? "not set; the saved token will be used"
						: "not set";
				for (const hintLine of wrapTextWithAnsi(
					`${" ".repeat(FORM_LABEL_COLUMN + 2)}${sanitizeTerminalText(credentialName)} is ${availability} in this Jouzu process.`,
					innerWidth,
				)) {
					items.push({ rank: 3, text: this.styles.apply("palette.hint", hintLine) });
				}
			}
			items.push({
				rank: form.field === "token" ? 0 : 1,
				text: field("token", "Token", maskRenderedInput(form.token.render(inputWidth)[0] ?? "")),
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
		const confirm = formatEffectiveKeybinding(this.keybindings, "tui.select.confirm");
		const cancel = formatEffectiveKeybinding(this.keybindings, "tui.select.cancel");
		const move = formatEffectiveKeyPair(this.keybindings, "tui.select.up", "tui.select.down");
		if (this.form)
			return [
				{ key: confirm, label: "save" },
				{ key: move, label: "field" },
				{ key: "←→", label: "change Authentication" },
				{ key: cancel, label: "cancel" },
			];
		if (this.confirmRemove)
			return [
				{ key: confirm, label: "remove" },
				{ key: cancel, label: "cancel" },
			];
		if (this.contextFocused)
			return [
				{ key: "←→", label: "context limit" },
				{ key: "Tab", label: "section" },
				{ key: move, label: "move" },
				{ key: cancel, label: "close" },
			];
		return [
			{ key: confirm, label: "edit" },
			{ key: "A", label: "add" },
			{ key: "R", label: "refresh" },
			{ key: "D", label: "remove" },
			{ key: "Space", label: "enable" },
			{ key: "←→", label: "models" },
			{ key: "Tab", label: "section" },
			{ key: move, label: "move" },
			{ key: cancel, label: "close" },
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
				? ` · ${status.credentialName} ${
						status.credentialEnv ? "set" : status.credentialStored ? "not set, saved token in use" : "not set"
					}`
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
		const transportWarning = transportWarningText(view.source.url);
		if (transportWarning) warning.push(...warnHint(this.styles, transportWarning, innerWidth, line));
		const credentialWarning = credentialWarningText(status);
		if (credentialWarning) warning.push(...warnHint(this.styles, credentialWarning, innerWidth, line));
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
		const warnings = [transportWarningText(selected.source.url), credentialWarningText(selected.status)];
		const warningLines = warnings.reduce(
			(total, warning) => total + (warning ? wrapTextWithAnsi(warning, innerWidth).length : 0),
			0,
		);
		return 1 + warningLines;
	}

	/** The global ceiling row, rendered above the catalog list and dropped when the list needs its room. */
	private contextRow(innerWidth: number, line: (value?: string) => string): string {
		return line(
			renderPaletteField({
				label: "Maximum context",
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

	/**
	 * Sources list bounded to the body budget. Drop order, always whole groups:
	 * the conflict note, the URL detail line, the context ceiling row, then the
	 * list heading. The selected row and its full transport warning stay; if even
	 * those exceed the budget the render overflows rather than hide mandatory
	 * rows, and the overlay clips its bottom edge. Other source rows and expanded
	 * model pages spend only the rows that remain.
	 */
	private renderSources(
		width: number,
		line: (value?: string) => string,
		budget: number,
		reclaimTabs: () => number,
	): string[] {
		this.expandedCapacity = 0;
		const innerWidth = paletteInnerWidth(width);
		const lines: string[] = [];
		const contextRow = this.contextRow(innerWidth, line);
		let contextRows = CONTEXT_SECTION_ROWS;
		const active = this.views.filter((view) => view.source.enabled && view.status.status === "active").length;
		const headingText = line(
			renderPaletteHeading(
				"Model Catalogs",
				innerWidth,
				this.theme,
				this.styles,
				`${active}/${this.views.length} active`,
			),
		);
		if (this.views.length === 0) {
			lines.push(contextRow, headingText);
			lines.push(line(this.styles.apply("palette.empty", "  No catalog sources configured.")));
			return lines;
		}
		const selected = this.views[this.selectedIndex];
		const extras = this.selectedDetailGroups(selected, innerWidth, line);
		const selectedExpanded = this.expandedSourceId === selected.source.id;
		// A source left expanded while the selection moved keeps its block; its
		// row and one trailer line are reserved up front so its paging hint or
		// empty-catalog note cannot push the frame past the budget.
		const stickyIndex = this.expandedSourceId
			? this.views.findIndex((view) => view.source.id === this.expandedSourceId)
			: -1;
		const sticky = stickyIndex >= 0 && stickyIndex !== this.selectedIndex;
		// Pool = rows left after the heading, the selected row, its details, and
		// one reserved trailer line per expanded block. Whole extras groups drop,
		// never mid-warning, until the pool clears.
		let pool =
			budget -
			contextRows -
			1 -
			1 -
			(extras.detail.length + extras.warning.length + extras.conflict.length) -
			(selectedExpanded ? 1 : 0) -
			(sticky ? 1 : 0);
		let headingKept = true;
		const dropOrShrink = (): void => {
			if (extras.conflict.length > 0) {
				pool += extras.conflict.length;
				extras.conflict = [];
			} else if (extras.detail.length > 0) {
				pool += extras.detail.length;
				extras.detail = [];
			} else if (contextRows > 0) {
				pool += contextRows;
				contextRows = 0;
			} else if (headingKept) {
				pool += 1;
				headingKept = false;
			}
		};
		while (
			pool < 0 &&
			(extras.conflict.length > 0 || extras.detail.length > 0 || contextRows > 0 || headingKept)
		)
			dropOrShrink();
		// An expanded selection keeps its first offering and paging trailer
		// ahead of optional source rows. When even that does not fit, the tab row
		// and divider yield first so the expansion stays reachable.
		const offeringReserve = selectedExpanded ? Math.min(selected.offerings.length, 1) : 0;
		if (pool - offeringReserve < 0) pool += reclaimTabs();
		if (pool < 0) {
			// Mandatory rows alone exceed the budget; overflow honestly.
			pool = 0;
		}
		const others = this.views.length - 1;
		let visibleOthers = others;
		let pageSize = 0;
		let stickyPageSize = 0;
		if (pool - offeringReserve >= others) {
			visibleOthers = others;
			const pagePool = pool - others - offeringReserve;
			pageSize = selectedExpanded ? Math.max(0, Math.min(selected.offerings.length, pagePool + offeringReserve)) : 0;
			stickyPageSize = sticky
				? Math.max(0, Math.min(this.views[stickyIndex].offerings.length, pagePool + offeringReserve - pageSize))
				: 0;
		} else {
			// Window the source rows; the reserved offering row keeps at least one
			// entry of the selected expansion visible ahead of further sources.
			visibleOthers = Math.max(0, pool - offeringReserve);
			pageSize = selectedExpanded ? Math.max(0, Math.min(selected.offerings.length, pool - visibleOthers)) : 0;
		}
		const windowSize = visibleOthers + 1;
		let start =
			windowSize >= this.views.length
				? 0
				: Math.max(0, Math.min(this.selectedIndex - Math.floor((windowSize - 1) / 2), this.views.length - windowSize));
		if (sticky && windowSize < this.views.length) {
			// Shift the window just enough to keep the sticky expanded source in
			// view alongside the selection; when the window cannot span both, the
			// sticky block yields (its reserved rows go unused).
			const lo = Math.max(0, Math.max(this.selectedIndex, stickyIndex) - (windowSize - 1));
			const hi = Math.min(this.views.length - windowSize, Math.min(this.selectedIndex, stickyIndex));
			if (lo <= hi) start = hi;
		}
		const end = start + windowSize;
		for (let index = start; index < end; index += 1) {
			const view = this.views[index];
			const isSelected = index === this.selectedIndex;
			const expanded = this.expandedSourceId === view.source.id;
			const count = view.status.configured
				? (view.status.offeringCount ?? view.offerings.length)
				: view.offerings.length;
			lines.push(
				line(
					renderPaletteField({
						label: `${expanded ? "▾" : "▸"} ${fitTerminalText(sanitizeTerminalText(view.source.label), SOURCE_LABEL_COLUMN - 2)}`,
						labelRole: "palette.identity",
						value: this.styles.apply(sourceStatusRole(view), sourceStatusText(view)),
						meta: countLabel(count),
						labelWidth: SOURCE_LABEL_COLUMN,
						innerWidth,
						selected: isSelected,
						theme: this.theme,
						styles: this.styles,
					}),
				),
			);
			if (isSelected) {
				lines.push(...extras.detail, ...extras.warning, ...extras.conflict);
			}
			if (!expanded) continue;
			const capacity = isSelected ? pageSize : stickyPageSize;
			this.expandedCapacity = capacity;
			const maximumOffset = Math.max(0, view.offerings.length - capacity);
			this.expandedOffset = Math.min(this.expandedOffset, maximumOffset);
			for (const offering of view.offerings.slice(this.expandedOffset, this.expandedOffset + capacity)) {
				lines.push(
					line(
						renderPaletteField({
							label: `    ${offering.providerId}/${offering.modelId}`,
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
			if (view.offerings.length === 0)
				lines.push(line(this.styles.apply("palette.empty", "    No cached model offerings.")));
			else if (capacity > 0 && view.offerings.length > capacity)
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
		}
		const prefix: string[] = [];
		if (contextRows > 0) prefix.push(contextRow);
		this.contextRowVisible = contextRows > 0;
		if (!this.contextRowVisible) this.contextFocused = false;
		if (headingKept) prefix.push(headingText);
		lines.unshift(...prefix);
		return lines;
	}

	/**
	 * Lines the floating overlay can show for this view. The palette opens with
	 * `maxHeight: "82%"` and a margin of 1, and the overlay clips a taller
	 * render from the bottom, so the render targets the same budget. Below the
	 * floating floor (fewer than 16 rows) the palette renders in place, where
	 * this budget is conservative but never harmful.
	 */
	private heightBudget(): number {
		const rows = Number(this.tui.terminal?.rows ?? 24);
		return Math.max(5, Math.min(Math.floor(rows * 0.82), Math.max(1, rows - 2)));
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
		const title = `${this.wordmark} ${this.theme.bold(this.styles.apply("palette.title", "· Settings / Catalogs"))}`;
		if (width < 12) return [fitTerminalText(title, Math.max(1, width))];
		const border = (value: string) => this.styles.apply("palette.border", value);
		const frameOptions = { border };
		const line = (value = "") => renderTerminalFrameRow(value, width, frameOptions);
		const innerWidth = paletteInnerWidth(width);
		const head = [renderTerminalFrameTitle(title, width, frameOptions)];
		if (!this.form && !this.confirmRemove) {
			head.push(line(renderPaletteTabs("settings", this.theme, this.styles)));
			head.push(renderPaletteDivider(width, this.styles));
		}
		const baseTail = [
			...renderPaletteKeyBar(this.hints(), innerWidth, this.theme, this.styles).map(line),
			renderTerminalFrameBorder(width, { ...frameOptions, left: "╰", right: "╯" }),
		];
		const budget = this.heightBudget();
		// Keep complete messages available through paging. On short terminals,
		// non-focused form rows yield before the message, warning, or controls.
		const message = this.message;
		const messageLines = message ? wrapTextWithAnsi(message.text, innerWidth) : [];
		const bodyMin = this.form ? this.formRequired(width) : this.sourcesRequired(width);
		if (messageLines.length && head.length > 1 && budget - head.length - baseTail.length - 1 - bodyMin < 2)
			head.splice(1);
		let messageRoom = Math.max(0, budget - head.length - baseTail.length - 1 - bodyMin);
		if (messageLines.length && messageRoom < 2 && this.form) {
			const minimum = this.formItems(width).filter((item) => item.rank === 0).length;
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
		const bodyBudget = Math.max(1, budget - head.length - tail.length);
		// renderSources may reclaim the tab row and divider when an expanded
		// selection would otherwise have no reachable offerings; the returned
		// rows join its pool so the total stays inside the budget.
		let tabsReclaimed = false;
		const reclaimTabs = (): number => {
			if (tabsReclaimed || head.length <= 1) return 0;
			head.splice(1, 2);
			tabsReclaimed = true;
			return 2;
		};
		const body = this.form
			? this.renderForm(width, line, bodyBudget)
			: this.renderSources(width, line, bodyBudget, reclaimTabs);
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
		this.controller?.abort();
		this.controller = undefined;
	}
}
