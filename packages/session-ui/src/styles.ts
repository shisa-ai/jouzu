import type { Theme } from "@earendil-works/pi-coding-agent";
import { detectTerminalColorMode, renderTerminalRgb, type TerminalColorMode } from "./color.js";

export type SessionUiStyleRole =
	| "prompt.border"
	| "prompt.rail"
	| "session.hint.text"
	| "session.hint.muted"
	| "session.hint.accent"
	| "session.hint.success"
	| "session.hint.warning"
	| "session.hint.error"
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
	| "status.unknown";

type ThemeColor = Parameters<Theme["fg"]>[0];

export type SessionUiColor =
	| Readonly<{ source: "theme"; value: ThemeColor }>
	| Readonly<{ source: "rgb"; red: number; green: number; blue: number }>;

export type SessionUiStyleScheme = Readonly<Record<SessionUiStyleRole, SessionUiColor>>;

const theme = (value: ThemeColor): SessionUiColor => Object.freeze({ source: "theme", value });
const rgb = (red: number, green: number, blue: number): SessionUiColor =>
	Object.freeze({ source: "rgb", red, green, blue });

/** Jouzu-owned semantic roles with defaults matched to the retained Session UI baseline. */
export const DEFAULT_SESSION_UI_STYLE_SCHEME: SessionUiStyleScheme = Object.freeze({
	"prompt.border": theme("borderMuted"),
	"prompt.rail": rgb(103, 232, 249),
	"session.hint.text": theme("text"),
	"session.hint.muted": theme("muted"),
	"session.hint.accent": theme("accent"),
	"session.hint.success": theme("success"),
	"session.hint.warning": theme("warning"),
	"session.hint.error": theme("error"),
	"session.provider": theme("dim"),
	"session.model": theme("mdCode"),
	"status.text": theme("text"),
	"status.muted": theme("muted"),
	"status.accent": theme("accent"),
	"status.success": theme("success"),
	"status.warning": theme("warning"),
	"status.error": theme("error"),
	"status.workspace": rgb(215, 215, 255),
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
	"status.context.normal": rgb(250, 204, 21),
	"status.context.warning": theme("warning"),
	"status.context.error": theme("error"),
	"status.tokens": rgb(255, 175, 215),
	"status.separator": theme("borderMuted"),
	"status.health": theme("error"),
	"status.unknown": theme("warning"),
});

export interface SessionUiStyles {
	readonly scheme: SessionUiStyleScheme;
	apply(role: SessionUiStyleRole, value: string): string;
}

export interface SessionUiStyleOptions {
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
	themeValue: Pick<Theme, "fg">,
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
	const scheme = options.scheme ?? DEFAULT_SESSION_UI_STYLE_SCHEME;
	return Object.freeze({
		scheme,
		apply(role: SessionUiStyleRole, value: string): string {
			if (!colorEnabled || value.length === 0) return value;
			const color = scheme[role];
			if (color.source === "theme") return themeValue.fg(color.value, value);
			return renderTerminalRgb(value, color, colorMode);
		},
	});
}
