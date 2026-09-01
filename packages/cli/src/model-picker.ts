import type { ExtensionContext, InlineExtension, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, Input, matchesKey, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CatalogSettingsComponent } from "./catalog-settings.js";
import { formatEffectiveKeybinding, formatEffectiveKeyPair } from "./keybinding-hints.js";
import type { CatalogModelOffering, ModelCatalogDocument } from "./model-catalog.js";
import { type ActiveModelCatalog, loadActiveModelCatalogs } from "./model-catalog-sync.js";
import { buildPickerRows, type PickerFilter, type PickerModel, type PickerRow } from "./model-picker-ranking.js";
import {
	deriveProjectKey,
	emptyModelPickerState,
	MODEL_PICKER_HISTORY_LIMIT,
	type ModelPickerState,
	ModelPickerStore,
	type ModelReference,
	modelReferenceKey,
	modelReferencesEqual,
	previousModelStack,
} from "./model-picker-state.js";
import {
	JouzuPaletteRouter,
	JouzuPaletteSurfaceHost,
	type PaletteComponent,
	type PaletteComponentContext,
	type PaletteRoute,
	type PaletteSurfaceOptions,
	renderPaletteTabs,
} from "./palette.js";
import type { JouzuPaths } from "./paths.js";
import { detectBannerColorMode, renderBrandGradient } from "./presentation.js";
import type { SessionUiStyles } from "./session-ui/index.js";
import {
	fitTerminalText,
	padTerminalText,
	renderTerminalFrameBorder,
	renderTerminalFrameRow,
	renderTerminalFrameTitle,
	sanitizeTerminalText,
} from "./terminal-layout.js";

type PiModel = NonNullable<ExtensionContext["model"]>;

export interface JouzuModelPickerRequest {
	source: "action" | "command";
	initialSearchInput?: string;
}

export interface JouzuModelPickerOptions {
	applyProjectDefaultAtStartup?: boolean;
	restoreLastModelAtStartup?: boolean;
	palette?: PaletteSurfaceOptions;
}

export interface ModelPickerComponentOptions {
	context: PaletteComponentContext;
	initialRoute: PaletteRoute;
	initialFilter?: PickerFilter;
	getRows(query: string, filter: PickerFilter): PickerRow[];
	onSelect(row: PickerRow, scope: "session" | "project"): Promise<void>;
	onToggleFavorite(row: PickerRow): void;
	onFilterChange?(filter: PickerFilter): void;
	onRefresh?(signal: AbortSignal): Promise<void>;
}

const FILTERS: PickerFilter[] = ["recent", "favorite", "all"];
const FILTER_LABELS: Record<PickerFilter, string> = { recent: "Recent", favorite: "Favorite", all: "All" };

const SECTION_LABELS: Record<PickerRow["section"], string> = {
	current: "Current",
	previous: "Previous",
	favorite: "Favorite",
	project_recent: "Project",
	global_recent: "Recent",
	all: "All",
};

function compactNumber(value: number | undefined): string {
	if (value === undefined) return "unknown";
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
	if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
	return String(value);
}

function modelDisplay(model: PickerModel): { provider: string; modelId: string; name: string } {
	return (
		model.display ?? {
			provider: sanitizeTerminalText(model.provider),
			modelId: sanitizeTerminalText(model.modelId),
			name: sanitizeTerminalText(model.name),
		}
	);
}

