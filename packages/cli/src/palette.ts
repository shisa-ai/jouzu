import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	matchesKey,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { CatalogMessageId, catalogText, defaultCatalog } from "./cli-messages.js";
import { createJouzuKeybindingsManagerFromConfig, type JouzuKeybindingsManager } from "./jouzu-keybindings.js";
import type { CatalogBundle } from "./locale-catalog.js";
import {
	createSessionUiStyles,
	fillTerminalColumns,
	fitTerminalText,
	padTerminalText,
	renderTerminalFrameBorder,
	type SessionUiStyleRole,
	type SessionUiStyles,
	terminalTextWidth,
} from "./session-ui/index.js";

export type PaletteViewId = "models" | "workflow" | "settings" | "usage" | "keys" | "help" | "side";
export type PalettePresentation = "floating" | "replace";

export interface PaletteRoute {
	view: PaletteViewId;
	query?: string;
	/** Restored retained state; the view must not grab extra focus for it. */
	resume?: boolean;
}

export interface PaletteComponent extends Component {
	route(route: PaletteRoute): void;
	/** State worth keeping while the user visits another section. */
	snapshotRoute?(): PaletteRoute;
	allowsGlobalNavigation?(): boolean;
	dispose?(): void;
}

export interface PaletteComponentContext {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	jouzuKeybindings: JouzuKeybindingsManager;
	/** Jouzu-owned semantic colors. Views style through these roles rather than emitting escapes. */
	styles: SessionUiStyles;
	/**
	 * The resolved catalog a view renders its human text from. It is resolved once
	 * when the Palette opens, so a view formats an ID and never re-resolves the
	 * locale while the user is inside the Palette.
	 */
	catalog: CatalogBundle;
	close(): void;
}

export type PaletteComponentFactory = (context: PaletteComponentContext, route: PaletteRoute) => PaletteComponent;

export const PALETTE_TABS = [
	{ view: "models", label: CatalogMessageId.paletteTabModels },
	{ view: "workflow", label: CatalogMessageId.paletteTabWorkflow },
	{ view: "settings", label: CatalogMessageId.paletteTabSettings },
] as const satisfies ReadonlyArray<{ view: PaletteViewId; label: string }>;

/**
 * Tab cells keep one width whether or not they are active, so switching
 * sections never shifts the labels beside the active one. The brackets carry
 * the active state without color, for terminals that render none.
 */
export function renderPaletteTabs(
	activeView: PaletteViewId,
	theme: Theme,
	styles: SessionUiStyles,
	catalog: CatalogBundle = defaultCatalog(),
): string {
	return PALETTE_TABS.map(({ view, label: id }) => {
		const label = catalogText(catalog, id);
		return view === activeView
			? theme.bg("selectedBg", theme.bold(styles.apply("palette.tab.active", `[${label}]`)))
			: styles.apply("palette.tab.inactive", ` ${label} `);
	}).join("  ");
}

/** Abbreviate a count for a column that has no room for every digit. */
export function compactNumber(value: number | undefined, catalog: CatalogBundle = defaultCatalog()): string {
	if (value === undefined) return catalogText(catalog, CatalogMessageId.paletteValueUnknown);
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
	if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
	return String(value);
}

/** Total frame rows, matching the overlay's 90% cap and one-row outer margins. */
export function paletteHeightBudget(rows: number): number {
	const height = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;
	return Math.max(1, Math.min(height - 2, Math.floor(height * 0.9)));
}

export interface PaletteViewport {
	/** Zero-based index of the first visible row. */
	start: number;
	/** Zero-based exclusive end of the visible rows. */
	end: number;
	/** Rows the viewport can show. */
	capacity: number;
	/** Rows actually available, at most {@link capacity}. */
	visible: number;
	hasAbove: boolean;
	hasBelow: boolean;
}

