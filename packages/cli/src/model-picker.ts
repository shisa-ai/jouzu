import { AsyncLocalStorage } from "node:async_hooks";
import type {
	CreateAgentSessionOptions,
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { type Focusable, getKeybindings, Input, matchesKey, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type HeldCatalogUpdate, heldCatalogUpdates, reviewHeldCatalogUpdates } from "./catalog-held.js";
import { CatalogSettingsComponent, type CatalogSettingsOptions } from "./catalog-settings.js";
import { catalogSourceCredentialAvailable } from "./catalog-sources.js";
import { CatalogMessageId, catalogText, defaultCatalog } from "./cli-messages.js";
import { activeContextClamp, clampContextWindow } from "./context-clamp.js";
import { protectedModelId, protectedPath } from "./human-messages.js";
import {
	createJouzuKeybindingsManager,
	formatEffectiveJouzuKeybinding,
	type JouzuKeybindingsManager,
	matchesJouzuKeybinding,
} from "./jouzu-keybindings.js";
import { formatEffectiveKeybinding, formatEffectiveKeyPair } from "./keybinding-hints.js";
import { createLabelPolicy } from "./label-policy.js";
import type { LanguageContractInput } from "./language-contract.js";
import type { CatalogBundle } from "./locale-catalog.js";
import { createLocalizationActivityTracker } from "./localization-deferral.js";
import type { CatalogModelOffering, ModelCatalogDocument } from "./model-catalog.js";
import { catalogDefaultCandidates } from "./model-catalog-default.js";
import {
	CatalogProjectionController,
	catalogGatewayBase,
	catalogRuntimeIdentity,
	resolveCatalogModel,
} from "./model-catalog-projection.js";
import {
	type ActiveModelCatalog,
	type CatalogRefreshAllResult,
	loadActiveModelCatalogs,
	refreshAvailableModelCatalogs,
} from "./model-catalog-sync.js";
import {
	buildPickerRows,
	displayFields,
	modelContextFit,
	type PickerModel,
	type PickerRow,
} from "./model-picker-ranking.js";
import {
	deriveProjectKey,
	emptyModelPickerState,
	MODEL_PICKER_HISTORY_LIMIT,
	type ModelPickerState,
	ModelPickerStore,
	type ModelPickerThinkingLevel,
	type ModelReference,
	modelReferenceKey,
	modelReferencesEqual,
	preferredModelThinkingLevel,
	previousModelStack,
	projectDefaultAppliesAtStartup,
} from "./model-picker-state.js";
import { wrapModelSelectionIngress } from "./model-selection-ingress.js";
import { hasExplicitStartupThinking, startupThinkingArgument } from "./model-thinking-startup.js";
import {
	compactNumber,
	JouzuPaletteRouter,
	JouzuPaletteSurfaceHost,
	type PaletteComponent,
	type PaletteComponentContext,
	type PaletteKeyHint,
	type PaletteRoute,
	type PaletteSurfaceOptions,
	paletteHeightBudget,
	paletteInnerWidth,
	paletteScrollbarMarker,
	paletteViewport,
	renderPaletteDivider,
	renderPaletteField,
	renderPaletteKeyBar,
	renderPaletteScrollbarRow,
	renderPaletteTabs,
} from "./palette.js";
import type { JouzuPaths } from "./paths.js";
import { renderBrandWordmark } from "./presentation.js";
import type { RuntimeDiagnostics } from "./runtime-diagnostics.js";
import type { SessionUiStyles } from "./session-ui/index.js";
import { onShisaAuthChange } from "./shisa-link/credentials.js";
import { createWorkflowIntegration, type WorkflowService } from "./subagents/integration.js";
import { isActiveRun } from "./subagents/manager.js";
import {
	fitTerminalText,
	padTerminalText,
	renderTerminalFrameBorder,
	renderTerminalFrameRow,
	renderTerminalFrameTitle,
	sanitizeTerminalText,
	terminalTextWidth,
} from "./terminal-layout.js";
import type { TextGuardMode } from "./textguard-policy.js";
import { WorkflowComponent } from "./workflow.js";

type PiModel = NonNullable<ExtensionContext["model"]>;

export interface JouzuModelPickerRequest {
	source: "action" | "command";
	initialSearchInput?: string;
}

export interface JouzuModelPickerOptions {
	dashboardVisibility?: (visible: boolean) => void;
	onDashboardChanged?: () => void;
	runtime?: RuntimeDiagnostics;
	textguardFiles?: boolean;
	/** Reads the live TextGuard mode when a child agent launches. */
	textguardMode?: () => TextGuardMode;
	profile?: () => "core" | "ja";
	applyProjectDefaultAtStartup?: boolean;
	restoreLastModelAtStartup?: boolean;
	/** Use catalog priorities only for a new session without any saved model choice. */
	applyCatalogDefaultAtStartup?: boolean;
	restoreLastThinkingLevelAtStartup?: boolean;
	startupArgs?: readonly string[];
	palette?: PaletteSurfaceOptions;
	/** Test seam for the catalog refresh performed by /reload. */
	catalogFetch?: typeof globalThis.fetch;
	/** Client version the Settings account row reports when it signs in to Shisa. */
	jouzuVersion?: string;
	/** The `--jouzu-ui-locale` value, so the Settings Language view reports the `cli` source. */
	uiLocaleCli?: string;
	/** Stage successfully saved response/artifact choices for the next turn. */
	onLanguageChanged?: (language: LanguageContractInput) => void;
	/** Refresh the shared display catalog after a confirmed UI preference is saved. */
	onUiLocaleChanged?: CatalogSettingsOptions["onUiLocaleChanged"];
	/** The resolved catalog a Palette view renders its human text from. */
	catalog?: CatalogBundle;
}

export interface ModelPickerComponentOptions {
	context: PaletteComponentContext;
	initialRoute: PaletteRoute;
	getRows(query: string): PickerRow[];
	onSelect(row: PickerRow): Promise<void>;
	onCompactAndSelect(row: PickerRow): Promise<void>;
	onToggleFavorite(row: PickerRow): void;
	onRefresh?(signal: AbortSignal): Promise<void>;
	onRefreshCatalogs?(signal: AbortSignal): Promise<void>;
	/** Subscribe to catalog reloads; returns the unsubscribe function. */
	subscribeCatalogsReloaded?(listener: () => void): () => void;
}

/** Selection arrow, current/previous status, favorite, project default, and a gap. */
const ROW_MARKER_COLUMNS = 6;
const CONTEXT_COLUMN = 7;
const COLUMN_GAP = 2;
const MIN_NAME_COLUMN = 16;
const MAX_PROVIDER_COLUMN = 24;
// Keep rating glyphs text-only: emoji presentation selectors can change terminal cell widths.
const COMPARISON_SYMBOLS = { strength: "★", speed: "↯", cost: "$" } as const;

interface ModelColumns {
	name: number;
	/** Zero when the terminal is too narrow for the column. */
	provider: number;
	context: number;
	strength: number;
	speed: number;
	cost: number;
}

function modelDisplay(model: PickerModel): NonNullable<PickerModel["display"]> {
	return model.display ?? displayFields(model);
}

/** Hide comparison columns together, then Context and Provider, to keep the name readable. */
function modelColumns(
	providerWidth: number,
	innerWidth: number,
	contextWidth = CONTEXT_COLUMN,
	comparisonWidths: { strength: number; speed: number; cost: number },
): ModelColumns {
	const available = Math.max(1, innerWidth - ROW_MARKER_COLUMNS);
	const provider = Math.min(MAX_PROVIDER_COLUMN, providerWidth);
	const { strength, speed, cost } = comparisonWidths;
	const comparisonSpace = strength + speed + cost + 3 * COLUMN_GAP;
	if (innerWidth >= 80 && available - provider - contextWidth - 2 * COLUMN_GAP - comparisonSpace >= MIN_NAME_COLUMN) {
		return {
			name: available - provider - contextWidth - 2 * COLUMN_GAP - comparisonSpace,
			provider,
			context: contextWidth,
			strength,
			speed,
			cost,
		};
	}
	const comparison = { strength: 0, speed: 0, cost: 0 };
	if (available - provider - contextWidth - 2 * COLUMN_GAP >= MIN_NAME_COLUMN) {
		return {
			name: available - provider - contextWidth - 2 * COLUMN_GAP,
			provider,
			context: contextWidth,
			...comparison,
		};
	}
	if (available - provider - COLUMN_GAP >= MIN_NAME_COLUMN) {
		return { name: available - provider - COLUMN_GAP, provider, context: 0, ...comparison };
	}
	return { name: available, provider: 0, context: 0, ...comparison };
}

function contextLabel(contextWindow: number | undefined): string {
	return contextWindow ? compactNumber(contextWindow) : "—";
}

function comparisonLabel(value: number | undefined, symbol: string): string {
	return Number.isInteger(value) && value !== undefined && value >= 1 && value <= 4 ? symbol.repeat(value) : "—";
}

export function compactContextForModelSwitch(
	ctx: Pick<ExtensionContext, "compact" | "getContextUsage">,
	target: PickerModel,
): Promise<void> {
	if (modelContextFit(target, ctx.getContextUsage()?.tokens) !== "too-small") return Promise.resolve();
	const display = modelDisplay(target);
	return new Promise((resolve, reject) => {
		try {
			ctx.compact({
				// Bundled pi-vcc treats keep:0 as an explicit request to compile the
				// complete active transcript into the brief before a smaller-model switch.
				customInstructions: "keep:0",
				onComplete: (result) => {
					const activeTokens = ctx.getContextUsage()?.tokens ?? result.estimatedTokensAfter;
					if (modelContextFit(target, activeTokens) === "too-small") {
						reject(
							new Error(
								`Compaction completed, but the active context still does not fit ${display.provider}/${display.modelId}. Choose a larger-context model.`,
							),
						);
						return;
					}
					resolve();
				},
				onError: (error) => reject(new Error(`Compaction failed: ${error.message}`)),
			});
		} catch (error) {
			reject(new Error(`Compaction failed: ${error instanceof Error ? error.message : String(error)}`));
		}
	});
}

export class ModelPickerComponent implements PaletteComponent, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly jouzuKeybindings: JouzuKeybindingsManager;
	private readonly styles: SessionUiStyles;
	private readonly catalog: CatalogBundle;
	private readonly wordmark: string;
	private readonly close: () => void;
	private readonly getRows: (query: string) => PickerRow[];
	private readonly onSelect: (row: PickerRow) => Promise<void>;
	private readonly onCompactAndSelect: (row: PickerRow) => Promise<void>;
	private readonly onToggleFavorite: (row: PickerRow) => void;
	private readonly searchInput = new Input();
	private rows: PickerRow[] = [];
	/** Provider/model pairs published by more than one catalog; their Provider cell names the catalog. */
	private sharedIdentities = new Set<string>();
	private searchFocused = false;
	private totalCount = 0;
	private selectedIndex = 0;
	private rowsVisible = 8;
	private messageScroll = 0;
	private messageScrollMax = 0;
	private messageRowsVisible = 1;
	private renderedMessage = "";
	/** Query the current rows were ranked for; editing it moves the cursor. */
	private appliedQuery = "";
	/** Cursor position before the current search began; clearing the search returns to it. */
	private preSearchSelection?: { key?: string; index: number };
	private busy = false;
	private compactConfirmation?: { modelKey: string };
	private message?: { level: "error" | "info"; text: string };
	private readonly onRefreshCatalogs?: (signal: AbortSignal) => Promise<void>;
	private unsubscribeCatalogsReloaded?: () => void;
	private refreshController?: AbortController;
	private disposed = false;
	private _focused = false;

	constructor(options: ModelPickerComponentOptions) {
		this.tui = options.context.tui;
		this.theme = options.context.theme;
		this.keybindings = options.context.keybindings;
		this.jouzuKeybindings = options.context.jouzuKeybindings;
		this.styles = options.context.styles;
		// A caller without a resolved catalog (a unit test, for example) renders
		// English rather than a second copy of the text.
		this.catalog = options.context.catalog ?? defaultCatalog();
		// The gradient wordmark varies per character, so it is rendered once here
		// rather than resolved through a single-color role on every frame.
		this.wordmark = renderBrandWordmark(this.theme);
		this.close = options.context.close;
		this.getRows = options.getRows;
		this.onSelect = options.onSelect;
		this.onCompactAndSelect = options.onCompactAndSelect;
		this.onToggleFavorite = options.onToggleFavorite;
		this.onRefreshCatalogs = options.onRefreshCatalogs;
		this.searchInput.setValue(options.initialRoute.query ?? "");
		// A resumed route restores the query without taking over the cursor.
		this.searchFocused = Boolean(options.initialRoute.query) && options.initialRoute.resume !== true;
		this.recomputeTotal();
		this.recomputeRows();
		// A catalog reload that lands while this view is open (startup background
		// refresh, /reload) updates the registry synchronously; recompute so the
		// open view shows the new models without requiring a reopen.
		this.unsubscribeCatalogsReloaded = options.subscribeCatalogsReloaded?.(() => {
			if (this.disposed) return;
			this.recomputeTotal();
			this.recomputeRows();
			this.tui.requestRender();
		});
		if (options.onRefresh) void this.refresh(options.onRefresh);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.syncSearchFocus();
	}

	private syncSearchFocus(): void {
		this.searchInput.focused = this._focused && this.searchFocused;
	}

	route(route: PaletteRoute): void {
		if (route.view !== "models") return;
		if (route.query !== undefined) {
			this.searchInput.setValue(route.query);
			this.searchFocused = Boolean(route.query);
			this.syncSearchFocus();
		}
		this.recomputeTotal();
		this.recomputeRows();
		this.tui.requestRender();
	}

	snapshotRoute(): PaletteRoute {
		const query = this.searchInput.getValue();
		return query ? { view: "models", query } : { view: "models" };
	}

	allowsGlobalNavigation(): boolean {
		return !this.busy && !this.compactConfirmation;
	}

	/**
	 * The total describes the unfiltered inventory, so it changes only when
	 * picker state does. Recomputing it per keystroke would add a full ranking
	 * pass for a result that cannot have changed.
	 */
	private recomputeTotal(): void {
		const rows = this.getRows("");
		this.totalCount = rows.length;
		const seen = new Set<string>();
		this.sharedIdentities = new Set();
		for (const row of rows) {
			const identity = `${row.model.provider}\0${row.model.modelId}`;
			if (seen.has(identity)) this.sharedIdentities.add(identity);
			seen.add(identity);
		}
	}

	/**
	 * A reload keeps the cursor on the same model. Editing the query moves it to
	 * the first matching row, and clearing the query returns it to where it was before
	 * the search began, so a long list does not leave the user mid-inventory.
	 */
	private recomputeRows(): void {
		const query = this.searchInput.getValue();
		const current = this.rows[this.selectedIndex];
		let anchor: { key?: string; index: number } = {
			key: current ? modelReferenceKey(current.model) : undefined,
			index: this.selectedIndex,
		};
		if (query !== this.appliedQuery) {
			if (!query) {
				anchor = this.preSearchSelection ?? { index: 0 };
				this.preSearchSelection = undefined;
			} else {
				if (!this.appliedQuery) this.preSearchSelection = anchor;
				anchor = { index: 0 };
			}
			this.appliedQuery = query;
		}
		this.rows = this.getRows(query);
		const retainedIndex = anchor.key ? this.rows.findIndex((row) => modelReferenceKey(row.model) === anchor.key) : -1;
		this.selectedIndex = retainedIndex >= 0 ? retainedIndex : Math.min(anchor.index, Math.max(0, this.rows.length - 1));
	}

	private leaveSearchField(): void {
		this.searchFocused = false;
		this.message = undefined;
		this.syncSearchFocus();
		this.tui.requestRender();
	}

	private clearSearch(): void {
		this.searchInput.setValue("");
		this.searchFocused = false;
		this.message = undefined;
		this.syncSearchFocus();
		this.recomputeRows();
		this.tui.requestRender();
	}

	private async refresh(onRefresh: (signal: AbortSignal) => Promise<void>): Promise<void> {
		await this.runRefresh(onRefresh, {
			timeoutText: catalogText(this.catalog, CatalogMessageId.modelPickerRefreshTimeout),
			failureText: (detail) => catalogText(this.catalog, CatalogMessageId.modelPickerRefreshFailed, { detail }),
		});
	}

	private async refreshCatalogs(): Promise<void> {
		if (!this.onRefreshCatalogs) return;
		this.message = { level: "info", text: catalogText(this.catalog, CatalogMessageId.modelPickerRefreshingCatalog) };
		this.tui.requestRender();
		await this.runRefresh((signal) => this.onRefreshCatalogs?.(signal) ?? Promise.resolve(), {
			successText: catalogText(this.catalog, CatalogMessageId.modelPickerCatalogRefreshed),
			timeoutText: catalogText(this.catalog, CatalogMessageId.modelPickerCatalogRefreshTimeout),
			failureText: (detail) => catalogText(this.catalog, CatalogMessageId.modelPickerCatalogRefreshFailed, { detail }),
		});
	}

	private async runRefresh(
		operation: (signal: AbortSignal) => Promise<void>,
		messages: {
			successText?: string;
			timeoutText: string;
			failureText: (detail: string) => string;
		},
	): Promise<void> {
		this.refreshController?.abort();
		const controller = new AbortController();
		this.refreshController = controller;
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, 15_000);
		try {
			await operation(controller.signal);
			if (this.disposed || controller.signal.aborted) return;
			this.recomputeTotal();
			this.recomputeRows();
			if (messages.successText) this.message = { level: "info", text: messages.successText };
			this.tui.requestRender();
		} catch (error) {
			if (this.disposed || (controller.signal.aborted && !timedOut)) return;
			this.message = {
				level: "error",
				text: timedOut
					? messages.timeoutText
					: messages.failureText(sanitizeTerminalText(error instanceof Error ? error.message : String(error))),
			};
			this.tui.requestRender();
		} finally {
			clearTimeout(timeout);
			if (this.refreshController === controller) this.refreshController = undefined;
		}
	}

	private moveSelection(delta: number): void {
		if (this.rows.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.rows.length - 1, this.selectedIndex + delta));
		this.compactConfirmation = undefined;
		this.message = undefined;
		this.tui.requestRender();
	}

	private executeSelection(row: PickerRow, compactFirst: boolean): void {
		this.compactConfirmation = undefined;
		this.busy = true;
		const display = modelDisplay(row.model);
		const model = protectedModelId(`${display.provider}/${display.modelId}`);
		this.message = {
			level: "info",
			text: compactFirst
				? catalogText(this.catalog, CatalogMessageId.modelPickerCompacting, { model })
				: catalogText(this.catalog, CatalogMessageId.modelPickerSelecting, { model }),
		};
		this.tui.requestRender();
		const selection = compactFirst ? this.onCompactAndSelect(row) : this.onSelect(row);
		void selection
			.then(() => {
				if (this.disposed) return;
				this.close();
			})
			.catch((error) => {
				if (this.disposed) return;
				this.busy = false;
				this.message = {
					level: "error",
					text: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
				};
				this.tui.requestRender();
			});
	}

	private runSelection(): void {
		const row = this.rows[this.selectedIndex];
		if (!row || this.busy) return;
		if (!row.model.available) {
			this.message = {
				level: "error",
				text: catalogText(this.catalog, CatalogMessageId.modelPickerModelUnavailable),
			};
			this.tui.requestRender();
			return;
		}
		if (row.contextFit === "too-small") {
			const display = modelDisplay(row.model);
			this.compactConfirmation = { modelKey: modelReferenceKey(row.model) };
			this.message = {
				level: "info",
				text: catalogText(this.catalog, CatalogMessageId.modelPickerCompactAndSwitch, {
					model: protectedModelId(`${display.provider}/${display.modelId}`),
				}),
			};
			this.tui.requestRender();
			return;
		}
		this.executeSelection(row, false);
	}

	private confirmCompaction(): void {
		const confirmation = this.compactConfirmation;
		const row = this.rows[this.selectedIndex];
		if (!confirmation || !row || modelReferenceKey(row.model) !== confirmation.modelKey) {
			this.compactConfirmation = undefined;
			this.message = undefined;
			this.tui.requestRender();
			return;
		}
		this.executeSelection(row, true);
	}

	private toggleFavorite(): void {
		const row = this.rows[this.selectedIndex];
		if (!row || this.busy) return;
		const display = modelDisplay(row.model);
		const adding = !row.favorite;
		try {
			this.onToggleFavorite(row);
			const model = protectedModelId(`${display.provider}/${display.modelId}`);
			this.message = {
				level: "info",
				text: adding
					? catalogText(this.catalog, CatalogMessageId.modelPickerFavoriteAdded, { model })
					: catalogText(this.catalog, CatalogMessageId.modelPickerFavoriteRemoved, { model }),
			};
			this.recomputeTotal();
			this.recomputeRows();
			this.tui.requestRender();
		} catch (error) {
			this.message = {
				level: "error",
				text: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
			};
			this.tui.requestRender();
		}
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.busy) {
				// Model activation does not support cancellation; closing leaves the
				// operation running and its completion handler is dispose-guarded.
				this.dispose();
				this.close();
				return;
			}
			if (this.compactConfirmation) {
				this.compactConfirmation = undefined;
				this.message = undefined;
				this.tui.requestRender();
			} else if (this.searchInput.getValue()) {
				// Product decision: the first Esc in a non-empty search clears it, from the
				// search field or the results, and returns the cursor to its pre-search
				// position. Printable row actions reach a searched row through ↑/↓ instead.
				// Do not change this order without maintainer approval; see docs/models.md.
				this.clearSearch();
			} else if (this.searchFocused) {
				this.leaveSearchField();
			} else {
				this.close();
			}
			return;
		}
		// Page keys scroll an overflowing message before navigating model rows.
		// This also keeps confirmation and in-flight errors readable without activation.
		if (this.message && this.messageScrollMax > 0) {
			const delta = this.keybindings.matches(data, "tui.select.pageUp")
				? -this.messageRowsVisible
				: this.keybindings.matches(data, "tui.select.pageDown")
					? this.messageRowsVisible
					: matchesKey(data, "ctrl+home")
						? -Number.MAX_SAFE_INTEGER
						: matchesKey(data, "ctrl+end")
							? Number.MAX_SAFE_INTEGER
							: 0;
			if (delta) {
				this.messageScroll = Math.max(0, Math.min(this.messageScrollMax, this.messageScroll + delta));
				this.tui.requestRender();
				return;
			}
		}
		if (this.busy) return;
		if (this.compactConfirmation) {
			if (this.keybindings.matches(data, "tui.select.confirm")) this.confirmCompaction();
			return;
		}
		const step = this.keybindings.matches(data, "tui.select.up")
			? -1
			: this.keybindings.matches(data, "tui.select.down")
				? 1
				: this.keybindings.matches(data, "tui.select.pageUp")
					? -this.rowsVisible
					: this.keybindings.matches(data, "tui.select.pageDown")
						? this.rowsVisible
						: 0;
		if (step) {
			// Moving through results leaves the search field with the query kept, so
			// printable row actions apply to the filtered selection.
			if (this.searchFocused) this.leaveSearchField();
			this.moveSelection(step);
			return;
		}
		if (matchesKey(data, "ctrl+home")) {
			if (this.searchFocused) this.leaveSearchField();
			this.moveSelection(-Number.MAX_SAFE_INTEGER);
			return;
		}
		if (matchesKey(data, "ctrl+end")) {
			if (this.searchFocused) this.leaveSearchField();
			this.moveSelection(Number.MAX_SAFE_INTEGER);
			return;
		}
		if (!this.searchFocused && matchesKey(data, "home")) {
			this.moveSelection(-Number.MAX_SAFE_INTEGER);
			return;
		}
		if (!this.searchFocused && matchesKey(data, "end")) {
			this.moveSelection(Number.MAX_SAFE_INTEGER);
			return;
		}
		if (!this.searchFocused && matchesKey(data, "/")) {
			this.searchFocused = true;
			this.message = undefined;
			this.syncSearchFocus();
			this.tui.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.runSelection();
			return;
		}
		if (
			matchesJouzuKeybinding(this.jouzuKeybindings, data, "jouzu.model.toggleFavorite", {
				textFieldLive: this.searchFocused,
			})
		) {
			this.toggleFavorite();
			return;
		}
		if (
			matchesJouzuKeybinding(this.jouzuKeybindings, data, "jouzu.model.refresh", {
				textFieldLive: this.searchFocused,
			})
		) {
			void this.refreshCatalogs();
			return;
		}
		const previousQuery = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		const queryChanged = this.searchInput.getValue() !== previousQuery;
		if (queryChanged && !this.searchFocused) {
			this.searchFocused = true;
			this.syncSearchFocus();
		}
		if (queryChanged) this.recomputeRows();
		if (queryChanged || this.searchFocused) {
			this.message = undefined;
			this.tui.requestRender();
		}
	}

	private providerCell(row: PickerRow): string {
		const display = modelDisplay(row.model);
		const shared = this.sharedIdentities.has(`${row.model.provider}\0${row.model.modelId}`);
		return shared && row.model.catalogLabel
			? `${display.providerName} · ${sanitizeTerminalText(row.model.catalogLabel)}`
			: display.providerName;
	}

	private headerText(columns: ModelColumns): string {
		const cells = [padTerminalText(catalogText(this.catalog, "jouzu.cli.modelPicker.columnName"), columns.name)];
		if (columns.provider)
			cells.push(padTerminalText(catalogText(this.catalog, "jouzu.cli.modelPicker.columnProvider"), columns.provider));
		if (columns.context)
			cells.push(
				padTerminalText(catalogText(this.catalog, "jouzu.cli.modelPicker.columnContext"), columns.context, {
					alignment: "right",
				}),
			);
		for (const [key, id] of [
			["strength", "jouzu.cli.modelPicker.columnStrength"],
			["speed", "jouzu.cli.modelPicker.columnSpeed"],
			["cost", "jouzu.cli.modelPicker.columnCost"],
		] as const) {
			if (columns[key]) cells.push(padTerminalText(catalogText(this.catalog, id), columns[key]));
		}
		return this.styles.apply("palette.section", `${" ".repeat(ROW_MARKER_COLUMNS)}${cells.join("  ")}`);
	}

	private rowText(row: PickerRow, selected: boolean, columns: ModelColumns): string {
		const marker = selected ? this.styles.apply("palette.marker", "→") : " ";
		const status =
			row.section === "current"
				? this.styles.apply("palette.section.current", "●")
				: row.section === "previous"
					? this.styles.apply("palette.section", "↺")
					: " ";
		const favorite = row.favorite ? this.styles.apply("palette.favorite", "★") : " ";
		const projectDefault = row.projectDefault ? this.styles.apply("palette.default", "◆") : " ";
		const display = modelDisplay(row.model);
		const flag = !row.model.available
			? catalogText(this.catalog, CatalogMessageId.modelPickerRowUnavailable).trim()
			: row.contextFit === "too-small"
				? catalogText(this.catalog, CatalogMessageId.modelPickerRowContextSmall).trim()
				: "";
		const flagText = flag
			? ` ${this.styles.apply(row.model.available ? "palette.context.small" : "palette.unavailable", flag)}`
			: "";
		const nameWidth = Math.max(1, columns.name - (flag ? terminalTextWidth(flag) + 1 : 0));
		const name = this.styles.apply(
			selected ? "palette.identity.selected" : "palette.identity",
			fitTerminalText(display.name, nameWidth, "…"),
		);
		const cells = [padTerminalText(`${name}${flagText}`, columns.name)];
		if (columns.provider) {
			cells.push(
				this.styles.apply(
					"palette.detail",
					padTerminalText(this.providerCell(row), columns.provider, { indicator: "…" }),
				),
			);
		}
		if (columns.context) {
			cells.push(
				this.styles.apply(
					"palette.detail",
					padTerminalText(contextLabel(row.model.contextWindow), columns.context, { alignment: "right" }),
				),
			);
		}
		for (const key of ["strength", "speed", "cost"] as const) {
			if (columns[key]) {
				const value = comparisonLabel(row.model.comparison?.[key], COMPARISON_SYMBOLS[key]);
				cells.push(this.styles.apply("palette.detail", padTerminalText(value, columns[key])));
			}
		}
		const text = `${marker} ${status}${favorite}${projectDefault} ${cells.join("  ")}`;
		return selected ? this.theme.bg("selectedBg", text) : text;
	}

	render(width: number): string[] {
		const mode = this.compactConfirmation
			? ` · ${catalogText(this.catalog, CatalogMessageId.modelPickerTitleConfirm)}`
			: this.searchFocused
				? ` · ${catalogText(this.catalog, CatalogMessageId.modelPickerTitleSearch)}`
				: "";
		const viewTitle = catalogText(this.catalog, CatalogMessageId.paletteViewTitle, {
			view: catalogText(this.catalog, CatalogMessageId.paletteTabModels),
			stage: mode,
		});
		const title = `${this.wordmark} ${this.theme.bold(this.styles.apply("palette.title", viewTitle))} ${this.styles.apply("palette.count", `${this.rows.length}/${this.totalCount}`)}`;
		const height = paletteHeightBudget(Number(this.tui.terminal?.rows ?? 24));
		if (width < 12 || height < 6) return [fitTerminalText(title, Math.max(1, width))];
		const innerWidth = paletteInnerWidth(width);
		const selected = this.rows[this.selectedIndex];
		const border = (value: string) => this.styles.apply("palette.border", value);
		const frameOptions = { border };
		const line = (value = "") => renderTerminalFrameRow(value, width, frameOptions);
		const control = (label: string, value: string, focused: boolean, meta?: string) =>
			line(
				renderPaletteField({
					label,
					value,
					...(meta ? { meta } : {}),
					labelWidth: CONTROL_LABEL_COLUMN,
					innerWidth,
					selected: focused,
					theme: this.theme,
					styles: this.styles,
				}),
			);
		let detailLine: string;
		if (selected) {
			const display = modelDisplay(selected.model);
			const defaultLabel = selected.projectDefault
				? ` · ${catalogText(this.catalog, CatalogMessageId.modelPickerProjectDefault)}`
				: "";
			const source = selected.model.catalogLabel ? ` · ${sanitizeTerminalText(selected.model.catalogLabel)}` : "";
			const identity = this.styles.apply("palette.detail", `${display.provider}/${display.modelId}`);
			const detail = ` ${catalogText(this.catalog, CatalogMessageId.modelPickerDetail, {
				name: `${identity}${source}`,
				context: compactNumber(selected.model.contextWindow, this.catalog),
				max: compactNumber(selected.model.maxTokens, this.catalog),
				default: defaultLabel,
			})}`;
			detailLine = line(this.theme.bg("selectedBg", padTerminalText(fitTerminalText(detail, innerWidth), innerWidth)));
		} else {
			detailLine = line(
				this.theme.bg(
					"selectedBg",
					padTerminalText(` ${catalogText(this.catalog, "jouzu.cli.modelPicker.noSelection")}`, innerWidth),
				),
			);
		}
		const columns = modelColumns(
			Math.max(
				terminalTextWidth(catalogText(this.catalog, "jouzu.cli.modelPicker.columnProvider")),
				...this.rows.map((row) => terminalTextWidth(this.providerCell(row))),
			),
			innerWidth,
			Math.max(CONTEXT_COLUMN, terminalTextWidth(catalogText(this.catalog, "jouzu.cli.modelPicker.columnContext"))),
			{
				strength: Math.max(
					terminalTextWidth(COMPARISON_SYMBOLS.strength.repeat(4)),
					terminalTextWidth(catalogText(this.catalog, "jouzu.cli.modelPicker.columnStrength")),
				),
				speed: Math.max(
					terminalTextWidth(COMPARISON_SYMBOLS.speed.repeat(4)),
					terminalTextWidth(catalogText(this.catalog, "jouzu.cli.modelPicker.columnSpeed")),
				),
				cost: Math.max(
					terminalTextWidth(COMPARISON_SYMBOLS.cost.repeat(4)),
					terminalTextWidth(catalogText(this.catalog, "jouzu.cli.modelPicker.columnCost")),
				),
			},
		);
		const listHeaderLine =
			this.rows.length === 0
				? line(this.styles.apply("palette.empty", catalogText(this.catalog, CatalogMessageId.modelPickerEmpty)))
				: line(this.headerText(columns));
		const price = selected?.model.price;
		const rateLabels = {
			input: "jouzu.cli.modelPicker.priceInput",
			output: "jouzu.cli.modelPicker.priceOutput",
			cacheRead: "jouzu.cli.modelPicker.priceCacheRead",
			cacheWrite: "jouzu.cli.modelPicker.priceCacheWrite",
		} as const;
		const rates = price
			? (Object.keys(rateLabels) as Array<keyof typeof rateLabels>).flatMap((key) => {
					const value = price[key];
					return typeof value === "number" && Number.isFinite(value) && value >= 0
						? [catalogText(this.catalog, rateLabels[key], { rate: String(value) })]
						: [];
				})
			: [];
		const priceLines = rates.length
			? wrapTextWithAnsi(
					catalogText(this.catalog, "jouzu.cli.modelPicker.prices", { rates: rates.join(" · ") }),
					Math.max(1, innerWidth - 1),
				).map((text) => line(this.theme.bg("selectedBg", padTerminalText(` ${text}`, innerWidth))))
			: [];
		const headParts: Array<{ key: string; line: string }> = [
			{ key: "title", line: renderTerminalFrameTitle(title, width, frameOptions) },
			{ key: "tabs", line: line(renderPaletteTabs("models", this.theme, this.styles, this.catalog)) },
			{ key: "divider", line: renderPaletteDivider(width, this.styles) },
			{
				key: "search",
				line: control(
					catalogText(this.catalog, "jouzu.cli.modelPicker.searchLabel"),
					this.searchInput.render(Math.max(1, innerWidth - CONTROL_LABEL_COLUMN - 3))[0] ?? "",
					this.searchFocused,
				),
			},
			{ key: "detail", line: detailLine },
			...priceLines.map((line, index) => ({ key: `price-${index}`, line })),
			{ key: "blank", line: line() },
			{ key: "columns", line: listHeaderLine },
		];
		const confirm = formatEffectiveKeybinding(this.keybindings, "tui.select.confirm");
		const cancel = formatEffectiveKeybinding(this.keybindings, "tui.select.cancel");
		const move = formatEffectiveKeyPair(this.keybindings, "tui.select.up", "tui.select.down");
		// Key-bar action labels are catalog text; the key itself is a resolved binding.
		const action = (id: CatalogMessageId): string => catalogText(this.catalog, id);
		const favoriteNow = formatEffectiveJouzuKeybinding(this.jouzuKeybindings, "jouzu.model.toggleFavorite", {
			textFieldLive: this.searchFocused,
		});
		const favoriteAll = formatEffectiveJouzuKeybinding(this.jouzuKeybindings, "jouzu.model.toggleFavorite");
		const refreshKey = formatEffectiveJouzuKeybinding(this.jouzuKeybindings, "jouzu.model.refresh");
		const refreshHints: PaletteKeyHint[] =
			refreshKey === "Unbound" ? [] : [{ key: refreshKey, label: action(CatalogMessageId.paletteActionRefresh) }];
		const hasQuery = Boolean(this.searchInput.getValue());
		// Moving into results preserves the query before invoking a printable favorite binding.
		const favoriteHints: PaletteKeyHint[] =
			this.searchFocused && favoriteNow === "Unbound"
				? favoriteAll !== "Unbound"
					? [
							{
								key: catalogText(this.catalog, "jouzu.cli.modelPicker.keyThen", { first: move, second: favoriteAll }),
								label: action(CatalogMessageId.paletteActionFavorite),
							},
						]
					: []
				: favoriteNow !== "Unbound"
					? [{ key: favoriteNow, label: action(CatalogMessageId.paletteActionFavorite) }]
					: [];
		const cancelHint: PaletteKeyHint = {
			key: cancel,
			label: hasQuery
				? catalogText(this.catalog, "jouzu.cli.modelPicker.clearSearch")
				: action(this.searchFocused ? CatalogMessageId.paletteActionBrowse : CatalogMessageId.paletteActionClose),
		};
		const hints: PaletteKeyHint[] = this.busy
			? [{ key: cancel, label: action(CatalogMessageId.paletteActionClose) }]
			: this.compactConfirmation
				? [
						{ key: confirm, label: action(CatalogMessageId.paletteActionCompactAndSwitch) },
						{ key: cancel, label: action(CatalogMessageId.paletteActionCancel) },
					]
				: this.searchFocused
					? [
							{ key: confirm, label: action(CatalogMessageId.paletteActionSelectAndSaveForProject) },
							...favoriteHints,
							...refreshHints,
							{ key: "←→", label: action(CatalogMessageId.paletteActionCursor) },
							{ key: move, label: action(CatalogMessageId.paletteActionMove) },
							{ key: "Tab", label: action(CatalogMessageId.paletteActionSection) },
							cancelHint,
						]
					: [
							{ key: confirm, label: action(CatalogMessageId.paletteActionSelectAndSaveForProject) },
							...favoriteHints,
							...refreshHints,
							{ key: "/", label: action(CatalogMessageId.paletteActionSearch) },
							{ key: move, label: action(CatalogMessageId.paletteActionMove) },
							{ key: "Tab", label: action(CatalogMessageId.paletteActionSection) },
							cancelHint,
						];
		const wrappedMessage = this.message ? wrapTextWithAnsi(this.message.text, innerWidth) : [];
		const messageReserve = Math.min(2, wrappedMessage.length);
		// Keep the title, tabs, search, one selected row, and the footer. Reserve
		// message rows before spending space on optional details or separators.
		const keyBar = renderPaletteKeyBar(
			hints,
			innerWidth,
			this.theme,
			this.styles,
			Math.max(1, height - 5 - messageReserve),
		);
		for (const key of [
			"blank",
			...priceLines.map((_, index) => `price-${index}`).reverse(),
			"detail",
			"divider",
			"columns",
			...(messageReserve > 0 ? ["search"] : []),
		]) {
			if (headParts.length + keyBar.length + 2 + messageReserve <= height) break;
			const index = headParts.findIndex((part) => part.key === key);
			if (index >= 0) headParts.splice(index, 1);
		}
		const lines = headParts.map((part) => part.line);
		const messageRoom = Math.max(0, height - lines.length - keyBar.length - 2);
		if (this.renderedMessage !== (this.message?.text ?? "")) this.messageScroll = 0;
		this.renderedMessage = this.message?.text ?? "";
		this.messageRowsVisible = Math.max(1, messageRoom);
		this.messageScrollMax = Math.max(0, wrappedMessage.length - messageRoom);
		this.messageScroll = Math.min(this.messageScroll, this.messageScrollMax);
		const messageLines = wrappedMessage.slice(this.messageScroll, this.messageScroll + messageRoom);
		const rowCapacity = Math.max(1, height - lines.length - keyBar.length - messageLines.length - 1);
		this.rowsVisible = rowCapacity;
		const viewport = paletteViewport(this.rows.length, this.selectedIndex, rowCapacity);
		const visibleRows = this.rows.slice(viewport.start, viewport.end);
		const hasScrollbar = this.rows.length > viewport.visible;
		for (let offset = 0; offset < rowCapacity; offset += 1) {
			const row = visibleRows[offset];
			if (!row) {
				lines.push(line());
				continue;
			}
			const value = this.rowText(row, viewport.start + offset === this.selectedIndex, columns);
			lines.push(
				hasScrollbar
					? renderPaletteScrollbarRow(
							value,
							width,
							this.styles,
							paletteScrollbarMarker(offset, viewport, this.rows.length),
						)
					: line(value),
			);
		}
		const messageRole = this.message?.level === "error" ? "palette.message.error" : "palette.message.info";
		const messageViewport = {
			start: this.messageScroll,
			end: this.messageScroll + messageLines.length,
			capacity: messageRoom,
			visible: messageLines.length,
			hasAbove: this.messageScroll > 0,
			hasBelow: this.messageScroll < this.messageScrollMax,
		};
		lines.push(
			...messageLines.map((text, index) =>
				this.messageScrollMax > 0
					? renderPaletteScrollbarRow(
							this.styles.apply(messageRole, text),
							width,
							this.styles,
							paletteScrollbarMarker(index, messageViewport, wrappedMessage.length),
						)
					: line(this.styles.apply(messageRole, text)),
			),
		);
		lines.push(...keyBar.map(line));
		lines.push(renderTerminalFrameBorder(width, { ...frameOptions, left: "╰", right: "╯" }));
		return lines.map((value) => fitTerminalText(value, width));
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.refreshController?.abort();
		this.refreshController = undefined;
		this.unsubscribeCatalogsReloaded?.();
		this.unsubscribeCatalogsReloaded = undefined;
	}
}