export class ModelPickerComponent implements PaletteComponent, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly styles: SessionUiStyles;
	private readonly wordmark: string;
	private readonly close: () => void;
	private readonly getRows: (query: string, filter: PickerFilter) => PickerRow[];
	private readonly onSelect: (row: PickerRow, scope: "session" | "project") => Promise<void>;
	private readonly onToggleFavorite: (row: PickerRow) => void;
	private readonly onFilterChange?: (filter: PickerFilter) => void;
	private readonly searchInput = new Input();
	private rows: PickerRow[] = [];
	private filter: PickerFilter;
	private searchFocused = false;
	private filterCounts: Record<PickerFilter, number> = { recent: 0, favorite: 0, all: 0 };
	private selectedIndex = 0;
	private busy = false;
	private message?: { level: "error" | "info"; text: string };
	private refreshController?: AbortController;
	private disposed = false;
	private _focused = false;

	constructor(options: ModelPickerComponentOptions) {
		this.tui = options.context.tui;
		this.theme = options.context.theme;
		this.keybindings = options.context.keybindings;
		this.styles = options.context.styles;
		// The gradient wordmark varies per character, so it is rendered once here
		// rather than resolved through a single-color role on every frame.
		this.wordmark = renderBrandGradient("JOUZU", detectBannerColorMode());
		this.close = options.context.close;
		this.getRows = options.getRows;
		this.onSelect = options.onSelect;
		this.onToggleFavorite = options.onToggleFavorite;
		this.onFilterChange = options.onFilterChange;
		this.filter = options.initialFilter ?? "recent";
		this.searchInput.setValue(options.initialRoute.query ?? "");
		this.searchFocused = Boolean(options.initialRoute.query);
		this.recomputeFilterCounts();
		this.recomputeRows();
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
		this.recomputeFilterCounts();
		this.recomputeRows();
		this.tui.requestRender();
	}

	allowsGlobalNavigation(): boolean {
		return !this.busy;
	}

	/**
	 * Filter counts describe the unfiltered inventory, so they change only when
	 * picker state does. Recomputing them per keystroke would trigger three extra
	 * full ranking passes for a result that cannot have changed.
	 */
	private recomputeFilterCounts(): void {
		this.filterCounts = {
			recent: this.getRows("", "recent").length,
			favorite: this.getRows("", "favorite").length,
			all: this.getRows("", "all").length,
		};
	}

	private recomputeRows(): void {
		const selectedKey = this.rows[this.selectedIndex]
			? modelReferenceKey(this.rows[this.selectedIndex].model)
			: undefined;
		this.rows = this.getRows(this.searchInput.getValue(), this.filter);
		const retainedIndex = selectedKey ? this.rows.findIndex((row) => modelReferenceKey(row.model) === selectedKey) : -1;
		this.selectedIndex =
			retainedIndex >= 0 ? retainedIndex : Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
	}

	private async refresh(onRefresh: (signal: AbortSignal) => Promise<void>): Promise<void> {
		this.refreshController?.abort();
		const controller = new AbortController();
		this.refreshController = controller;
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, 15_000);
		try {
			await onRefresh(controller.signal);
			if (this.disposed || controller.signal.aborted) return;
			this.recomputeFilterCounts();
			this.recomputeRows();
			this.tui.requestRender();
		} catch (error) {
			if (this.disposed || (controller.signal.aborted && !timedOut)) return;
			this.message = {
				level: "error",
				text: timedOut
					? "Model refresh timed out; showing cached models."
					: `Model refresh failed; showing cached models: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
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
		this.tui.requestRender();
	}

	private cycleFilter(delta: number): void {
		const index = FILTERS.indexOf(this.filter);
		this.filter = FILTERS[(index + delta + FILTERS.length) % FILTERS.length];
		this.selectedIndex = 0;
		this.message = undefined;
		try {
			this.onFilterChange?.(this.filter);
		} catch (error) {
			this.message = {
				level: "error",
				text: `Filter choice was not saved: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
			};
		}
		this.recomputeRows();
		this.tui.requestRender();
	}

	private runSelection(scope: "session" | "project"): void {
		const row = this.rows[this.selectedIndex];
		if (!row || this.busy) return;
		if (!row.model.available) {
			this.message = { level: "error", text: "This favorite is unavailable in the active model inventory." };
			this.tui.requestRender();
			return;
		}
		if (row.contextFit === "too-small") {
			this.message = {
				level: "error",
				text: "The active context does not fit this model. Compact or choose a larger-context model.",
			};
			this.tui.requestRender();
			return;
		}
		this.busy = true;
		const display = modelDisplay(row.model);
		this.message = { level: "info", text: `Selecting ${display.provider}/${display.modelId}…` };
		this.tui.requestRender();
		void this.onSelect(row, scope)
			.then(() => this.close())
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

	private toggleFavorite(): void {
		const row = this.rows[this.selectedIndex];
		if (!row || this.busy) return;
		try {
			this.onToggleFavorite(row);
			this.message = { level: "info", text: "Favorite updated." };
			this.recomputeFilterCounts();
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
			if (this.searchFocused) {
				this.searchFocused = false;
				this.message = undefined;
				this.syncSearchFocus();
				this.tui.requestRender();
			} else {
				this.close();
			}
			return;
		}
		if (this.busy) return;
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-8);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveSelection(8);
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
		if (!this.searchFocused && matchesKey(data, "left")) {
			this.cycleFilter(-1);
			return;
		}
		if (!this.searchFocused && matchesKey(data, "right")) {
			this.cycleFilter(1);
			return;
		}
		if (!this.searchFocused && matchesKey(data, "/")) {
			this.searchFocused = true;
			this.message = undefined;
			this.syncSearchFocus();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "shift+enter")) {
			this.runSelection("project");
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.runSelection("session");
			return;
		}
		if (!this.searchFocused && matchesKey(data, "space")) {
			this.toggleFavorite();
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

	private rowText(row: PickerRow, selected: boolean): string {
		const marker = selected ? this.styles.apply("palette.marker", "→") : " ";
		const favorite = row.favorite ? this.styles.apply("palette.favorite", "★") : " ";
		const projectDefault = row.projectDefault ? this.styles.apply("palette.default", "◆") : " ";
		const display = modelDisplay(row.model);
		const identity = `${display.provider}/${display.modelId}`;
		const availability = row.model.available ? "" : this.styles.apply("palette.unavailable", " unavailable");
		const fit = row.contextFit === "too-small" ? this.styles.apply("palette.context.small", " context-small") : "";
		const styledIdentity = this.styles.apply(selected ? "palette.identity.selected" : "palette.identity", identity);
		const source = row.model.catalogLabel
			? this.styles.apply("palette.detail", ` · ${sanitizeTerminalText(row.model.catalogLabel)}`)
			: "";
		const text = `${marker} ${favorite}${projectDefault} ${styledIdentity}${source}${availability}${fit}`;
		return selected ? this.theme.bg("selectedBg", text) : text;
	}

	render(width: number): string[] {
		const title = `${this.wordmark} ${this.theme.bold(this.styles.apply("palette.title", "· Models"))} ${this.styles.apply("palette.count", `${this.rows.length}/${this.filterCounts.all}`)}`;
		if (width < 12) return [fitTerminalText(title, Math.max(1, width))];
		const innerWidth = Math.max(1, width - 4);
		const terminalRows = Number(this.tui.terminal?.rows ?? 24);
		const rowCapacity = Math.max(3, Math.min(12, terminalRows - 16));
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(rowCapacity / 2), Math.max(0, this.rows.length - rowCapacity)),
		);
		const visibleRows = this.rows.slice(start, start + rowCapacity);
		const selected = this.rows[this.selectedIndex];
		const border = (value: string) => this.styles.apply("palette.border", value);
		const frameOptions = { border };
		const line = (value = "") => renderTerminalFrameRow(value, width, frameOptions);
		const hint = (value: string) =>
			wrapTextWithAnsi(value, innerWidth).map((hintLine) => line(this.styles.apply("palette.hint", hintLine)));
		const filterCount = this.filterCounts[this.filter];
		const viewChoice = `View  < ${FILTER_LABELS[this.filter]} >  ${filterCount} model${filterCount === 1 ? "" : "s"}`;
		const searchMarker = this.searchFocused ? this.styles.apply("palette.marker", "→") : " ";
		const searchPrefix = `${searchMarker} Search `;
		const search = `${searchPrefix}${this.searchInput.render(Math.max(1, innerWidth - 9))[0] ?? ""}`;
		const lines = [
			renderTerminalFrameTitle(title, width, frameOptions),
			line(renderPaletteTabs("models", this.theme, this.styles)),
			line(viewChoice),
			line(search),
		];
		if (selected) {
			const defaultLabel = selected.projectDefault ? " · project default" : "";
			const name = this.styles.apply("palette.detail", modelDisplay(selected.model).name);
			const detail = ` ${name} · context ${compactNumber(selected.model.contextWindow)} · max ${compactNumber(selected.model.maxTokens)}${defaultLabel}`;
			lines.push(line(this.theme.bg("selectedBg", padTerminalText(fitTerminalText(detail, innerWidth), innerWidth))));
		} else {
			lines.push(line(this.theme.bg("selectedBg", padTerminalText(" No model selected", innerWidth))));
		}
		lines.push(line());
		if (visibleRows.length === 0) lines.push(line(this.styles.apply("palette.empty", "No matching models")));
		for (let offset = 0; offset < visibleRows.length; offset += 1) {
			const index = start + offset;
			const row = visibleRows[offset];
			const sectionText = padTerminalText(SECTION_LABELS[row.section], 8);
			const section = this.styles.apply(
				row.section === "current" ? "palette.section.current" : "palette.section",
				sectionText,
			);
			lines.push(line(`${section}${this.rowText(row, index === this.selectedIndex)}`));
		}
		while (lines.length < rowCapacity + 6) lines.push(line());
		if (this.message) {
			const role = this.message.level === "error" ? "palette.message.error" : "palette.message.info";
			for (const messageLine of wrapTextWithAnsi(this.message.text, innerWidth)) {
				lines.push(line(this.styles.apply(role, messageLine)));
			}
		}
		const confirm = formatEffectiveKeybinding(this.keybindings, "tui.select.confirm");
		const cancel = formatEffectiveKeybinding(this.keybindings, "tui.select.cancel");
		const move = formatEffectiveKeyPair(this.keybindings, "tui.select.up", "tui.select.down");
		if (this.searchFocused) {
			lines.push(...hint(`${confirm} session · Shift+Enter project default · ${move} move`));
			lines.push(...hint(`Type search · ←→ cursor · Tab section · ${cancel} browse`));
		} else {
			lines.push(...hint(`${confirm} session · Shift+Enter project default · Space favorite`));
			lines.push(...hint(`←→ View · / search · Tab section · ${move} move · ${cancel} close`));
		}
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
	}
}