/**
 * Center the selected row in a bounded viewport while keeping the window inside
 * the collection. A long pane scrolls instead of hiding its tail behind a fixed
 * row cap, and a short terminal still keeps the selection visible.
 */
export function paletteViewport(total: number, selectedIndex: number, capacity: number): PaletteViewport {
	const count = Math.max(0, Number.isFinite(total) ? Math.floor(total) : 0);
	const rows = Math.max(1, Number.isFinite(capacity) ? Math.floor(capacity) : 1);
	const selected = Math.max(
		0,
		Math.min(Number.isFinite(selectedIndex) ? Math.floor(selectedIndex) : 0, Math.max(0, count - 1)),
	);
	const visible = Math.min(rows, count);
	const start = count === 0 ? 0 : Math.max(0, Math.min(selected - Math.floor(rows / 2), count - rows));
	const end = Math.min(count, start + rows);
	return { start, end, capacity: rows, visible, hasAbove: start > 0, hasBelow: end < count };
}

/**
 * One right-edge scrollbar cell. Arrows name content hidden above or below; the
 * filled thumb shows the position inside the collection.
 */
export function paletteScrollbarMarker(index: number, viewport: PaletteViewport, total: number): string {
	const count = Math.max(0, Number.isFinite(total) ? Math.floor(total) : 0);
	if (count <= viewport.visible) return "│";
	if (viewport.visible === 1 && viewport.hasAbove && viewport.hasBelow) return "↕";
	if (viewport.hasAbove && index === 0) return "▲";
	if (viewport.hasBelow && index === viewport.visible - 1) return "▼";
	if (viewport.visible <= 2) return "│";
	const thumbSize = Math.max(1, Math.round((viewport.visible * viewport.visible) / count));
	const travel = Math.max(0, viewport.visible - thumbSize);
	const maxStart = Math.max(1, count - viewport.visible);
	const thumbStart = Math.round((viewport.start / maxStart) * travel);
	return index >= thumbStart && index < thumbStart + thumbSize ? "█" : "│";
}

/** A framed list row whose right edge carries a scrollbar cell. */
export function renderPaletteScrollbarRow(
	value: string,
	width: number,
	styles: SessionUiStyles,
	marker: string,
): string {
	const target = Math.max(1, Math.floor(width));
	if (target < 5) return fitTerminalText(`${value} ${marker}`, target);
	const innerWidth = paletteInnerWidth(target);
	const body = padTerminalText(fitTerminalText(value, innerWidth), innerWidth);
	const scrollbar = styles.apply(marker === "│" ? "palette.border" : "palette.marker", marker);
	return `${styles.apply("palette.border", "│")} ${body} ${scrollbar}`;
}

/** Inner columns a framed row offers: one border and one pad column per side. */
export function paletteInnerWidth(width: number): number {
	return Math.max(1, width - 4);
}

/** A horizontal divider that joins the frame's left and right edges. */
export function renderPaletteDivider(width: number, styles: SessionUiStyles): string {
	const border = (value: string) => styles.apply("palette.border", value);
	return renderTerminalFrameBorder(width, { border, left: "├", right: "┤" });
}

/** A left/right choice control. One chevron pair is used across every view. */
export function paletteChoice(value: string): string {
	return `‹ ${value} ›`;
}

/**
 * Paint a row across the full inner width so the selection reads as one band
 * rather than a highlight that stops at the end of the text.
 */
export function renderPaletteBand(value: string, innerWidth: number, theme: Theme): string {
	return theme.bg("selectedBg", padTerminalText(fitTerminalText(value, innerWidth), innerWidth));
}

/**
 * A section heading with a rule that runs to the right edge, optionally
 * closing on right-aligned metadata. Rules give the stacked groups inside one
 * frame a visible boundary without spending a blank line on each.
 */