export type FavoriteCycleDirection = "forward" | "backward";

export interface JouzuModelPickerIntegration {
	wrapSessionIngress(
		delegate?: CreateAgentSessionOptions["flowIngress"],
	): NonNullable<CreateAgentSessionOptions["flowIngress"]>;
	workflowService: WorkflowService;
	workflowExtension: JouzuModelPickerIntegration["extension"];
	extension: InlineExtension;
	open(request: JouzuModelPickerRequest): Promise<boolean>;
	openSettings(): Promise<boolean>;
	cycleFavorite(direction: FavoriteCycleDirection): Promise<boolean>;
	handleScopedModelsCommand(): Promise<boolean>;
	/** Child runs this session has queued, starting, or running. */
	activeAgentCount(): number;
	/** Re-read activated catalog revisions after an external refresh. */
	reloadCatalogs(): Promise<void>;
	/** Ask the user about catalog revisions an external refresh held for review. */
	reviewHeldCatalogs(result: CatalogRefreshAllResult | undefined): void;
	/**
	 * After a Settings sign-in or sign-out, refresh authenticated catalogs, re-project
	 * them into providers, and refresh model availability without a restart.
	 */
	refreshShisaAccount(change: { signedIn: boolean; signal?: AbortSignal }): Promise<void>;
}