export type FavoriteCycleDirection = "forward" | "backward";

export interface JouzuModelPickerIntegration {
	extension: InlineExtension;
	open(request: JouzuModelPickerRequest): Promise<boolean>;
	openSettings(): Promise<boolean>;
	cycleFavorite(direction: FavoriteCycleDirection): Promise<boolean>;
	handleScopedModelsCommand(): Promise<boolean>;
}

function catalogOffering(
	catalog: ModelCatalogDocument | undefined,
	provider: string,
	modelId: string,
): CatalogModelOffering | undefined {
	return catalog?.modelOfferings.find((offering) => offering.providerId === provider && offering.modelId === modelId);
}

export function catalogModelReference(
	provider: string,
	modelId: string,
	catalog?: ModelCatalogDocument,
): ModelReference {
	const offering = catalogOffering(catalog, provider, modelId);
	return {
		...(offering && catalog ? { catalogId: catalog.catalogId, offeringId: offering.id } : {}),
		provider,
		modelId,
	};
}

function modelReference(model: PiModel | undefined, catalog?: ModelCatalogDocument): ModelReference | undefined {
	return model ? catalogModelReference(model.provider, model.id, catalog) : undefined;
}

function hasConversationEntries(entries: readonly { type: string }[]): boolean {
	return entries.some((entry) => ["message", "compaction", "branch_summary", "custom_message"].includes(entry.type));
}

