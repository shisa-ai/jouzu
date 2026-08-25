import type { ExtensionContext, InlineExtension, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, Input, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { buildPickerRows, type PickerFilter, type PickerModel, type PickerRow } from "./model-picker-ranking.js";
import {
	deriveProjectKey,
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
} from "./palette.js";
import type { JouzuPaths } from "./paths.js";
import { detectBannerColorMode, renderBrandAccent, renderBrandGradient } from "./presentation.js";
import {
	fitTerminalText,
	padTerminalText,
	renderTerminalFrameBorder,
	renderTerminalFrameRow,
	renderTerminalFrameTitle,
} from "./terminal-layout.js";

type PiModel = NonNullable<ExtensionContext["model"]>;

export interface JouzuModelPickerRequest {
	source: "action" | "command";
	initialSearchInput?: string;
}

export interface JouzuModelPickerOptions {
	applyProjectDefaultAtStartup?: boolean;
}

export interface ModelPickerComponentOptions {
	context: PaletteComponentContext;
	initialRoute: PaletteRoute;
	getRows(query: string, filter: PickerFilter): PickerRow[];
	onSelect(row: PickerRow, scope: "session" | "project"): Promise<void>;
	onToggleFavorite(row: PickerRow, scope: "project" | "global"): void;
	onRefresh(): Promise<void>;
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

export class ModelPickerComponent implements PaletteComponent, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly close: () => void;
	private readonly getRows: (query: string, filter: PickerFilter) => PickerRow[];
	private readonly onSelect: (row: PickerRow, scope: "session" | "project") => Promise<void>;
	private readonly onToggleFavorite: (row: PickerRow, scope: "project" | "global") => void;
	private readonly onRefresh: () => Promise<void>;
	private readonly searchInput = new Input();
	private rows: PickerRow[] = [];
	private filter: PickerFilter = "recent";
	private filterCounts: Record<PickerFilter, number> = { recent: 0, favorite: 0, all: 0 };
	private selectedIndex = 0;
	private busy = false;
	private message?: { level: "error" | "info"; text: string };
	private disposed = false;
	private _focused = false;

	constructor(options: ModelPickerComponentOptions) {
		this.tui = options.context.tui;
		this.theme = options.context.theme;
		this.keybindings = options.context.keybindings;
		this.close = options.context.close;
		this.getRows = options.getRows;
		this.onSelect = options.onSelect;
		this.onToggleFavorite = options.onToggleFavorite;
		this.onRefresh = options.onRefresh;
		this.searchInput.setValue(options.initialRoute.query ?? "");
		this.recomputeRows();
		void this.refresh();
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
		this.recomputeRows();
		this.tui.requestRender();
	}

	private recomputeRows(): void {
		const selectedKey = this.rows[this.selectedIndex]
			? modelReferenceKey(this.rows[this.selectedIndex].model)
			: undefined;
		const query = this.searchInput.getValue();
		this.rows = this.getRows(query, this.filter);
		this.filterCounts = {
			recent: this.getRows("", "recent").length,
			favorite: this.getRows("", "favorite").length,
			all: this.getRows("", "all").length,
		};
		const retainedIndex = selectedKey ? this.rows.findIndex((row) => modelReferenceKey(row.model) === selectedKey) : -1;
		this.selectedIndex =
			retainedIndex >= 0 ? retainedIndex : Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
	}

	private async refresh(): Promise<void> {
		try {
			await this.onRefresh();
			if (this.disposed) return;
			this.recomputeRows();
			this.tui.requestRender();
		} catch (error) {
			if (this.disposed) return;
			this.message = {
				level: "error",
				text: `Model refresh failed; showing cached models: ${error instanceof Error ? error.message : String(error)}`,
			};
			this.tui.requestRender();
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
		this.message = { level: "info", text: `Selecting ${row.model.provider}/${row.model.modelId}…` };
		this.tui.requestRender();
		void this.onSelect(row, scope)
			.then(() => this.close())
			.catch((error) => {
				if (this.disposed) return;
				this.busy = false;
				this.message = { level: "error", text: error instanceof Error ? error.message : String(error) };
				this.tui.requestRender();
			});
	}

	private toggleFavorite(scope: "project" | "global"): void {
		const row = this.rows[this.selectedIndex];
		if (!row || this.busy) return;
		try {
			this.onToggleFavorite(row, scope);
			this.message = {
				level: "info",
				text: `${scope === "project" ? "Project" : "Global"} favorite updated.`,
			};
			this.recomputeRows();
			this.tui.requestRender();
		} catch (error) {
			this.message = { level: "error", text: error instanceof Error ? error.message : String(error) };
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
			this.toggleFavorite("global");
			return;
		}
		if (matchesKey(data, "alt+f")) {
			this.toggleFavorite("project");
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
		const colorMode = detectBannerColorMode();
		const marker = selected ? renderBrandAccent("→", "blue", colorMode) : " ";
		const favorite = row.favoriteScopes.length > 0 ? this.theme.fg("warning", "★") : " ";
		const projectDefault = row.projectDefault ? this.theme.fg("success", "◆") : " ";
		const identity = `${row.model.provider}/${row.model.modelId}`;
		const availability = row.model.available ? "" : this.theme.fg("error", " unavailable");
		const fit = row.contextFit === "too-small" ? this.theme.fg("warning", " context-small") : "";
		const styledIdentity = selected ? renderBrandAccent(identity, "blue", colorMode) : this.theme.fg("text", identity);
		const text = `${marker} ${favorite}${projectDefault} ${styledIdentity}${availability}${fit}`;
		return selected ? this.theme.bg("selectedBg", text) : text;
	}

	render(width: number): string[] {
		const wordmark = renderBrandGradient("JOUZU", detectBannerColorMode());
		const title = `${wordmark} ${this.theme.bold(this.theme.fg("accent", "· Models"))} ${this.theme.fg("muted", `${this.rows.length}/${this.filterCounts.all}`)}`;
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
		const border = (value: string) => this.theme.fg("borderAccent", value);
		const frameOptions = { border };
		const line = (value = "") => renderTerminalFrameRow(value, width, frameOptions);
		const tabs = FILTERS.map((filter) => {
			const label = `${FILTER_LABELS[filter]} ${this.filterCounts[filter]}`;
			return filter === this.filter ? this.theme.bg("selectedBg", this.theme.fg("accent", ` ${label} `)) : ` ${label} `;
		}).join("  ");
		const lines = [
			renderTerminalFrameTitle(title, width, frameOptions),
			line(tabs),
			line(this.searchInput.render(innerWidth)[0] ?? ""),
		];
		if (selected) {
			const defaultLabel = selected.projectDefault ? " · project default" : "";
			const name = renderBrandAccent(selected.model.name, "blue", detectBannerColorMode());
			const detail = ` ${name} · context ${compactNumber(selected.model.contextWindow)} · max ${compactNumber(selected.model.maxTokens)}${defaultLabel}`;
			lines.push(line(this.theme.bg("selectedBg", padTerminalText(fitTerminalText(detail, innerWidth), innerWidth))));
		} else {
			lines.push(line(this.theme.bg("selectedBg", padTerminalText(" No model selected", innerWidth))));
		}
		lines.push(line());
		if (visibleRows.length === 0) lines.push(line(this.theme.fg("muted", "No matching models")));
		for (let offset = 0; offset < visibleRows.length; offset += 1) {
			const index = start + offset;
			const row = visibleRows[offset];
			const sectionText = padTerminalText(SECTION_LABELS[row.section], 8);
			const section =
				row.section === "current"
					? renderBrandAccent(sectionText, "pink", detectBannerColorMode())
					: this.theme.fg("muted", sectionText);
			lines.push(line(`${section}${this.rowText(row, index === this.selectedIndex)}`));
		}
		while (lines.length < rowCapacity + 6) lines.push(line());
		if (this.message) {
			lines.push(line(this.theme.fg(this.message.level === "error" ? "error" : "muted", this.message.text)));
		} else {
			lines.push(line(this.theme.fg("dim", "Enter session · Shift+Enter project default · Tab filter")));
		}
		lines.push(line(this.theme.fg("dim", "Ctrl+F/Alt+F favorite · ↑↓ move · type search · Esc close")));
		lines.push(renderTerminalFrameBorder(width, { ...frameOptions, left: "╰", right: "╯" }));
		return lines.map((value) => fitTerminalText(value, width));
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	dispose(): void {
		this.disposed = true;
	}
}

export interface JouzuModelPickerIntegration {
	extension: InlineExtension;
	open(request: JouzuModelPickerRequest): Promise<boolean>;
}

function modelReference(model: PiModel | undefined): ModelReference | undefined {
	return model ? { provider: model.provider, modelId: model.id } : undefined;
}

function pickerModels(ctx: ExtensionContext): PickerModel[] {
	const models =
		ctx.scopedModels.length > 0 ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable();
	return models.map((model) => ({
		provider: model.provider,
		modelId: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		available: true,
	}));
}

export function createJouzuModelPicker(
	paths: JouzuPaths,
	options: JouzuModelPickerOptions = {},
): JouzuModelPickerIntegration {
	const store = new ModelPickerStore(paths);
	const surface = new JouzuPaletteSurfaceHost();
	let activeCtx: ExtensionContext | undefined;
	let state: ModelPickerState = store.load().state;
	let projectKey = "";
	let previous: ModelReference[] = [];
	let pendingDispatch: ModelReference | undefined;
	let stateWarningShown = false;
	let setModel: ((model: PiModel) => Promise<boolean>) | undefined;

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
		const current = modelReference(ctx.model);
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
					event.reason === "new" || (event.reason === "startup" && options.applyProjectDefaultAtStartup === true);
				if (!applyProjectDefault || ctx.sessionManager.getBranch().length > 0 || ctx.scopedModels.length > 0) return;
				const reference = state.defaults.projects[projectKey];
				if (!reference || modelReferencesEqual(reference, modelReference(ctx.model))) return;
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
				const old = modelReference(event.previousModel);
				if (old) {
					previous = [old, ...previous.filter((reference) => !modelReferencesEqual(reference, old))].slice(
						0,
						MODEL_PICKER_HISTORY_LIMIT,
					);
				}
				pendingDispatch = modelReference(event.model);
			});
			pi.on("before_provider_request", (_event, ctx) => {
				activeCtx = ctx;
				const dispatched = modelReference(ctx.model);
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
			pi.on("session_shutdown", () => {
				activeCtx = undefined;
				pendingDispatch = undefined;
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
					getRows: (query, filter) =>
						buildPickerRows({
							models: pickerModels(ctx),
							state,
							projectKey,
							current: modelReference(ctx.model),
							previous,
							query,
							filter,
							activeContextTokens: ctx.getContextUsage()?.tokens,
						}),
					onSelect: async (row, scope) => {
						if (!ctx.isIdle()) throw new Error("Wait for the active model call to finish before switching models.");
						const model = ctx.modelRegistry.find(row.model.provider, row.model.modelId);
						if (!model) throw new Error(`Model is unavailable: ${row.model.provider}/${row.model.modelId}`);
						if (scope === "project") state = store.setProjectDefault(row.model, projectKey);
						if (!(await activateModel(model)))
							throw new Error(`No authentication for ${row.model.provider}/${row.model.modelId}`);
					},
					onToggleFavorite: (row, scope) => {
						state = store.toggleFavorite(row.model, scope, scope === "project" ? projectKey : undefined);
					},
					onRefresh: async () => {
						const result = await ctx.modelRegistry.refresh({ signal: AbortSignal.timeout(15_000) });
						if (result.errors.size > 0) {
							throw new Error(`could not refresh ${[...result.errors.keys()].join(", ")}`);
						}
					},
				}),
		);
	};

	return { extension, open };
}
