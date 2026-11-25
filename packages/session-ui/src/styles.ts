import type { Theme } from "@earendil-works/pi-coding-agent";
import { detectTerminalColorMode, renderTerminalRgb, type TerminalColorMode } from "./color.js";

export type SessionUiStyleRole =
	| "prompt.border"
	| "prompt.leader"
	| "session.hint.text"
	| "session.hint.muted"
	| "session.hint.accent"
	| "session.hint.success"
	| "session.hint.warning"
	| "session.hint.error"
	| "session.activity"
	| "session.activity.idle"
	| "session.provider"
	| "session.model"
	| "status.text"
	| "status.muted"
	| "status.accent"
	| "status.success"
	| "status.warning"
	| "status.error"
	| "status.workspace"
	| "status.git.branch"
	| "status.git.changes"
	| "status.runtime.default"
	| "status.runtime.node"
	| "status.runtime.deno"
	| "status.runtime.bun"
	| "status.runtime.python"
	| "status.runtime.java"
	| "status.runtime.rust"
	| "status.runtime.ruby"
	| "status.runtime.go"
	| "status.runtime.lua"
	| "status.runtime.php"
	| "status.context.normal"
	| "status.context.warning"
	| "status.context.error"
	| "status.tokens"
	| "status.separator"
	| "status.health"
	| "status.unknown"
	| "palette.border"
	| "palette.title"
	| "palette.count"
	| "palette.marker"
	| "palette.identity"
	| "palette.identity.selected"
	| "palette.favorite"
	| "palette.default"
	| "palette.unavailable"
	| "palette.context.small"
	| "palette.section"
	| "palette.section.current"
	| "palette.detail"
	| "palette.tab.active"
	| "palette.tab.inactive"
	| "palette.heading"
	| "palette.rule"
	| "palette.key"
	| "palette.label"
	| "palette.value"
	| "palette.status.ready"
	| "palette.status.attention"
	| "palette.status.off"
	| "palette.empty"
	| "palette.message.error"
	| "palette.message.warning"
	| "palette.message.info"
	| "palette.hint"
	| "startup.heading"
	| "startup.workspace"
	| "startup.index"
	| "startup.title"
	| "startup.age"
	| "startup.badge"
	| "startup.label"
	| "startup.separator"
	| "startup.hint";

type ThemeColor = Parameters<Theme["fg"]>[0];

export type SessionUiColor =
	| Readonly<{ source: "theme"; value: ThemeColor }>
	| Readonly<{ source: "rgb"; red: number; green: number; blue: number }>;

export type SessionUiStyleScheme = Readonly<Record<SessionUiStyleRole, SessionUiColor>>;

const theme = (value: ThemeColor): SessionUiColor => Object.freeze({ source: "theme", value });
const rgb = (red: number, green: number, blue: number): SessionUiColor =>
	Object.freeze({ source: "rgb", red, green, blue });

export type SessionUiAppearance = "dark" | "light";

/**
 * Jouzu's own colors. Each appearance keeps the same brand hues, with light
 * values dark enough to read on a light terminal background.
 */
interface SessionUiBrandColors {
	/** Prompt leader, model label, and the Palette's selection and headings. */
	blue: SessionUiColor;
	pink: SessionUiColor;
	workspace: SessionUiColor;
	context: SessionUiColor;
	tokens: SessionUiColor;
}

const DARK_BRAND_COLORS: SessionUiBrandColors = {
	blue: rgb(103, 232, 249),
	pink: rgb(244, 114, 182),
	workspace: rgb(215, 215, 255),
	context: rgb(250, 204, 21),
	tokens: rgb(255, 175, 215),
};

const LIGHT_BRAND_COLORS: SessionUiBrandColors = {
	blue: rgb(14, 116, 144),
	pink: rgb(190, 24, 93),
	workspace: rgb(67, 56, 202),
	context: rgb(180, 83, 9),
	tokens: rgb(190, 24, 93),
};