const CONTROL_LABEL_COLUMN = 8;

const catalogOfferingIndexes = new WeakMap<ModelCatalogDocument, Map<string, CatalogModelOffering>>();

function catalogOfferingKey(provider: string, modelId: string): string {
	return `${provider}\0${modelId}`;
}

function catalogOffering(
	catalog: ModelCatalogDocument | undefined,
	provider: string,
	modelId: string,
): CatalogModelOffering | undefined {
	if (!catalog) return undefined;
	let index = catalogOfferingIndexes.get(catalog);
	if (!index) {
		index = new Map();
		for (const offering of catalog.modelOfferings) {
			const key = catalogOfferingKey(offering.providerId, offering.modelId);
			if (!index.has(key)) index.set(key, offering);
		}
		// Loaded catalog documents are immutable snapshots. A refresh creates a
		// new document object, so the old index can be reclaimed with its snapshot.
		catalogOfferingIndexes.set(catalog, index);
	}
	return index.get(catalogOfferingKey(provider, modelId));
}

export function catalogModelReference(
	provider: string,
	modelId: string,
	catalog?: ModelCatalogDocument,
): ModelReference {
	const identity = catalogRuntimeIdentity(provider);
	if (identity) provider = identity.provider;
	const offering = catalogOffering(catalog, provider, modelId);
	return {
		...(offering && catalog ? { catalogId: catalog.catalogId, offeringId: offering.id } : {}),
		provider,
		modelId,
	};
}

