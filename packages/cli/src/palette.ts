import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	matchesKey,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
} from "@earendil-works/pi-tui";
import { createJouzuKeybindingsManagerFromConfig, type JouzuKeybindingsManager } from "./jouzu-keybindings.js";
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

export type PaletteViewId = "models" | "workflow" | "settings" | "usage" | "keys" | "help";
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
	close(): void;
}

export type PaletteComponentFactory = (context: PaletteComponentContext, route: PaletteRoute) => PaletteComponent;

export const PALETTE_TABS = [
	{ view: "models", label: "Models" },
	{ view: "workflow", label: "Workflow" },
	{ view: "settings", label: "Settings" },
] as const satisfies ReadonlyArray<{ view: PaletteViewId; label: string }>;

/**
 * Tab cells keep one width whether or not they are active, so switching
 * sections never shifts the labels beside the active one. The brackets carry
 * the active state without color, for terminals that render none.
 */
export function renderPaletteTabs(activeView: PaletteViewId, theme: Theme, styles: SessionUiStyles): string {
	return PALETTE_TABS.map(({ view, label }) =>
		view === activeView
			? theme.bg("selectedBg", theme.bold(styles.apply("palette.tab.active", `[${label}]`)))
			: styles.apply("palette.tab.inactive", ` ${label} `),
	).join("  ");
}

/** Abbreviate a count for a column that has no room for every digit. */
export function compactNumber(value: number | undefined): string {
	if (value === undefined) return "unknown";
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
	if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
	return String(value);
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
	const metaWidth = meta ? terminalTextWidth(meta) + 1 : 0;
	const valueRoom = Math.max(0, innerWidth - headWidth - 1 - metaWidth);
	const fittedValue = value ? fitTerminalText(value, valueRoom) : "";
	const gap = Math.max(0, innerWidth - headWidth - 1 - terminalTextWidth(fittedValue) - metaWidth);
	const text = `${marker} ${styledLabel} ${fittedValue}${" ".repeat(gap)}${meta ? `${styles.apply("palette.count", meta)} ` : ""}`;
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
): string[] {
	const usable = hints.filter((hint) => hint.key !== "Unbound" && hint.key.length > 0);
	if (usable.length === 0) return [];
	const lines: string[] = [];
	let plain = "";
	let styled = "";
	const flush = (): void => {
		if (!plain) return;
		const padding = " ".repeat(Math.max(0, innerWidth - terminalTextWidth(plain)));
		lines.push(theme.bg("selectedBg", `${styled}${padding}`));
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
	maxHeight: "82%",
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

export function selectPalettePresentation(options: PaletteSurfaceOptions = {}): PalettePresentation {
	const env = options.env ?? process.env;
	const explicit = options.presentation ?? envPresentation(env);
	if (explicit) return explicit;
	if (terminalRendersInlineImages(env)) return "replace";
	const columns = options.columns ?? process.stdout.columns ?? 80;
	const rows = options.rows ?? process.stdout.rows ?? 24;
	return columns >= 58 && rows >= 16 ? "floating" : "replace";
}

export class JouzuPaletteSurfaceHost {
	private active?: ActivePalette;
	private readonly jouzuKeybindings: JouzuKeybindingsManager;

	constructor(options?: { jouzuKeybindings?: JouzuKeybindingsManager }) {
		// The default carries code defaults without user overrides; the product
		// wiring passes a manager loaded from the active keybindings.json.
		this.jouzuKeybindings = options?.jouzuKeybindings ?? createJouzuKeybindingsManagerFromConfig();
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

		const promise = ctx.ui.custom<void>((tui, theme, keybindings, done) => {
			component = factory(
				{
					tui,
					theme,
					keybindings,
					jouzuKeybindings: this.jouzuKeybindings,
					styles: createSessionUiStyles(theme),
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
		}
	}
}
