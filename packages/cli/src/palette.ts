import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { createSessionUiStyles, type SessionUiStyles } from "./session-ui/index.js";

export type PaletteViewId = "models" | "usage" | "keys" | "help";
export type PalettePresentation = "floating" | "replace";

export interface PaletteRoute {
	view: PaletteViewId;
	query?: string;
}

export interface PaletteComponent extends Component {
	route(route: PaletteRoute): void;
	dispose?(): void;
}

export interface PaletteComponentContext {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	/** Jouzu-owned semantic colors. Views style through these roles rather than emitting escapes. */
	styles: SessionUiStyles;
	close(): void;
}

export type PaletteComponentFactory = (context: PaletteComponentContext, route: PaletteRoute) => PaletteComponent;

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

export function selectPalettePresentation(options: PaletteSurfaceOptions = {}): PalettePresentation {
	const env = options.env ?? process.env;
	const explicit = options.presentation ?? envPresentation(env);
	if (explicit) return explicit;
	const columns = options.columns ?? process.stdout.columns ?? 80;
	const rows = options.rows ?? process.stdout.rows ?? 24;
	return columns >= 58 && rows >= 16 ? "floating" : "replace";
}

export class JouzuPaletteSurfaceHost {
	private active?: ActivePalette;

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
				{ tui, theme, keybindings, styles: createSessionUiStyles(theme), close: () => done(undefined) },
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