export function catalogThinkingLevel(
	reference: ModelReference,
	catalogs: ActiveModelCatalog[],
): ModelPickerThinkingLevel | undefined {
	const matches = catalogs.flatMap(({ document }) => {
		if (reference.catalogId && document.catalogId !== reference.catalogId) return [];
		const offering = catalogOffering(document, reference.provider, reference.modelId);
		return offering && (!reference.offeringId || offering.id === reference.offeringId) ? [offering] : [];
	});
	const levels = new Set(matches.map((offering) => offering.defaultThinkingLevel));
	return levels.size === 1 ? matches[0]?.defaultThinkingLevel : undefined;
}

function hasConversationEntries(entries: readonly { type: string }[]): boolean {
	return entries.some((entry) => ["message", "compaction", "branch_summary", "custom_message"].includes(entry.type));
}

function catalogPrice(metadata: unknown): PickerModel["price"] {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
	const price = (metadata as Record<string, unknown>).price;
	if (!price || typeof price !== "object" || Array.isArray(price)) return undefined;
	const record = price as Record<string, unknown>;
	if (record.currency !== "USD" || record.unit !== "per_1m_tokens") return undefined;
	const rates: NonNullable<PickerModel["price"]> = {};
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) rates[key] = value;
	}
	return Object.keys(rates).length > 0 ? rates : undefined;
}

