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
import { createSessionUiStyles, type SessionUiStyles } from "./session-ui/index.js";

export type PaletteViewId = "models" | "settings" | "usage" | "keys" | "help";
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
	{ view: "settings", label: "Settings" },
] as const satisfies ReadonlyArray<{ view: PaletteViewId; label: string }>;

export function renderPaletteTabs(activeView: PaletteViewId, theme: Theme, styles: SessionUiStyles): string {
	return PALETTE_TABS.map(({ view, label }) =>
		view === activeView ? theme.bg("selectedBg", styles.apply("palette.tab.active", ` [${label}] `)) : ` ${label} `,
	).join("  ");
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