/** Jouzu-owned semantic roles. Roles not tied to the brand use the active Pi theme's colors. */
function sessionUiStyleScheme(brand: SessionUiBrandColors): SessionUiStyleScheme {
	return Object.freeze({
		"prompt.border": theme("borderMuted"),
		"prompt.leader": brand.blue,
		"session.hint.text": theme("text"),
		"session.hint.muted": theme("muted"),
		"session.hint.accent": theme("accent"),
		"session.hint.success": theme("success"),
		"session.hint.warning": theme("warning"),
		"session.hint.error": theme("error"),
		"session.activity": theme("accent"),
		"session.activity.idle": theme("dim"),
		"session.provider": theme("dim"),
		"session.model": brand.blue,
		"status.text": theme("text"),
		"status.muted": theme("muted"),
		"status.accent": theme("accent"),
		"status.success": theme("success"),
		"status.warning": theme("warning"),
		"status.error": theme("error"),
		"status.workspace": brand.workspace,
		"status.git.branch": theme("syntaxKeyword"),
		"status.git.changes": theme("error"),
		"status.runtime.default": theme("text"),
		"status.runtime.node": theme("success"),
		"status.runtime.deno": theme("syntaxType"),
		"status.runtime.bun": theme("warning"),
		"status.runtime.python": theme("warning"),
		"status.runtime.java": theme("warning"),
		"status.runtime.rust": theme("error"),
		"status.runtime.ruby": theme("error"),
		"status.runtime.go": theme("syntaxType"),
		"status.runtime.lua": theme("accent"),
		"status.runtime.php": theme("accent"),
		"status.context.normal": brand.context,
		"status.context.warning": theme("warning"),
		"status.context.error": theme("error"),
		"status.tokens": brand.tokens,
		"status.separator": theme("borderMuted"),
		"status.health": theme("error"),
		"status.unknown": theme("warning"),
		"palette.border": theme("borderAccent"),
		"palette.title": theme("accent"),
		"palette.count": theme("muted"),
		"palette.marker": brand.blue,
		"palette.identity": theme("text"),
		"palette.identity.selected": brand.blue,
		"palette.favorite": theme("warning"),
		"palette.default": theme("success"),
		"palette.unavailable": theme("error"),
		"palette.context.small": theme("warning"),
		"palette.section": theme("muted"),
		"palette.section.current": brand.pink,
		"palette.detail": brand.blue,
		"palette.tab.active": theme("accent"),
		"palette.tab.inactive": theme("muted"),
		"palette.heading": brand.blue,
		"palette.rule": theme("borderMuted"),
		"palette.key": theme("accent"),
		"palette.label": theme("muted"),
		"palette.value": theme("text"),
		"palette.status.ready": theme("success"),
		"palette.status.attention": theme("warning"),
		"palette.status.off": theme("dim"),
		"palette.empty": theme("muted"),
		"palette.message.error": theme("error"),
		"palette.message.warning": theme("warning"),
		"palette.message.info": theme("muted"),
		"palette.hint": theme("dim"),
		// Recent sessions under the startup banner: the heading matches Palette
		// headings, project names match the status bar workspace, and ages and
		// hints stay as quiet as the resume picker's and the banner's.
		"startup.heading": brand.blue,
		"startup.workspace": brand.workspace,
		"startup.index": theme("accent"),
		"startup.title": theme("text"),
		"startup.age": theme("dim"),
		"startup.badge": theme("warning"),
		"startup.label": theme("muted"),
		"startup.separator": theme("borderMuted"),
		"startup.hint": theme("dim"),
	});
}

export const DARK_SESSION_UI_STYLE_SCHEME = sessionUiStyleScheme(DARK_BRAND_COLORS);
export const LIGHT_SESSION_UI_STYLE_SCHEME = sessionUiStyleScheme(LIGHT_BRAND_COLORS);

export const SESSION_UI_STYLE_SCHEMES: Readonly<Record<SessionUiAppearance, SessionUiStyleScheme>> = Object.freeze({
	dark: DARK_SESSION_UI_STYLE_SCHEME,
	light: LIGHT_SESSION_UI_STYLE_SCHEME,
});

export interface SessionUiStyles {
	readonly scheme: SessionUiStyleScheme;
	apply(role: SessionUiStyleRole, value: string): string;
}

export interface SessionUiStyleOptions {
	/** Replaces the appearance-selected scheme for both light and dark terminals. */
	scheme?: SessionUiStyleScheme;
	colorEnabled?: boolean;
	colorMode?: TerminalColorMode;
	colorDepth?: number;
	stdoutIsTTY?: boolean;
	env?: NodeJS.ProcessEnv;
}

function themeSupportsColor(themeValue: Pick<Theme, "fg">): boolean {
	const probe = "jouzu-color-probe";
	return themeValue.fg("accent", probe) !== probe;
}

export function createSessionUiStyles(
	themeValue: Pick<Theme, "fg"> & { readonly appearance?: SessionUiAppearance },
	options: SessionUiStyleOptions = {},
): SessionUiStyles {
	const env = options.env ?? process.env;
	const colorEnabled =
		options.colorEnabled ?? (env.NO_COLOR === undefined && env.TERM !== "dumb" && themeSupportsColor(themeValue));
	const detectedMode = detectTerminalColorMode({
		env,
		...(options.colorDepth !== undefined ? { colorDepth: options.colorDepth } : {}),
		...(options.stdoutIsTTY !== undefined ? { stdoutIsTTY: options.stdoutIsTTY } : {}),
	});
	const colorMode =
		options.colorMode ?? (options.colorEnabled === true && detectedMode === "none" ? "truecolor" : detectedMode);
	// Read the appearance on each use: Pi can switch between its light and dark
	// themes after startup, once the terminal reports its background.
	const activeScheme = () => options.scheme ?? SESSION_UI_STYLE_SCHEMES[themeValue.appearance ?? "dark"];
	return Object.freeze({
		get scheme() {
			return activeScheme();
		},
		apply(role: SessionUiStyleRole, value: string): string {
			if (!colorEnabled || value.length === 0) return value;
			const color = activeScheme()[role];
			if (color.source === "theme") return themeValue.fg(color.value, value);
			return renderTerminalRgb(value, color, colorMode);
		},
	});
}