function catalogComparison(metadata: unknown): PickerModel["comparison"] {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
	const comparison: NonNullable<PickerModel["comparison"]> = {};
	for (const key of ["strength", "speed", "cost"] as const) {
		const value = (metadata as Record<string, unknown>)[key];
		if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4) comparison[key] = value;
	}
	return Object.keys(comparison).length > 0 ? comparison : undefined;
}

export function catalogPickerModel(
	model: Pick<PiModel, "provider" | "id" | "name" | "contextWindow" | "maxTokens">,
	catalog?: ModelCatalogDocument,
	catalogLabel?: string,
): PickerModel {
	const offering = catalogOffering(catalog, model.provider, model.id);
	const comparison = catalogComparison(offering?.metadata);
	const price = catalogPrice(offering?.metadata);
	const providerName = offering
		? catalog?.providers.find((provider) => provider.id === offering.providerId)?.name
		: undefined;
	return {
		...(offering && catalog ? { catalogId: catalog.catalogId, offeringId: offering.id } : {}),
		...(providerName ? { providerName: sanitizeTerminalText(providerName) } : {}),
		...(offering && catalogLabel ? { catalogLabel: sanitizeTerminalText(catalogLabel) } : {}),
		...(comparison ? { comparison } : {}),
		...(price ? { price } : {}),
		provider: model.provider,
		modelId: model.id,
		name: offering?.name ?? model.name,
		contextWindow: offering?.limits?.contextWindow ?? model.contextWindow,
		maxTokens: offering?.limits?.maxOutputTokens ?? model.maxTokens,
		available: offering?.availability?.status !== "unavailable",
	};
}

export function catalogPickerModels(
	model: Pick<PiModel, "provider" | "id" | "name" | "contextWindow" | "maxTokens">,
	catalogs: ActiveModelCatalog[],
): PickerModel[] {
	const identity = catalogRuntimeIdentity(model.provider);
	if (identity) {
		const active = catalogs.find(({ document }) => document.catalogId === identity.catalogId);
		return active
			? [catalogPickerModel({ ...model, provider: identity.provider }, active.document, active.source.label)]
			: [];
	}
	const matches = catalogs.filter(
		(active) => !catalogGatewayBase(active) && catalogOffering(active.document, model.provider, model.id),
	);
	return matches.length > 0
		? matches.map(({ source, document }) => catalogPickerModel(model, document, source.label))
		: [catalogPickerModel(model)];
}

export function pickerModels(
	ctx: ExtensionContext,
	catalogs: ActiveModelCatalog[],
	env: NodeJS.ProcessEnv = process.env,
	paths?: JouzuPaths,
): PickerModel[] {
	const available = ctx.modelRegistry.getAvailable();
	const availableKeys = new Set(available.map((model) => `${model.provider}\0${model.id}`));
	const gateways = catalogs.filter((active) => catalogGatewayBase(active));
	const collisions = new Set(
		gateways.flatMap(({ document }) =>
			document.modelOfferings.map((offering) => `${offering.providerId}\0${offering.modelId}`),
		),
	);
	const all = typeof ctx.modelRegistry.getAll === "function" ? ctx.modelRegistry.getAll() : available;
	const models = [
		...available.filter(
			(model) => !catalogRuntimeIdentity(model.provider) && !collisions.has(`${model.provider}\0${model.id}`),
		),
		...all.filter((model) => {
			const identity = catalogRuntimeIdentity(model.provider);
			return identity && gateways.some(({ document }) => document.catalogId === identity.catalogId);
		}),
	];
	const scope = ctx.scopedModels.map(({ model }) => ({
		...model,
		provider: catalogRuntimeIdentity(model.provider)?.provider ?? model.provider,
		catalogId: catalogRuntimeIdentity(model.provider)?.catalogId,
	}));
	const clamp = activeContextClamp(paths);
	return models.flatMap((model) => {
		const identity = catalogRuntimeIdentity(model.provider);
		if (
			scope.length > 0 &&
			!scope.some(
				(scoped) =>
					scoped.provider === (identity?.provider ?? model.provider) &&
					scoped.id === model.id &&
					(!scoped.catalogId || scoped.catalogId === identity?.catalogId),
			)
		)
			return [];
		return catalogPickerModels(model, catalogs).map((row) => ({
			...row,
			// The picker's context detail and fit check must show the window the
			// session actually compacts against, including for catalog offerings.
			contextWindow: clampContextWindow(row.contextWindow, clamp),
			available:
				row.available &&
				availableKeys.has(`${model.provider}\0${model.id}`) &&
				(!identity ||
					gateways.some(
						(active) =>
							active.document.catalogId === identity.catalogId &&
							catalogSourceCredentialAvailable(active.source, env, paths),
					)),
		}));
	});
}