export function catalogPickerModel(
	model: Pick<PiModel, "provider" | "id" | "name" | "contextWindow" | "maxTokens">,
	catalog?: ModelCatalogDocument,
	catalogLabel?: string,
): PickerModel {
	const offering = catalogOffering(catalog, model.provider, model.id);
	return {
		...(offering && catalog ? { catalogId: catalog.catalogId, offeringId: offering.id } : {}),
		...(offering && catalogLabel ? { catalogLabel: sanitizeTerminalText(catalogLabel) } : {}),
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
	const matches = catalogs.filter(({ document }) => catalogOffering(document, model.provider, model.id));
	return matches.length > 0
		? matches.map(({ source, document }) => catalogPickerModel(model, document, source.label))
		: [catalogPickerModel(model)];
}

function pickerModels(ctx: ExtensionContext, catalogs: ActiveModelCatalog[]): PickerModel[] {
	const models =
		ctx.scopedModels.length > 0 ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable();
	return models.flatMap((model) => catalogPickerModels(model, catalogs));
}

export function createJouzuModelPicker(
	paths: JouzuPaths,
	options: JouzuModelPickerOptions = {},
): JouzuModelPickerIntegration {
	const store = new ModelPickerStore(paths);
	const surface = new JouzuPaletteSurfaceHost();
	const catalogEnv = options.palette?.env ?? process.env;
	let catalogs: ActiveModelCatalog[] = [];
	let catalog: ModelCatalogDocument | undefined;
	let catalogWarning: string | undefined;
	try {
		catalogs = loadActiveModelCatalogs(paths, catalogEnv);
		catalog = catalogs[0]?.document;
	} catch (error) {
		catalogWarning = `Cached model catalog was ignored: ${error instanceof Error ? error.message : String(error)}`;
	}
	const reloadCatalogs = (): void => {
		try {
			catalogs = loadActiveModelCatalogs(paths, catalogEnv);
			catalog = catalogs[0]?.document;
			catalogWarning = undefined;
		} catch (error) {
			catalogs = [];
			catalog = undefined;
			catalogWarning = `Cached model catalog was ignored: ${error instanceof Error ? error.message : String(error)}`;
		}
	};
	let activeCtx: ExtensionContext | undefined;
	let state: ModelPickerState = emptyModelPickerState();
	let projectKey = "";
	let previous: ModelReference[] = [];
	let pendingDispatch: ModelReference | undefined;
	let queuedModelSwitch: { model: PiModel; reference: PickerModel; setProjectDefault: boolean } | undefined;
	let stateWarningShown = false;
	let catalogWarningShown = false;
	let cycleBusy = false;
	let setModel: ((model: PiModel) => Promise<boolean>) | undefined;

	const queueModelSwitch = (
		ctx: ExtensionContext,
		model: PiModel,
		reference: PickerModel,
		setProjectDefault = false,
	): void => {
		queuedModelSwitch = { model, reference, setProjectDefault };
		const display = modelDisplay(reference);
		ctx.ui.notify(`Model switch queued for the next model call: ${display.provider}/${display.modelId}.`, "info");
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
		if (loaded.warning && !stateWarningShown) {
			stateWarningShown = true;
			ctx.ui.notify(loaded.warning, "warning");
		}
		if (catalogWarning && !catalogWarningShown) {
			catalogWarningShown = true;
			ctx.ui.notify(catalogWarning, "warning");
		}
		const current = modelReference(ctx.model, catalog);
		previous = previousModelStack(ctx.sessionManager.getBranch(), current);
		pendingDispatch = current;
	};

	const extension: InlineExtension = {
		name: "jouzu-model-picker",
		factory: (pi) => {
			setModel = (model) => pi.setModel(model);
			pi.registerCommand?.("catalogs", {
				description: "Open Jouzu catalog settings",
				handler: async (_args, ctx) => {
					if (ctx.mode !== "tui" || !(await openSettings())) {
						ctx.ui.notify("Catalog settings require interactive TUI mode.", "warning");
					}
				},
			});
			pi.on("session_start", async (event, ctx) => {
				syncSession(ctx);
				if (
					(event.reason !== "startup" && event.reason !== "new") ||
					hasConversationEntries(ctx.sessionManager.getBranch()) ||
					ctx.scopedModels.length > 0
				)
					return;
				const projectReference =
					options.applyProjectDefaultAtStartup === true ? state.defaults.projects[projectKey] : undefined;
				const lastUsed =
					options.restoreLastModelAtStartup === true ? (state.last ?? state.recents.global[0]) : undefined;
				const reference = projectReference ?? lastUsed;
				if (!reference || modelReferencesEqual(reference, modelReference(ctx.model, catalog))) return;
				const label = projectReference ? "Project default" : "Last used model";
				const model = ctx.modelRegistry.find(reference.provider, reference.modelId);
				if (!model) {
					ctx.ui.notify(`${label} is unavailable: ${reference.provider}/${reference.modelId}`, "warning");
					return;
				}
				try {
					if (!(await pi.setModel(model))) {
						ctx.ui.notify(`${label} is not authenticated: ${reference.provider}/${reference.modelId}`, "warning");
						return;
					}
				} catch (error) {
					ctx.ui.notify(
						`${label} was not applied: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
					return;
				}
				const thinkingLevel =
					!projectReference && state.last && modelReferencesEqual(state.last, reference)
						? state.last.thinkingLevel
						: undefined;
				if (thinkingLevel) {
					try {
						pi.setThinkingLevel(thinkingLevel);
					} catch (error) {
						ctx.ui.notify(
							`Saved thinking level was not applied: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
						);
					}
				}
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
			});
			pi.on("thinking_level_select", (event, ctx) => {
				activeCtx = ctx;
				const current = modelReference(ctx.model, catalog);
				if (!current || !state.last || !modelReferencesEqual(state.last, current)) return;
				try {
					state = store.setLastThinkingLevel(current, event.level);
				} catch (error) {
					ctx.ui.notify(
						`Thinking level was not saved: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
				}
			});
			pi.on("before_provider_request", (_event, ctx) => {
				activeCtx = ctx;
				const dispatched = modelReference(ctx.model, catalog);
				if (!dispatched || !pendingDispatch || !modelReferencesEqual(dispatched, pendingDispatch)) return;
				try {
					state = store.recordDispatch(dispatched, projectKey, { thinkingLevel: ctx.thinkingLevel });
					pendingDispatch = undefined;
				} catch (error) {
					ctx.ui.notify(
						`Model recency was not saved: ${error instanceof Error ? error.message : String(error)}`,
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
					if (!(await activateModel(queued.model))) {
						throw new Error(`No authentication for ${display.provider}/${display.modelId}`);
					}
					if (queued.setProjectDefault) state = store.setProjectDefault(queued.reference, projectKey);
					ctx.ui.notify(`Switched to ${display.provider}/${display.modelId}.`, "info");
				} catch (error) {
					ctx.ui.notify(
						`Queued model switch failed: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
						"warning",
					);
				}
			});
			pi.on("session_shutdown", () => {
				activeCtx = undefined;
				pendingDispatch = undefined;
				queuedModelSwitch = undefined;
				cycleBusy = false;
				setModel = undefined;
			});
		},
	};

	const openPalette = async (route: PaletteRoute): Promise<boolean> => {
		const ctx = activeCtx;
		const activateModel = setModel;
		if (!ctx || ctx.mode !== "tui" || !activateModel) return false;
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
								initialFilter: state.filter,
								getRows: (query, filter) =>
									buildPickerRows({
										models: pickerModels(ctx, catalogs),
										state,
										projectKey,
										current: modelReference(ctx.model, catalog),
										previous,
										query,
										filter,
										activeContextTokens: ctx.getContextUsage()?.tokens,
									}),
								onSelect: async (row, scope) => {
									const model = ctx.modelRegistry.find(row.model.provider, row.model.modelId);
									if (!model) throw new Error(`Model is unavailable: ${row.model.provider}/${row.model.modelId}`);
									if (!ctx.isIdle()) {
										queueModelSwitch(ctx, model, row.model, scope === "project");
										return;
									}
									if (!(await activateModel(model)))
										throw new Error(`No authentication for ${row.model.provider}/${row.model.modelId}`);
									if (scope === "project") state = store.setProjectDefault(row.model, projectKey);
								},
								onToggleFavorite: (row) => {
									state = store.toggleFavorite(row.model);
								},
								onFilterChange: (filter) => {
									state = store.setFilter(filter);
								},
								onRefresh: async (signal) => {
									const result = await ctx.modelRegistry.refresh({ signal });
									if (result.errors.size > 0) {
										throw new Error(`could not refresh ${[...result.errors.keys()].join(", ")}`);
									}
									if (result.aborted) throw new Error("model refresh was aborted");
								},
							}),
						settings: (childContext) =>
							new CatalogSettingsComponent({
								context: childContext,
								paths,
								env: catalogEnv,
								onCatalogsChanged: reloadCatalogs,
							}),
					},
				}),
			options.palette,
		);
	};

	const open = async (request: JouzuModelPickerRequest): Promise<boolean> =>
		openPalette({ view: "models", ...(request.initialSearchInput ? { query: request.initialSearchInput } : {}) });

	const openSettings = async (): Promise<boolean> => openPalette({ view: "settings" });

	const cycleFavorite = async (direction: FavoriteCycleDirection): Promise<boolean> => {
		const ctx = activeCtx;
		const activateModel = setModel;
		if (!ctx || ctx.mode !== "tui" || !activateModel) return false;
		if (cycleBusy) {
			ctx.ui.notify("A favorite model switch is already in progress.", "info");
			return true;
		}
		const current = queuedModelSwitch?.reference ?? modelReference(ctx.model, catalog);
		const favoriteRows = buildPickerRows({
			models: pickerModels(ctx, catalogs),
			state,
			projectKey,
			current,
			filter: "favorite",
			activeContextTokens: ctx.getContextUsage()?.tokens,
		});
		if (favoriteRows.length === 0) {
			ctx.ui.notify("No favorite models. Open Models with Ctrl+L and press Space in browse mode to add one.", "info");
			return true;
		}
		const availableRows = favoriteRows.filter((row) => row.model.available);
		const candidates = availableRows.filter((row) => row.contextFit !== "too-small");
		if (candidates.length === 0) {
			ctx.ui.notify(
				availableRows.length === 0
					? "No favorite models are available in the current model scope."
					: "No favorite model can fit the active context. Open Models with Ctrl+L for details.",
				"warning",
			);
			return true;
		}
		const currentIndex = candidates.findIndex((row) => modelReferencesEqual(row.model, current));
		if (candidates.length === 1 && currentIndex === 0) {
			ctx.ui.notify("Only one favorite model is available.", "info");
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
		const model = ctx.modelRegistry.find(target.provider, target.modelId);
		if (!model) {
			ctx.ui.notify(
				`Favorite model is unavailable: ${modelDisplay(target).provider}/${modelDisplay(target).modelId}`,
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
					`No authentication for ${modelDisplay(target).provider}/${modelDisplay(target).modelId}`,
					"warning",
				);
				return true;
			}
			ctx.ui.notify(`Switched to ${modelDisplay(target).provider}/${modelDisplay(target).modelId}.`, "info");
		} catch (error) {
			ctx.ui.notify(
				`Favorite model switch failed: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`,
				"warning",
			);
		} finally {
			cycleBusy = false;
		}
		return true;
	};

	const handleScopedModelsCommand = async (): Promise<boolean> => {
		const ctx = activeCtx;
		if (!ctx || ctx.mode !== "tui") return false;
		ctx.ui.notify(
			"Jouzu uses Favorites for quick switching. Open Models with Ctrl+L and press Space in browse mode to edit them.",
			"info",
		);
		return true;
	};

	return { extension, open, openSettings, cycleFavorite, handleScopedModelsCommand };
}