export function renderPaletteHeading(
	label: string,
	innerWidth: number,
	theme: Theme,
	styles: SessionUiStyles,
	meta = "",
): string {
	const heading = theme.bold(styles.apply("palette.heading", label));
	const trailing = meta ? styles.apply("palette.count", meta) : "";
	const fill = innerWidth - terminalTextWidth(label) - (meta ? terminalTextWidth(meta) + 2 : 1);
	if (fill < 1) return fitTerminalText(`${heading} ${trailing}`, innerWidth);
	const rule = styles.apply("palette.rule", fillTerminalColumns("─", fill));
	return meta ? `${heading} ${rule} ${trailing}` : `${heading} ${rule}`;
}

export interface PaletteFieldOptions {
	label: string;
	/** Second column. Leave unset for an action row that carries no value. */
	value?: string;
	/** Right-aligned third column: a disclosure chevron or a trailing detail. */
	meta?: string;
	/** Zero leaves the label unpadded, for rows with no value column. */
	labelWidth: number;
	/**
	 * Override the label color. Form rows read label-then-value, so the label is
	 * muted by default; list rows lead with an identity and pass a brighter role.
	 */
	labelRole?: SessionUiStyleRole;
	innerWidth: number;
	selected: boolean;
	theme: Theme;
	styles: SessionUiStyles;
}

/**
 * A row whose value column starts at the same terminal column on every row, so
 * a field list reads as aligned columns instead of ragged text. The optional
 * meta column is flushed right against the frame.
 */
export function renderPaletteField(options: PaletteFieldOptions): string {
	const { label, labelWidth, innerWidth, selected, theme, styles } = options;
	const value = options.value ?? "";
	const meta = options.meta ?? "";
	const marker = selected ? styles.apply("palette.marker", "→") : " ";
	// Pad to the column, but never truncate to it: a label is an identity, so an
	// outlier pushes its own value right rather than losing characters.
	const labelText = labelWidth > 0 ? padTerminalText(label, Math.max(labelWidth, terminalTextWidth(label))) : label;
	const styledLabel = selected
		? theme.bold(styles.apply(options.labelRole ?? "palette.value", labelText))
		: styles.apply(options.labelRole ?? (value ? "palette.label" : "palette.value"), labelText);
	const headWidth = 2 + terminalTextWidth(labelText);
	// The value keeps at least half of the room after the label; metadata
	// truncates to the remainder, so an unbounded detail (a run assignment)
	// can never hide a required value such as a run status.
	const available = Math.max(0, innerWidth - headWidth - 1);
	const valueFloor = available === 0 ? 0 : Math.max(1, Math.ceil(available / 2));
	const metaRoom = Math.max(0, available - valueFloor - 2); // separator and trailing space
	const fittedMeta = meta ? fitTerminalText(meta, metaRoom) : "";
	const metaColumns = fittedMeta ? terminalTextWidth(fittedMeta) : 0;
	const valueRoom = available === 0 ? 0 : Math.max(1, available - metaColumns - (fittedMeta ? 2 : 0));
	const fittedValue = value ? fitTerminalText(value, valueRoom) : "";
	const gap = Math.max(0, available - terminalTextWidth(fittedValue) - metaColumns - (fittedMeta ? 1 : 0));
	const text = `${marker} ${styledLabel} ${fittedValue}${" ".repeat(gap)}${
		fittedMeta ? `${styles.apply("palette.count", fittedMeta)} ` : ""
	}`;
	return selected ? renderPaletteBand(text, innerWidth, theme) : text;
}

export interface PaletteKeyHint {
	key: string;
	label: string;
}

/**
 * The footer key bar: a filled band of `key label` pairs, with the key in the
 * accent color. Unbound actions are dropped so a rebound keymap never
 * advertises a key the user cannot press.
 */