export function createJouzuModelPicker(
	paths: JouzuPaths,
	options: JouzuModelPickerOptions = {},
): JouzuModelPickerIntegration {
	const store = new ModelPickerStore(paths);
	// The resolved catalog the extension's notifications and startup labels read.
	// A caller without one (a unit test, for example) renders English rather than
	// a second copy of the text.
	const messageCatalog = options.catalog ?? defaultCatalog();
	const workflow = createWorkflowIntegration(paths, undefined, {
		textguardFiles: options.textguardFiles,
		...(options.dashboardVisibility ? { dashboardVisibility: options.dashboardVisibility } : {}),
		profile: options.profile,
		...(options.textguardMode ? { textguardMode: options.textguardMode } : {}),
		...(options.catalog ? { catalog: options.catalog } : {}),
	});
	const jouzuKeybindings = createJouzuKeybindingsManager(paths);
	const surface = new JouzuPaletteSurfaceHost({
		jouzuKeybindings,
		...(options.catalog ? { catalog: options.catalog } : {}),
	});
	const catalogEnv = options.palette?.env ?? process.env;
	const catalogProjection = new CatalogProjectionController(catalogEnv, paths);
	let catalogs: ActiveModelCatalog[] = [];
	const modelReference = (model: PiModel | undefined, fallback?: ModelCatalogDocument): ModelReference | undefined => {
		if (!model) return undefined;
		const identity = catalogRuntimeIdentity(model.provider);
		const document = identity
			? catalogs.find(({ document }) => document.catalogId === identity.catalogId)?.document
			: catalogs.some((active) => active.document === fallback && catalogGatewayBase(active))
				? undefined
				: fallback;
		return catalogModelReference(model.provider, model.id, document);
	};
	const catalogReloadListeners = new Set<() => void>();
	let catalog: ModelCatalogDocument | undefined;
	let catalogWarning: string | undefined;
	let activeCtx: ExtensionContext | undefined;
	let reapplyCatalogProjection: (() => void) | undefined;
	try {
		catalogs = loadActiveModelCatalogs(paths, catalogEnv, messageCatalog);
		catalog = catalogs[0]?.document;
	} catch (error) {
		catalogWarning = catalogText(messageCatalog, CatalogMessageId.modelPickerCatalogIgnored, {
			message: error instanceof Error ? error.message : String(error),
		});
	}
	const reloadCatalogs = async (selectDefault = true, signal?: AbortSignal): Promise<void> => {
		signal?.throwIfAborted();
		try {
			catalogs = loadActiveModelCatalogs(paths, catalogEnv, messageCatalog);
			catalog = catalogs[0]?.document;
			catalogWarning = undefined;
		} catch (error) {
			catalogs = [];
			catalog = undefined;
			catalogWarning = catalogText(messageCatalog, CatalogMessageId.modelPickerCatalogIgnored, {
				message: error instanceof Error ? error.message : String(error),
			});
		}
		reapplyCatalogProjection?.();
		// The registry is updated synchronously above; open views recompute now.
		for (const listener of catalogReloadListeners) listener();
		if (selectDefault) await applyCatalogDefault(signal);
	};
	let pendingHeldUpdates: HeldCatalogUpdate[] = [];
	/**
	 * Open the held-update review without blocking the refresh that found it: a
	 * refresh runs under a timeout, and the decision waits on the user. Updates
	 * found before a session context exists wait for session start.
	 */
	const reviewHeld = (ctx: ExtensionContext | undefined, updates: HeldCatalogUpdate[]): void => {
		if (updates.length === 0) return;
		if (!ctx) {
			pendingHeldUpdates.push(...updates);
			return;
		}
		void reviewHeldCatalogUpdates(ctx, updates, { paths, env: catalogEnv, catalog: messageCatalog })
			.then((changed) => (changed ? reloadCatalogs() : undefined))
			.catch(() => {});
	};
	/**
	 * The Settings account row signs in through the same device flow as Pi's OAuth
	 * login, but Pi does not run its credential synchronization for that call. Fetch
	 * the now-authenticated catalogs, project them, and refresh availability so the
	 * newly available models work in this live session.
	 */
	const refreshShisaAccount = async (change: { signedIn: boolean; signal?: AbortSignal }): Promise<void> => {
		const { signal } = change;
		signal?.throwIfAborted();
		const ctx = activeCtx;
		let held: HeldCatalogUpdate[] = [];
		if (change.signedIn) {
			try {
				const refreshed = await refreshAvailableModelCatalogs(paths, {
					env: catalogEnv,
					fetch: options.catalogFetch,
					timeoutMs: 15_000,
					signal,
					catalog: messageCatalog,
				});
				signal?.throwIfAborted();
				held = heldCatalogUpdates(refreshed);
				const failed = (refreshed?.results ?? [])
					.filter(({ result }) => result.status === "error" || result.status === "rejected")
					.map(({ source }) => sanitizeTerminalText(source.label));
				if (failed.length > 0 && ctx)
					ctx.ui.notify(
						catalogText(messageCatalog, CatalogMessageId.modelPickerCatalogsNotRefreshed, {
							sources: failed.join(", "),
						}),
						"warning",
					);
			} catch (error) {
				signal?.throwIfAborted();
				if (ctx)
					ctx.ui.notify(
						catalogText(messageCatalog, CatalogMessageId.modelPickerCatalogsWereNotRefreshed, {
							message: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
						}),
						"warning",
					);
			}
		}
		await reloadCatalogs(true, signal);
		reviewHeld(ctx, held);
		if (!ctx) return;
		try {
			await ctx.modelRegistry.refresh({ allowNetwork: false, signal });
		} catch (error) {
			signal?.throwIfAborted();
			ctx.ui.notify(
				catalogText(messageCatalog, CatalogMessageId.modelPickerModelAvailabilityNotRefreshed, {
					message: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
				}),
				"warning",
			);
		}
	};
	let state: ModelPickerState = emptyModelPickerState();
	let projectKey = "";
	let previous: ModelReference[] = [];
	let pendingDispatch: ModelReference | undefined;
	let selectedReference: ModelReference | undefined;
	let restoringStartupModel = false;
	let catalogDefaultEligible = false;
	let catalogDefaultSettled = false;
	const catalogDefaultSelectionContext = new AsyncLocalStorage<{ active: boolean; signal?: AbortSignal }>();
	let catalogDefaultAttempt: Promise<void> | undefined;
	let applyingSavedThinking = false;
	let thinkingNotificationCount = 0;
	const pendingThinkingNotifications: {
		reference: ModelReference;
		level: ModelPickerThinkingLevel;
		previousLevel: ModelPickerThinkingLevel;
	}[] = [];
	let queuedModelSwitch: { model: PiModel; reference: PickerModel; setProjectDefault: boolean } | undefined;
	let stateWarningShown = false;
	let catalogWarningShown = false;
	let cycleBusy = false;
	let extensionApi: ExtensionAPI | undefined;
	let setModel: ((model: PiModel) => Promise<boolean>) | undefined;
	// Session activity a language change must respect. The tracker is fed by the
	// Pi events below and read by the Settings Language view through `activity`.
	const localizationActivity = createLocalizationActivityTracker();

	const queueModelSwitch = (
		ctx: ExtensionContext,
		model: PiModel,
		reference: PickerModel,
		setProjectDefault = false,
	): void => {
		queuedModelSwitch = { model, reference, setProjectDefault };
		const display = modelDisplay(reference);
		ctx.ui.notify(
			catalogText(messageCatalog, CatalogMessageId.modelPickerSwitchQueued, {
				model: protectedModelId(`${display.provider}/${display.modelId}`),
			}),
			"info",
		);
	};

	const syncSession = (ctx: ExtensionContext): void => {
		activeCtx = ctx;
		try {
			projectKey = deriveProjectKey(ctx.cwd);
		} catch {
			projectKey = deriveProjectKey(ctx.cwd, { runGit: () => undefined, realpath: (value) => value });
		}
		const loaded = store.load();
		state = loaded.state;
		if (loaded.quarantinePath && !stateWarningShown) {
			stateWarningShown = true;
			ctx.ui.notify(
				catalogText(messageCatalog, CatalogMessageId.modelPickerStatePreserved, {
					path: protectedPath(loaded.quarantinePath),
				}),
				"warning",
			);
		}
		if (catalogWarning && !catalogWarningShown) {
			catalogWarningShown = true;
			ctx.ui.notify(catalogWarning, "warning");
		}
		const current = modelReference(ctx.model, catalog);
		previous = previousModelStack(ctx.sessionManager.getBranch(), current).map((reference) => {
			const identity = catalogRuntimeIdentity(reference.provider);
			return identity
				? catalogModelReference(
						reference.provider,
						reference.modelId,
						catalogs.find(({ document }) => document.catalogId === identity.catalogId)?.document,
					)
				: reference;
		});
		pendingDispatch = current;
		selectedReference = current;
	};

	const applyThinking = (
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		level: ModelPickerThinkingLevel | undefined,
	): void => {
		if (level === undefined) return;
		const reference = modelReference(ctx.model, catalog);
		const previousLevel = ctx.thinkingLevel;
		const notificationCount = thinkingNotificationCount;
		try {
			applyingSavedThinking = true;
			pi.setThinkingLevel(level);
			// Earlier extensions may delay this notification until after setThinkingLevel returns.
			if (
				thinkingNotificationCount === notificationCount &&
				reference &&
				previousLevel !== undefined &&
				ctx.thinkingLevel !== undefined &&
				ctx.thinkingLevel !== previousLevel
			) {
				pendingThinkingNotifications.push({ reference, level: ctx.thinkingLevel, previousLevel });
			}
		} catch (error) {
			ctx.ui.notify(
				catalogText(messageCatalog, CatalogMessageId.modelPickerThinkingLevelNotApplied, {
					message: error instanceof Error ? error.message : String(error),
				}),
				"warning",
			);
		} finally {
			applyingSavedThinking = false;
		}
	};

	// Keep late catalog arrival eligible only while the initial session is untouched.
	const applyCatalogDefault = (signal?: AbortSignal): Promise<void> => {
		signal?.throwIfAborted();
		if (catalogDefaultAttempt) return catalogDefaultAttempt;
		const ctx = activeCtx;
		const pi = extensionApi;
		if (!ctx || !pi || !catalogDefaultEligible || catalogDefaultSettled) return Promise.resolve();
		const saved = store.load().state;
		const settings = pi.getSettings();
		if (
			hasConversationEntries(ctx.sessionManager.getBranch()) ||
			ctx.scopedModels.length > 0 ||
			saved.defaults.projects[projectKey] ||
			saved.last ||
			saved.recents.global.length > 0 ||
			(saved.recents.projects[projectKey]?.length ?? 0) > 0 ||
			settings.defaultModel ||
			settings.defaultProvider
		) {
			catalogDefaultEligible = false;
			return Promise.resolve();
		}
		if (!ctx.isIdle()) return Promise.resolve();
		const attempt = async (): Promise<void> => {
			const available = pickerModels(ctx, catalogs, catalogEnv, paths).filter((row) => row.available);
			for (const reference of catalogDefaultCandidates(catalogs)) {
				signal?.throwIfAborted();
				if (!catalogDefaultEligible || catalogDefaultSettled || activeCtx !== ctx) return;
				if (!available.some((row) => modelReferencesEqual(row, reference))) continue;
				const model = resolveCatalogModel(ctx, reference, catalogs);
				if (!model) continue;
				const thinking = startupThinkingArgument(options.startupArgs ?? []) ?? ctx.thinkingLevel;
				try {
					restoringStartupModel = true;
					const frame = { active: true, signal };
					let applied: boolean;
					try {
						applied = await catalogDefaultSelectionContext.run(frame, () => pi.setModel(model));
					} finally {
						frame.active = false;
					}
					if (!applied) continue;
					catalogDefaultSettled = true;
					// An extension may deliberately select another model from model_select.
					if (ctx.model?.provider !== model.provider || ctx.model.id !== model.id) return;
					selectedReference = reference;
					applyThinking(
						pi,
						ctx,
						options.restoreLastThinkingLevelAtStartup !== false &&
							!hasExplicitStartupThinking(options.startupArgs ?? [], ctx.modelRegistry)
							? preferredModelThinkingLevel(saved, reference, catalogThinkingLevel(reference, catalogs))
							: thinking,
					);
					return;
				} catch {
					signal?.throwIfAborted();
					// A hint is optional. Try the next authenticated offering without changing saved preferences.
				} finally {
					restoringStartupModel = false;
				}
			}
		};
		catalogDefaultAttempt = attempt().finally(() => {
			catalogDefaultAttempt = undefined;
		});
		return catalogDefaultAttempt;
	};

	const waitForCatalogDefault = async (): Promise<void> => {
		// Independent user work waits for completion, not for the login's outcome.
		await catalogDefaultAttempt?.catch(() => {});
	};
	const beforeExternalModelSelection = async (): Promise<void> => {
		catalogDefaultSettled = true;
		await waitForCatalogDefault();
	};

	const extension: InlineExtension = {
		name: "jouzu-model-picker",
		factory: (pi) => {
			catalogProjection.registerStartup(pi, catalogs);
			extensionApi = pi;
			setModel = async (model) => {
				const ctx = activeCtx;
				const sameModel = ctx?.model?.provider === model.provider && ctx.model.id === model.id;
				if (!ctx || !sameModel) return pi.setModel(model);
				// Pi reapplies defaults even for the active model, without model_select.
				// Keep its live reasoning and do not persist that automatic reset.
				const level = ctx.thinkingLevel;
				try {
					restoringStartupModel = true;
					return await pi.setModel(model);
				} finally {
					applyThinking(pi, ctx, level);
					restoringStartupModel = false;
				}
			};
			reapplyCatalogProjection = () => {
				if (activeCtx) catalogProjection.sync(pi, activeCtx, catalogs);
			};
			pi.registerCommand?.("catalogs", {
				description: catalogText(messageCatalog, "jouzu.cli.session.slash.catalogs"),
				handler: async (_args, ctx) => {
					if (ctx.mode !== "tui" || !(await openSettings())) {
						ctx.ui.notify(
							catalogText(messageCatalog, CatalogMessageId.modelPickerCatalogSettingsRequireTui),
							"warning",
						);
					}
				},
			});
			if (options.runtime)
				pi.registerCommand?.("about", {
					description: catalogText(messageCatalog, "jouzu.cli.session.slash.about"),
					handler: async (_args, ctx) => {
						activeCtx = ctx;
						if (ctx.mode !== "tui") {
							ctx.ui.notify(
								options.runtime?.about() ??
									catalogText(messageCatalog, CatalogMessageId.modelPickerRuntimeDiagnosticsUnavailable),
								"info",
							);
							return;
						}
						await openPalette({ view: "settings", query: "about" });
					},
				});
			pi.on("session_start", async (event, ctx) => {
				activeCtx = ctx;
				removeShisaAuthListener ??= onShisaAuthChange(paths, () => {
					void reloadCatalogs(false);
				});
				if (event.reason === "reload") {
					const refreshes = await Promise.allSettled([
						catalogProjection.refresh(pi, ctx, catalogs, AbortSignal.timeout(15_000)),
						refreshAvailableModelCatalogs(paths, {
							env: catalogEnv,
							fetch: options.catalogFetch,
							timeoutMs: 15_000,
							catalog: messageCatalog,
						}),
					]);
					await reloadCatalogs();
					const modelRefresh = refreshes[0];
					if (modelRefresh.status === "rejected") {
						const message =
							modelRefresh.reason instanceof Error ? modelRefresh.reason.message : String(modelRefresh.reason);
						ctx.ui.notify(
							catalogText(messageCatalog, CatalogMessageId.modelPickerModelsNotRefreshed, {
								message: sanitizeTerminalText(message),
							}),
							"warning",
						);
					} else if (modelRefresh.value.modelRefresh.errors.size > 0) {
						const providers = [...modelRefresh.value.modelRefresh.errors.keys()]
							.map((provider) => sanitizeTerminalText(provider))
							.join(", ");
						ctx.ui.notify(
							catalogText(messageCatalog, CatalogMessageId.modelPickerProvidersNotRefreshed, { providers }),
							"warning",
						);
					}
					const catalogRefresh = refreshes[1];
					if (catalogRefresh.status === "rejected") {
						const message =
							catalogRefresh.reason instanceof Error ? catalogRefresh.reason.message : String(catalogRefresh.reason);
						ctx.ui.notify(
							catalogText(messageCatalog, CatalogMessageId.modelPickerCatalogsWereNotRefreshed, {
								message: sanitizeTerminalText(message),
							}),
							"warning",
						);
					} else {
						reviewHeld(ctx, heldCatalogUpdates(catalogRefresh.value));
						const failed = (catalogRefresh.value?.results ?? [])
							.filter(({ result }) => result.status === "error" || result.status === "rejected")
							.map(({ source }) => sanitizeTerminalText(source.label));
						if (failed.length > 0) {
							ctx.ui.notify(
								catalogText(messageCatalog, CatalogMessageId.modelPickerCatalogsNotRefreshed, {
									sources: failed.join(", "),
								}),
								"warning",
							);
						}
					}
				} else {
					catalogProjection.sync(pi, ctx, catalogs);
				}
				syncSession(ctx);
				if (pendingHeldUpdates.length > 0) {
					const updates = pendingHeldUpdates;
					pendingHeldUpdates = [];
					reviewHeld(ctx, updates);
				}
				if (event.reason !== "reload") catalogDefaultEligible = false;
				if (
					(event.reason !== "startup" && event.reason !== "new") ||
					hasConversationEntries(ctx.sessionManager.getBranch()) ||
					ctx.scopedModels.length > 0
				)
					return;
				const restoreThinking =
					options.restoreLastThinkingLevelAtStartup !== false &&
					!hasExplicitStartupThinking(options.startupArgs ?? [], ctx.modelRegistry);
				const projectReference =
					options.applyProjectDefaultAtStartup === true ? state.defaults.projects[projectKey] : undefined;
				const lastUsed =
					options.restoreLastModelAtStartup === true ? (state.last ?? state.recents.global[0]) : undefined;
				const reference = projectReference ?? lastUsed;
				if (!reference) {
					catalogDefaultEligible =
						options.applyCatalogDefaultAtStartup === true && projectDefaultAppliesAtStartup(options.startupArgs ?? []);
					await applyCatalogDefault();
					const current = modelReference(ctx.model, catalog);
					if (current && restoreThinking)
						applyThinking(
							pi,
							ctx,
							preferredModelThinkingLevel(state, current, catalogThinkingLevel(current, catalogs)),
						);
					return;
				}
				const startupThinkingLevel = ctx.thinkingLevel;
				if (!modelReferencesEqual(reference, modelReference(ctx.model, catalog))) {
					const label = catalogText(
						messageCatalog,
						projectReference
							? CatalogMessageId.modelPickerStartupProjectDefault
							: CatalogMessageId.modelPickerStartupLastUsed,
					);
					const model = resolveCatalogModel(ctx, reference, catalogs);
					if (!model) {
						ctx.ui.notify(
							catalogText(messageCatalog, CatalogMessageId.modelPickerStartupUnavailable, {
								label,
								model: protectedModelId(`${reference.provider}/${reference.modelId}`),
							}),
							"warning",
						);
						return;
					}
					try {
						restoringStartupModel = true;
						if (!(await pi.setModel(model))) {
							ctx.ui.notify(
								catalogText(messageCatalog, CatalogMessageId.modelPickerStartupNotAuthenticated, {
									label,
									model: protectedModelId(`${reference.provider}/${reference.modelId}`),
								}),
								"warning",
							);
							return;
						}
					} catch (error) {
						ctx.ui.notify(
							catalogText(messageCatalog, CatalogMessageId.modelPickerStartupNotApplied, {
								label,
								message: error instanceof Error ? error.message : String(error),
							}),
							"warning",
						);
						return;
					} finally {
						restoringStartupModel = false;
					}
				}
				selectedReference = reference;
				applyThinking(
					pi,
					ctx,
					restoreThinking
						? preferredModelThinkingLevel(state, reference, catalogThinkingLevel(reference, catalogs))
						: startupThinkingLevel,
				);
			});
			pi.on("model_select", (event, ctx) => {
				activeCtx = ctx;
				const old = modelReference(event.previousModel, catalog);
				if (old) {
					previous = [old, ...previous.filter((reference) => !modelReferencesEqual(reference, old))].slice(
						0,
						MODEL_PICKER_HISTORY_LIMIT,
					);
				}
				pendingDispatch = modelReference(event.model, catalog);
				selectedReference = pendingDispatch;
				if (!restoringStartupModel) catalogDefaultSettled = true;
				if (!selectedReference || restoringStartupModel || event.source === "restore") return;
				const scopedLevel = ctx.scopedModels.find(
					({ model }) => model.provider === event.model.provider && model.id === event.model.id,
				)?.thinkingLevel;
				state = store.load().state;
				applyThinking(
					pi,
					ctx,
					scopedLevel ??
						preferredModelThinkingLevel(state, selectedReference, catalogThinkingLevel(selectedReference, catalogs)),
				);
			});
			pi.on("thinking_level_select", (event, ctx) => {
				thinkingNotificationCount += 1;
				activeCtx = ctx;
				const current = modelReference(ctx.model, catalog);
				const pendingIndex = pendingThinkingNotifications.findIndex(
					(record) =>
						modelReferencesEqual(record.reference, current) &&
						record.level === event.level &&
						record.previousLevel === event.previousLevel,
				);
				if (pendingIndex !== -1) {
					pendingThinkingNotifications.splice(pendingIndex, 1);
					return;
				}
				// Pi emits automatic thinking changes before model_select. Do not save
				// the incoming model's default/clamped level over its preference.
				if (
					!current ||
					!modelReferencesEqual(selectedReference, current) ||
					restoringStartupModel ||
					applyingSavedThinking ||
					(ctx.thinkingLevel !== undefined && event.level !== ctx.thinkingLevel)
				)
					return;
				try {
					state = store.setModelThinkingLevel(current, event.level);
				} catch (error) {
					ctx.ui.notify(
						catalogText(messageCatalog, CatalogMessageId.modelPickerThinkingLevelNotSaved, {
							message: error instanceof Error ? error.message : String(error),
						}),
						"warning",
					);
				}
			});
			pi.on("input", async (event, ctx) => {
				await waitForCatalogDefault();
				if (!ctx.model || !ctx.isIdle()) return { action: "continue" };
				const identity = catalogRuntimeIdentity(ctx.model.provider);
				const reference = modelReference(ctx.model, catalog);
				if (!reference) return { action: "continue" };
				try {
					if (identity && !catalogs.some(({ document }) => document.catalogId === identity.catalogId))
						throw new Error(catalogText(messageCatalog, CatalogMessageId.modelPickerCatalogDisabled));
					const effective = resolveCatalogModel(ctx, reference, catalogs);
					if (!effective)
						throw new Error(
							catalogText(messageCatalog, CatalogMessageId.modelPickerModelUnavailableDetail, {
								model: protectedModelId(`${reference.provider}/${reference.modelId}`),
							}),
						);
					if (
						effective.provider !== ctx.model.provider ||
						effective.baseUrl !== ctx.model.baseUrl ||
						(identity && JSON.stringify(effective) !== JSON.stringify(ctx.model))
					) {
						if (!(await pi.setModel(effective)))
							throw new Error(
								catalogText(messageCatalog, CatalogMessageId.modelPickerNoAuthenticationCredential, {
									model: protectedModelId(`${reference.provider}/${reference.modelId}`),
								}),
							);
					}
					return { action: "continue" };
				} catch (error) {
					ctx.ui.notify(sanitizeTerminalText(error instanceof Error ? error.message : String(error)), "error");
					if (ctx.mode === "tui") ctx.ui.setEditorText?.(event.text);
					return { action: "handled" };
				}
			});
			pi.on("before_agent_start", beforeExternalModelSelection);
			pi.on("agent_start", () => {
				catalogDefaultSettled = true;
				localizationActivity.set("streaming", true);
			});
			pi.on("agent_end", () => localizationActivity.set("streaming", false));
			pi.on("agent_settled", () => localizationActivity.set("streaming", false));
			pi.on("tool_execution_start", () => localizationActivity.set("tool", true));
			pi.on("tool_execution_end", () => localizationActivity.set("tool", false));
			pi.on("before_provider_request", (_event, ctx) => {
				catalogDefaultSettled = true;
				activeCtx = ctx;
				const dispatched = modelReference(ctx.model, catalog);
				if (!dispatched || !pendingDispatch || !modelReferencesEqual(dispatched, pendingDispatch)) return;
				try {
					state = store.recordDispatch(dispatched, projectKey, { thinkingLevel: ctx.thinkingLevel });
					pendingDispatch = undefined;
				} catch (error) {
					ctx.ui.notify(
						catalogText(messageCatalog, CatalogMessageId.modelPickerRecencyNotSaved, {
							message: error instanceof Error ? error.message : String(error),
						}),
						"warning",
					);
				}
			});
			pi.on("turn_end", async (_event, ctx) => {
				const queued = queuedModelSwitch;
				const activateModel = setModel;
				if (!queued || !activateModel) return;
				queuedModelSwitch = undefined;
				const display = modelDisplay(queued.reference);
				try {
					const effective = resolveCatalogModel(ctx, queued.reference, catalogs);
					if (!effective)
						throw new Error(
							catalogText(messageCatalog, CatalogMessageId.modelPickerModelUnavailableDetail, {
								model: protectedModelId(`${display.provider}/${display.modelId}`),
							}),
						);
					if (!(await activateModel(effective))) {
						throw new Error(
							catalogText(messageCatalog, CatalogMessageId.modelPickerNoAuthentication, {
								model: protectedModelId(`${display.provider}/${display.modelId}`),
							}),
						);
					}
					if (queued.setProjectDefault) state = store.setProjectDefault(queued.reference, projectKey);
					ctx.ui.notify(
						catalogText(messageCatalog, CatalogMessageId.modelPickerSwitchedTo, {
							model: protectedModelId(`${display.provider}/${display.modelId}`),
						}),
						"info",
					);
				} catch (error) {
					ctx.ui.notify(
						catalogText(messageCatalog, CatalogMessageId.modelPickerQueuedSwitchFailed, {
							message: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
						}),
						"warning",
					);
				}
			});
			// Authentication changes can precede the authenticated fetch. Re-project now,
			// but wait for refreshShisaAccount before selecting from account-scoped hints.
			let removeShisaAuthListener: (() => void) | undefined = onShisaAuthChange(paths, () => {
				void reloadCatalogs(false);
			});
			pi.on("session_shutdown", (_event, ctx) => {
				removeShisaAuthListener?.();
				removeShisaAuthListener = undefined;
				catalogProjection.release(pi, ctx);
				activeCtx = undefined;
				catalogDefaultEligible = false;
				pendingDispatch = undefined;
				selectedReference = undefined;
				pendingThinkingNotifications.length = 0;
				queuedModelSwitch = undefined;
				cycleBusy = false;
				extensionApi = undefined;
				setModel = undefined;
				localizationActivity.reset();
			});
		},
	};

	const openPalette = async (route: PaletteRoute): Promise<boolean> => {
		const ctx = activeCtx;
		const activateModel = setModel;
		if (ctx?.mode !== "tui" || !activateModel) return false;
		return surface.open(
			ctx,
			route,
			(componentContext, initialRoute) =>
				new JouzuPaletteRouter({
					context: componentContext,
					initialRoute,
					factories: {
						models: (childContext, childRoute) =>
							new ModelPickerComponent({
								context: childContext,
								initialRoute: childRoute,
								getRows: (query) =>
									buildPickerRows({
										models: pickerModels(ctx, catalogs, catalogEnv, paths),
										state,
										projectKey,
										current: modelReference(ctx.model, catalog),
										previous,
										query,
										activeContextTokens: ctx.getContextUsage()?.tokens,
									}),
								onSelect: async (row) => {
									const model = resolveCatalogModel(ctx, row.model, catalogs);
									if (!model)
										throw new Error(
											catalogText(messageCatalog, CatalogMessageId.modelPickerModelUnavailableDetail, {
												model: protectedModelId(`${row.model.provider}/${row.model.modelId}`),
											}),
										);
									if (!ctx.isIdle()) {
										queueModelSwitch(ctx, model, row.model, true);
										return;
									}
									if (!(await activateModel(model)))
										throw new Error(
											catalogText(messageCatalog, CatalogMessageId.modelPickerNoAuthentication, {
												model: protectedModelId(`${row.model.provider}/${row.model.modelId}`),
											}),
										);
									state = store.setProjectDefault(row.model, projectKey);
								},
								onCompactAndSelect: async (row) => {
									if (!ctx.isIdle()) {
										throw new Error(catalogText(messageCatalog, CatalogMessageId.modelPickerWaitForActiveCall));
									}
									const model = resolveCatalogModel(ctx, row.model, catalogs);
									if (!model)
										throw new Error(
											catalogText(messageCatalog, CatalogMessageId.modelPickerModelUnavailableDetail, {
												model: protectedModelId(`${row.model.provider}/${row.model.modelId}`),
											}),
										);
									await compactContextForModelSwitch(ctx, row.model);
									if (!(await activateModel(model)))
										throw new Error(
											catalogText(messageCatalog, CatalogMessageId.modelPickerNoAuthentication, {
												model: protectedModelId(`${row.model.provider}/${row.model.modelId}`),
											}),
										);
									state = store.setProjectDefault(row.model, projectKey);
								},
								onToggleFavorite: (row) => {
									state = store.toggleFavorite(row.model);
								},
								onRefresh: async (signal) => {
									const api = extensionApi;
									if (!api)
										throw new Error(catalogText(messageCatalog, CatalogMessageId.modelPickerRefreshUnavailable));
									const result = await catalogProjection.refresh(api, ctx, catalogs, signal);
									if (result.modelRefresh.errors.size > 0) {
										throw new Error(
											catalogText(messageCatalog, CatalogMessageId.modelPickerRefreshFailedProviders, {
												providers: [...result.modelRefresh.errors.keys()].join(", "),
											}),
										);
									}
									if (result.modelRefresh.aborted)
										throw new Error(catalogText(messageCatalog, CatalogMessageId.modelPickerRefreshAborted));
								},
								subscribeCatalogsReloaded: (listener) => {
									catalogReloadListeners.add(listener);
									return () => {
										catalogReloadListeners.delete(listener);
									};
								},
								onRefreshCatalogs: async (signal) => {
									const api = extensionApi;
									if (!api)
										throw new Error(catalogText(messageCatalog, CatalogMessageId.modelPickerRefreshUnavailable));
									const refreshes = await Promise.allSettled([
										catalogProjection.refresh(api, ctx, catalogs, signal),
										refreshAvailableModelCatalogs(paths, {
											env: catalogEnv,
											fetch: options.catalogFetch,
											timeoutMs: 15_000,
											catalog: messageCatalog,
										}),
									]);
									await reloadCatalogs();
									const modelRefresh = refreshes[0];
									if (modelRefresh.status === "rejected") {
										const message =
											modelRefresh.reason instanceof Error ? modelRefresh.reason.message : String(modelRefresh.reason);
										throw new Error(
											catalogText(messageCatalog, CatalogMessageId.modelPickerModelsNotRefreshedDetail, {
												message: sanitizeTerminalText(message),
											}),
										);
									}
									if (modelRefresh.value.modelRefresh.errors.size > 0) {
										const providers = [...modelRefresh.value.modelRefresh.errors.keys()]
											.map((provider) => sanitizeTerminalText(provider))
											.join(", ");
										throw new Error(
											catalogText(messageCatalog, CatalogMessageId.modelPickerProvidersNotRefreshedDetail, {
												providers,
											}),
										);
									}
									const catalogRefresh = refreshes[1];
									if (catalogRefresh.status === "rejected") {
										const message =
											catalogRefresh.reason instanceof Error
												? catalogRefresh.reason.message
												: String(catalogRefresh.reason);
										throw new Error(
											catalogText(messageCatalog, CatalogMessageId.modelPickerCatalogsNotRefreshedDetail, {
												message: sanitizeTerminalText(message),
											}),
										);
									}
									reviewHeld(ctx, heldCatalogUpdates(catalogRefresh.value));
									const failed = (catalogRefresh.value?.results ?? [])
										.filter(({ result }) => result.status === "error" || result.status === "rejected")
										.map(({ source }) => sanitizeTerminalText(source.label));
									if (failed.length > 0) {
										throw new Error(
											catalogText(messageCatalog, CatalogMessageId.modelPickerCatalogsNotRefreshedDetail, {
												message: failed.join(", "),
											}),
										);
									}
								},
							}),
						workflow: (childContext, route) => new WorkflowComponent(childContext, workflow.service, route),
						settings: (childContext, route) =>
							new CatalogSettingsComponent({
								context: childContext,
								initialRoute: route,
								runtime: options.runtime,
								paths,
								env: catalogEnv,
								sessionId: ctx.sessionManager?.getSessionId(),
								onCatalogsChanged: reloadCatalogs,
								onReviewHeldCatalog: async (updates) => {
									const changed = await reviewHeldCatalogUpdates(ctx, updates, {
										paths,
										env: catalogEnv,
										catalog: messageCatalog,
									});
									if (changed) await reloadCatalogs();
								},
								labelPolicy: createLabelPolicy(paths),
								...(options.onDashboardChanged ? { onDashboardChanged: options.onDashboardChanged } : {}),
								onAccountChanged: (change) => refreshShisaAccount(change),
								...(options.jouzuVersion ? { jouzuVersion: options.jouzuVersion } : {}),
								...(options.uiLocaleCli ? { uiLocaleCli: options.uiLocaleCli } : {}),
								...(options.onLanguageChanged ? { onLanguageChanged: options.onLanguageChanged } : {}),
								...(options.onUiLocaleChanged ? { onUiLocaleChanged: options.onUiLocaleChanged } : {}),
								activity: () => localizationActivity.snapshot(),
							}),
					},
				}),
			options.palette,
		);
	};

	const open = async (request: JouzuModelPickerRequest): Promise<boolean> =>
		openPalette({ view: "models", ...(request.initialSearchInput ? { query: request.initialSearchInput } : {}) });

	const openSettings = async (): Promise<boolean> => openPalette({ view: "settings", query: "catalogs" });

	const modelsOpenText = (): string => {
		// Pi installs the app-level manager as the global registry when the TUI
		// starts; before that the registry resolves only TUI actions, so fall
		// back to a generic label when app.model.select has no keys.
		const text = formatEffectiveKeybinding(getKeybindings() as unknown as KeybindingsManager, "app.model.select");
		return text === "Unbound" ? catalogText(messageCatalog, CatalogMessageId.modelPickerModelSelectBinding) : text;
	};

	const cycleFavorite = async (direction: FavoriteCycleDirection): Promise<boolean> => {
		const ctx = activeCtx;
		const activateModel = setModel;
		if (ctx?.mode !== "tui" || !activateModel) return false;
		if (cycleBusy) {
			ctx.ui.notify(catalogText(messageCatalog, CatalogMessageId.modelPickerFavoriteSwitchInProgress), "info");
			return true;
		}
		const current = queuedModelSwitch?.reference ?? modelReference(ctx.model, catalog);
		const favoriteRows = buildPickerRows({
			models: pickerModels(ctx, catalogs, catalogEnv, paths),
			state,
			projectKey,
			current,
			favoritesOnly: true,
			activeContextTokens: ctx.getContextUsage()?.tokens,
		});
		if (favoriteRows.length === 0) {
			ctx.ui.notify(
				catalogText(messageCatalog, CatalogMessageId.modelPickerNoFavoriteModelsAdd, {
					key: modelsOpenText(),
					toggle: formatEffectiveJouzuKeybinding(jouzuKeybindings, "jouzu.model.toggleFavorite"),
				}),
				"info",
			);
			return true;
		}
		const availableRows = favoriteRows.filter((row) => row.model.available);
		const candidates = availableRows.filter((row) => row.contextFit !== "too-small");
		if (candidates.length === 0) {
			ctx.ui.notify(
				availableRows.length === 0
					? catalogText(messageCatalog, CatalogMessageId.modelPickerNoFavoriteModelsAvailable)
					: catalogText(messageCatalog, CatalogMessageId.modelPickerNoFavoriteFits, { key: modelsOpenText() }),
				"warning",
			);
			return true;
		}
		const currentIndex = candidates.findIndex((row) => modelReferencesEqual(row.model, current));
		if (candidates.length === 1 && currentIndex === 0) {
			ctx.ui.notify(catalogText(messageCatalog, CatalogMessageId.modelPickerOnlyOneFavorite), "info");
			return true;
		}
		const targetIndex =
			currentIndex < 0
				? direction === "forward"
					? 0
					: candidates.length - 1
				: direction === "forward"
					? (currentIndex + 1) % candidates.length
					: (currentIndex - 1 + candidates.length) % candidates.length;
		const target = candidates[targetIndex].model;
		const model = resolveCatalogModel(ctx, target, catalogs);
		if (!model) {
			ctx.ui.notify(
				catalogText(messageCatalog, CatalogMessageId.modelPickerFavoriteUnavailable, {
					model: protectedModelId(`${modelDisplay(target).provider}/${modelDisplay(target).modelId}`),
				}),
				"warning",
			);
			return true;
		}
		if (!ctx.isIdle()) {
			queueModelSwitch(ctx, model, target);
			return true;
		}
		cycleBusy = true;
		try {
			if (!(await activateModel(model))) {
				ctx.ui.notify(
					catalogText(messageCatalog, CatalogMessageId.modelPickerNoAuthentication, {
						model: protectedModelId(`${modelDisplay(target).provider}/${modelDisplay(target).modelId}`),
					}),
					"warning",
				);
				return true;
			}
			ctx.ui.notify(
				catalogText(messageCatalog, CatalogMessageId.modelPickerSwitchedTo, {
					model: protectedModelId(`${modelDisplay(target).provider}/${modelDisplay(target).modelId}`),
				}),
				"info",
			);
		} catch (error) {
			ctx.ui.notify(
				catalogText(messageCatalog, CatalogMessageId.modelPickerFavoriteSwitchFailed, {
					message: sanitizeTerminalText(error instanceof Error ? error.message : String(error)),
				}),
				"warning",
			);
		} finally {
			cycleBusy = false;
		}
		return true;
	};

	const handleScopedModelsCommand = async (): Promise<boolean> => {
		const ctx = activeCtx;
		if (ctx?.mode !== "tui") return false;
		ctx.ui.notify(
			catalogText(messageCatalog, CatalogMessageId.modelPickerFavoritesUsage, {
				key: modelsOpenText(),
				toggle: formatEffectiveJouzuKeybinding(jouzuKeybindings, "jouzu.model.toggleFavorite"),
			}),
			"info",
		);
		return true;
	};

	return {
		extension,
		workflowExtension: {
			name: "jouzu-workflow",
			factory: (pi) =>
				workflow.register(pi, (section) =>
					openPalette({ view: "workflow", ...(section === "runs" ? { query: "runs" } : {}) }),
				),
		},
		open,
		openSettings,
		cycleFavorite,
		handleScopedModelsCommand,
		activeAgentCount: () => workflow.service.runs().filter(isActiveRun).length,
		wrapSessionIngress: (delegate) =>
			wrapModelSelectionIngress(delegate, {
				enteringAutomaticSelection: () => catalogDefaultSelectionContext.getStore()?.active === true,
				automaticSelectionSignal: () => {
					const frame = catalogDefaultSelectionContext.getStore();
					return frame?.active ? frame.signal : undefined;
				},
				beforeSelection: beforeExternalModelSelection,
			}),
		workflowService: workflow.service,
		reloadCatalogs,
		reviewHeldCatalogs: (result) => reviewHeld(activeCtx, heldCatalogUpdates(result)),
		refreshShisaAccount,
	};
}
