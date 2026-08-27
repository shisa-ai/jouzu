import type { ExtensionContext, InlineExtension, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, Input, matchesKey, type TUI } from "@earendil-works/pi-tui";
import type { CatalogModelOffering, ModelCatalogDocument } from "./model-catalog.js";
import { loadActiveModelCatalog } from "./model-catalog-sync.js";
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
	JouzuPaletteSurfaceHost,
	type PaletteComponent,
	type PaletteComponentContext,
	type PaletteRoute,
	type PaletteSurfaceOptions,
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
		this.recomputeFilterCounts();
		this.recomputeRows();
		if (options.onRefresh) void this.refresh(options.onRefresh);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	route(route: PaletteRoute): void {
		if (route.view !== "models") return;
		if (route.query !== undefined) this.searchInput.setValue(route.query);
		this.recomputeFilterCounts();
		this.recomputeRows();
		this.tui.requestRender();
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
			this.close();
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
		if (matchesKey(data, "home")) {
			this.moveSelection(-Number.MAX_SAFE_INTEGER);
			return;
		}
		if (matchesKey(data, "end")) {
			this.moveSelection(Number.MAX_SAFE_INTEGER);
			return;
		}
		if (matchesKey(data, "tab")) {
			this.cycleFilter(1);
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.cycleFilter(-1);
			return;
		}
		if (matchesKey(data, "shift+enter")) {
			this.runSelection("project");
			return;
		}
		if (matchesKey(data, "ctrl+f")) {
			this.toggleFavorite();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.runSelection("session");
			return;
		}
		this.searchInput.handleInput(data);
		this.message = undefined;
		this.recomputeRows();
		this.tui.requestRender();
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
		const text = `${marker} ${favorite}${projectDefault} ${styledIdentity}${availability}${fit}`;
		return selected ? this.theme.bg("selectedBg", text) : text;
	}

	render(width: number): string[] {
		const title = `${this.wordmark} ${this.theme.bold(this.styles.apply("palette.title", "· Models"))} ${this.styles.apply("palette.count", `${this.rows.length}/${this.filterCounts.all}`)}`;
		if (width < 12) return [fitTerminalText(title, Math.max(1, width))];
		const innerWidth = Math.max(1, width - 4);
		const terminalRows = Number(this.tui.terminal?.rows ?? 24);
		const rowCapacity = Math.max(3, Math.min(12, terminalRows - 15));
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(rowCapacity / 2), Math.max(0, this.rows.length - rowCapacity)),
		);
		const visibleRows = this.rows.slice(start, start + rowCapacity);
		const selected = this.rows[this.selectedIndex];
		const border = (value: string) => this.styles.apply("palette.border", value);
		const frameOptions = { border };
		const line = (value = "") => renderTerminalFrameRow(value, width, frameOptions);
		const tabs = FILTERS.map((filter) => {
			const label = `${FILTER_LABELS[filter]} ${this.filterCounts[filter]}`;
			return filter === this.filter
				? this.theme.bg("selectedBg", this.styles.apply("palette.tab.active", ` ${label} `))
				: ` ${label} `;
		}).join("  ");
		const lines = [
			renderTerminalFrameTitle(title, width, frameOptions),
			line(tabs),
			line(this.searchInput.render(innerWidth)[0] ?? ""),
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
			lines.push(
				line(
					this.styles.apply(
						this.message.level === "error" ? "palette.message.error" : "palette.message.info",
						this.message.text,
					),
				),
			);
		} else {
			lines.push(line(this.styles.apply("palette.hint", "Enter session · Shift+Enter project default · Tab filter")));
		}
		lines.push(line(this.styles.apply("palette.hint", "Ctrl+F favorite · ↑↓ move · type search · Esc close")));
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
): PickerModel {
	const offering = catalogOffering(catalog, model.provider, model.id);
	return {
		...(offering && catalog ? { catalogId: catalog.catalogId, offeringId: offering.id } : {}),
		provider: model.provider,
		modelId: model.id,
		name: offering?.name ?? model.name,
		contextWindow: offering?.limits?.contextWindow ?? model.contextWindow,
		maxTokens: offering?.limits?.maxOutputTokens ?? model.maxTokens,
		available: offering?.availability?.status !== "unavailable",
	};
}

function pickerModels(ctx: ExtensionContext, catalog?: ModelCatalogDocument): PickerModel[] {
	const models =
		ctx.scopedModels.length > 0 ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable();
	return models.map((model) => catalogPickerModel(model, catalog));
}

export function createJouzuModelPicker(
	paths: JouzuPaths,
	options: JouzuModelPickerOptions = {},
): JouzuModelPickerIntegration {
	const store = new ModelPickerStore(paths);
	const surface = new JouzuPaletteSurfaceHost();
	let catalog: ModelCatalogDocument | undefined;
	let catalogWarning: string | undefined;
	try {
		catalog = loadActiveModelCatalog(paths);
	} catch (error) {
		catalogWarning = `Cached model catalog was ignored: ${error instanceof Error ? error.message : String(error)}`;
	}
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
			pi.on("session_start", async (event, ctx) => {
				syncSession(ctx);
				const applyProjectDefault =
					options.applyProjectDefaultAtStartup === true && (event.reason === "startup" || event.reason === "new");
				if (
					!applyProjectDefault ||
					hasConversationEntries(ctx.sessionManager.getBranch()) ||
					ctx.scopedModels.length > 0
				)
					return;
				const reference = state.defaults.projects[projectKey];
				if (!reference || modelReferencesEqual(reference, modelReference(ctx.model, catalog))) return;
				const model = ctx.modelRegistry.find(reference.provider, reference.modelId);
				if (!model) {
					ctx.ui.notify(`Project default is unavailable: ${reference.provider}/${reference.modelId}`, "warning");
					return;
				}
				try {
					if (!(await pi.setModel(model))) {
						ctx.ui.notify(
							`Project default is not authenticated: ${reference.provider}/${reference.modelId}`,
							"warning",
						);
					}
				} catch (error) {
					ctx.ui.notify(
						`Project default was not applied: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
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
			pi.on("before_provider_request", (_event, ctx) => {
				activeCtx = ctx;
				const dispatched = modelReference(ctx.model, catalog);
				if (!dispatched || !pendingDispatch || !modelReferencesEqual(dispatched, pendingDispatch)) return;
				try {
					state = store.recordDispatch(dispatched, projectKey);
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

	const open = async (request: JouzuModelPickerRequest): Promise<boolean> => {
		const ctx = activeCtx;
		const activateModel = setModel;
		if (!ctx || ctx.mode !== "tui" || !activateModel) return false;
		return surface.open(
			ctx,
			{ view: "models", ...(request.initialSearchInput ? { query: request.initialSearchInput } : {}) },
			(componentContext, route) =>
				new ModelPickerComponent({
					context: componentContext,
					initialRoute: route,
					initialFilter: state.filter,
					getRows: (query, filter) =>
						buildPickerRows({
							models: pickerModels(ctx, catalog),
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
			options.palette,
		);
	};

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
			models: pickerModels(ctx, catalog),
			state,
			projectKey,
			current,
			filter: "favorite",
			activeContextTokens: ctx.getContextUsage()?.tokens,
		});
		if (favoriteRows.length === 0) {
			ctx.ui.notify("No favorite models. Open Models with Ctrl+L and press Ctrl+F to add one.", "info");
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
			"Jouzu uses Favorites for quick switching. Open Models with Ctrl+L and press Ctrl+F to edit them.",
			"info",
		);
		return true;
	};

	return { extension, open, cycleFavorite, handleScopedModelsCommand };
}