export function renderPaletteKeyBar(
	hints: readonly PaletteKeyHint[],
	innerWidth: number,
	theme: Theme,
	styles: SessionUiStyles,
	maxRows = Number.POSITIVE_INFINITY,
): string[] {
	const usable = hints.filter((hint) => hint.key !== "Unbound" && hint.key.length > 0);
	if (usable.length === 0 || maxRows < 1) return [];
	const lines: string[] = [];
	let plain = "";
	let styled = "";
	const flush = (): void => {
		if (!plain) return;
		for (const part of wrapTextWithAnsi(styled, Math.max(1, innerWidth))) {
			lines.push(theme.bg("selectedBg", padTerminalText(part, innerWidth)));
		}
		plain = "";
		styled = "";
	};
	for (const hint of usable) {
		const segment = `${hint.key} ${hint.label}`;
		const separator = plain ? "  " : " ";
		if (plain && terminalTextWidth(`${plain}${separator}${segment}`) > innerWidth) flush();
		const lead = plain ? "  " : " ";
		plain += `${lead}${segment}`;
		styled += `${lead}${theme.bold(styles.apply("palette.key", hint.key))} ${styles.apply("palette.value", hint.label)}`;
	}
	flush();
	if (lines.length > maxRows && usable.length > 2) {
		// Keep the primary action and cancellation; remove secondary hints first.
		usable.splice(usable.length - 2, 1);
		return renderPaletteKeyBar(usable, innerWidth, theme, styles, maxRows);
	}
	if (lines.length > maxRows) {
		// Wrapped labels may not fit. Keep the primary action and cancellation as
		// one fitted row each, rather than returning an arbitrary wrapped tail.
		const essential = usable.length > 1 ? [usable[0], usable[usable.length - 1]] : usable;
		const compact = essential.map((hint) =>
			theme.bg(
				"selectedBg",
				padTerminalText(fitTerminalText(`${hint.key} ${hint.label}`, innerWidth, "…"), innerWidth),
			),
		);
		if (compact.length <= maxRows) return compact;
		if (maxRows === 1) return [compact[compact.length - 1]];
		return [...compact.slice(0, maxRows - 1), compact[compact.length - 1]];
	}
	return lines;
}

export interface PaletteRouterOptions {
	context: PaletteComponentContext;
	initialRoute: PaletteRoute;
	factories: Partial<Record<PaletteViewId, PaletteComponentFactory>>;
}

function setComponentFocus(component: PaletteComponent | undefined, focused: boolean): void {
	if (component && "focused" in component) (component as PaletteComponent & Focusable).focused = focused;
}

export class JouzuPaletteRouter implements PaletteComponent, Focusable {
	private readonly context: PaletteComponentContext;
	private readonly factories: Partial<Record<PaletteViewId, PaletteComponentFactory>>;
	private readonly retainedRoutes = new Map<PaletteViewId, PaletteRoute>();
	private activeView: PaletteViewId;
	private component: PaletteComponent;
	private _focused = false;

	constructor(options: PaletteRouterOptions) {
		this.context = options.context;
		this.factories = options.factories;
		this.activeView = options.initialRoute.view;
		this.component = this.create(options.initialRoute);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		setComponentFocus(this.component, value);
	}

	private create(route: PaletteRoute): PaletteComponent {
		const factory = this.factories[route.view] ?? this.factories.models;
		if (!factory) throw new Error(`No Palette component is registered for ${route.view}`);
		const component = factory(this.context, route);
		setComponentFocus(component, this._focused);
		return component;
	}

	route(route: PaletteRoute): void {
		if (!this.activeViewAllowsGlobalNavigation()) return;
		if (route.view === this.activeView) {
			this.component.route(route);
			this.context.tui.requestRender();
			return;
		}
		const snapshot = this.component.snapshotRoute?.();
		if (snapshot) this.retainedRoutes.set(this.activeView, snapshot);
		this.component.dispose?.();
		this.activeView = route.view;
		const retained = route.query === undefined ? this.retainedRoutes.get(route.view) : undefined;
		this.component = this.create(retained ? { ...retained, resume: true } : route);
		this.context.tui.requestRender();
	}

	private activeViewAllowsGlobalNavigation(): boolean {
		return this.component.allowsGlobalNavigation?.() ?? true;
	}

	private cycleView(delta: number): void {
		const available = PALETTE_TABS.filter(({ view }) => Boolean(this.factories[view]));
		if (available.length < 2) return;
		const currentIndex = available.findIndex(({ view }) => view === this.activeView);
		const nextIndex = (Math.max(0, currentIndex) + delta + available.length) % available.length;
		this.route({ view: available[nextIndex].view });
	}

	handleInput(data: string): void {
		if (this.activeViewAllowsGlobalNavigation()) {
			if (matchesKey(data, "tab")) {
				this.cycleView(1);
				return;
			}
			if (matchesKey(data, "shift+tab")) {
				this.cycleView(-1);
				return;
			}
		}
		this.component.handleInput?.(data);
	}

	render(width: number): string[] {
		return this.component.render(width);
	}

	invalidate(): void {
		this.component.invalidate();
	}

	dispose(): void {
		this.component.dispose?.();
	}
}

export interface PaletteSurfaceOptions {
	presentation?: PalettePresentation;
	env?: NodeJS.ProcessEnv;
	columns?: number;
	rows?: number;
	/** Whether a floating Palette can hide inline images; defaults to checking the Pi TUI. */
	imageHiding?: boolean;
}

interface ActivePalette {
	token: object;
	component?: PaletteComponent;
	handle?: OverlayHandle;
	promise: Promise<void>;
}

export const DEFAULT_PALETTE_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "center",
	width: "82%",
	minWidth: 48,
	maxHeight: "90%",
	margin: 1,
};

function envPresentation(env: NodeJS.ProcessEnv): PalettePresentation | undefined {
	return env.JOUZU_PALETTE_PRESENTATION === "floating" || env.JOUZU_PALETTE_PRESENTATION === "replace"
		? env.JOUZU_PALETTE_PRESENTATION
		: undefined;
}

function terminalRendersInlineImages(env: NodeJS.ProcessEnv): boolean {
	if (env.TMUX || env.TERM?.toLowerCase().startsWith("tmux") || env.TERM?.toLowerCase().startsWith("screen"))
		return false;
	const termProgram = env.TERM_PROGRAM?.toLowerCase();
	const term = env.TERM?.toLowerCase();
	return Boolean(
		env.KITTY_WINDOW_ID ||
			env.GHOSTTY_RESOURCES_DIR ||
			env.WEZTERM_PANE ||
			env.WARP_SESSION_ID ||
			env.WARP_TERMINAL_SESSION_UUID ||
			env.ITERM_SESSION_ID ||
			termProgram === "kitty" ||
			termProgram === "ghostty" ||
			termProgram === "wezterm" ||
			termProgram === "warpterminal" ||
			termProgram === "iterm.app" ||
			term?.includes("ghostty"),
	);
}

// Pi detects inline images by these Kitty and iTerm2 sequence prefixes.
const INLINE_IMAGE_PREFIXES = ["\x1b_G", "\x1b]1337;File="];

type OverlayCompositor = (lines: string[], termWidth: number, termHeight: number) => string[];

/**
 * Terminals that show inline images draw them above text, so an image would
 * cover a floating Palette. Pi's renderers remove and redraw image placements
 * when an image line changes, so blanking image lines while the Palette is
 * open hides them and restores them on close. The hook is Pi's protected
 * overlay compositor; if a Pi upgrade removes it, the Palette falls back to
 * the replacement presentation on those terminals.
 */
function overlayImageHidingAvailable(): boolean {
	return [TuiAltScreen, TuiMainScreen].every(
		(type) => typeof (type.prototype as unknown as { compositeOverlays?: unknown }).compositeOverlays === "function",
	);
}

const imageHidingCompositors = new WeakSet<object>();
const imageHidingActive = new WeakSet<object>();

function installOverlayImageHiding(tui: TUI): boolean {
	if (imageHidingCompositors.has(tui)) return true;
	const target = tui as unknown as { compositeOverlays?: OverlayCompositor; hasOverlay?: () => boolean };
	const original = target.compositeOverlays;
	if (typeof original !== "function" || typeof target.hasOverlay !== "function") return false;
	target.compositeOverlays = function (this: unknown, lines, termWidth, termHeight) {
		const hide = imageHidingActive.has(tui) && target.hasOverlay?.() === true;
		const base = hide
			? lines.map((line) => (INLINE_IMAGE_PREFIXES.some((prefix) => line.includes(prefix)) ? "" : line))
			: lines;
		return original.call(this, base, termWidth, termHeight);
	};
	imageHidingCompositors.add(tui);
	return true;
}

export function selectPalettePresentation(options: PaletteSurfaceOptions = {}): PalettePresentation {
	const env = options.env ?? process.env;
	const explicit = options.presentation ?? envPresentation(env);
	if (explicit) return explicit;
	if (terminalRendersInlineImages(env) && !(options.imageHiding ?? overlayImageHidingAvailable())) return "replace";
	const columns = options.columns ?? process.stdout.columns ?? 80;
	const rows = options.rows ?? process.stdout.rows ?? 24;
	return columns >= 58 && rows >= 16 ? "floating" : "replace";
}

export class JouzuPaletteSurfaceHost {
	private active?: ActivePalette;
	private readonly jouzuKeybindings: JouzuKeybindingsManager;
	private readonly catalog: CatalogBundle;

	constructor(options?: { jouzuKeybindings?: JouzuKeybindingsManager; catalog?: CatalogBundle }) {
		// The default carries code defaults without user overrides; the product
		// wiring passes a manager loaded from the active keybindings.json.
		this.jouzuKeybindings = options?.jouzuKeybindings ?? createJouzuKeybindingsManagerFromConfig();
		// A caller without a resolved catalog (a unit test, for example) renders
		// English rather than a second copy of the text.
		this.catalog = options?.catalog ?? defaultCatalog();
	}

	isOpen(): boolean {
		return this.active !== undefined;
	}

	async open(
		ctx: ExtensionContext,
		route: PaletteRoute,
		factory: PaletteComponentFactory,
		options: PaletteSurfaceOptions = {},
	): Promise<boolean> {
		if (ctx.mode !== "tui") return false;
		if (this.active) {
			this.active.component?.route(route);
			this.active.handle?.focus();
			await this.active.promise;
			return true;
		}

		const token = {};
		let component: PaletteComponent | undefined;
		let handle: OverlayHandle | undefined;
		const presentation = selectPalettePresentation(options);
		const customOptions =
			presentation === "floating"
				? {
						overlay: true,
						overlayOptions: DEFAULT_PALETTE_OVERLAY_OPTIONS,
						onHandle: (value: OverlayHandle) => {
							handle = value;
							if (this.active?.token === token) this.active.handle = value;
						},
					}
				: undefined;

		let hidingTui: TUI | undefined;
		const promise = ctx.ui.custom<void>((tui, theme, keybindings, done) => {
			if (presentation === "floating" && installOverlayImageHiding(tui)) {
				imageHidingActive.add(tui);
				hidingTui = tui;
			}
			component = factory(
				{
					tui,
					theme,
					keybindings,
					jouzuKeybindings: this.jouzuKeybindings,
					styles: createSessionUiStyles(theme),
					catalog: this.catalog,
					close: () => done(undefined),
				},
				route,
			);
			if (this.active?.token === token) this.active.component = component;
			return component;
		}, customOptions);
		this.active = { token, component, handle, promise };
		try {
			await promise;
			return true;
		} finally {
			if (this.active?.token === token) this.active = undefined;
			if (hidingTui) {
				imageHidingActive.delete(hidingTui);
				// Redraw so hidden images return even if no other render is pending.
				hidingTui.requestRender();
			}
		}
	}
}
