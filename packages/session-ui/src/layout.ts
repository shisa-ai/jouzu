import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type TerminalTextAlignment = "left" | "center" | "right";
export type TerminalTextStyle = (value: string) => string;

export interface TerminalFrameOptions {
	border?: TerminalTextStyle;
	horizontal?: string;
	vertical?: string;
}

export interface TerminalFrameTitleOptions extends TerminalFrameOptions {
	left?: string;
	right?: string;
	gap?: string;
}

export interface TerminalFrameBorderOptions extends TerminalFrameOptions {
	left: string;
	right: string;
}

const IDENTITY_STYLE: TerminalTextStyle = (value) => value;

function normalizeColumns(columns: number): number {
	return Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 0;
}

/** Remove terminal control bytes from untrusted labels before adding product-owned styling. */
export function sanitizeTerminalText(value: string): string {
	return Array.from(value)
		.filter((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint >= 0x20 && codePoint !== 0x7f && !(codePoint >= 0x80 && codePoint <= 0x9f);
		})
		.join("");
}

/** Measure rendered terminal columns, ignoring ANSI and respecting wide glyphs. */
export function terminalTextWidth(value: string): number {
	return visibleWidth(value);
}

/**
 * Fit text to terminal columns without measuring JavaScript code units.
 * ANSI escapes, combining marks, and wide glyphs are delegated to Pi TUI's
 * terminal-width implementation.
 */
export function fitTerminalText(value: string, columns: number, indicator = ""): string {
	const fitted = truncateToWidth(value, normalizeColumns(columns), indicator);
	if (value.includes("\u001b") || indicator.includes("\u001b")) return fitted;
	return fitted.split("\u001b[0m").join("");
}

/** Fit and pad text to exactly the requested terminal display width. */
export function padTerminalText(
	value: string,
	columns: number,
	options: { alignment?: TerminalTextAlignment; indicator?: string } = {},
): string {
	const target = normalizeColumns(columns);
	const fitted = fitTerminalText(value, target, options.indicator ?? "");
	const padding = Math.max(0, target - terminalTextWidth(fitted));
	const alignment = options.alignment ?? "left";
	if (alignment === "right") return `${" ".repeat(padding)}${fitted}`;
	if (alignment === "center") {
		const left = Math.floor(padding / 2);
		return `${" ".repeat(left)}${fitted}${" ".repeat(padding - left)}`;
	}
	return `${fitted}${" ".repeat(padding)}`;
}

/** Fill exactly the requested terminal columns with a display-width-aware token. */
export function fillTerminalColumns(token: string, columns: number): string {
	const target = normalizeColumns(columns);
	if (target === 0) return "";
	const tokenWidth = terminalTextWidth(token);
	if (tokenWidth <= 0) return " ".repeat(target);
	const repetitions = Math.floor(target / tokenWidth);
	const value = token.repeat(repetitions);
	return `${value}${" ".repeat(Math.max(0, target - terminalTextWidth(value)))}`;
}

/** Return the unoccupied terminal columns after measuring all supplied segments. */
export function remainingTerminalColumns(columns: number, ...segments: string[]): number {
	return Math.max(
		0,
		normalizeColumns(columns) - segments.reduce((total, value) => total + terminalTextWidth(value), 0),
	);
}

/** Render a titled top border whose right edge always lands on the requested column. */
export function renderTerminalFrameTitle(
	title: string,
	columns: number,
	options: TerminalFrameTitleOptions = {},
): string {
	const target = normalizeColumns(columns);
	if (target === 0) return "";
	const border = options.border ?? IDENTITY_STYLE;
	const horizontal = options.horizontal ?? "─";
	const gap = options.gap ?? " ";
	const left = border(options.left ?? "╭─");
	const right = border(options.right ?? "╮");
	const fixedWidth = terminalTextWidth(left) + terminalTextWidth(gap) * 2 + terminalTextWidth(right);
	if (target < fixedWidth) return padTerminalText(fitTerminalText(`${left}${right}`, target), target);
	const fittedTitle = fitTerminalText(title, target - fixedWidth);
	const fillWidth = remainingTerminalColumns(target, left, gap, fittedTitle, gap, right);
	return `${left}${gap}${fittedTitle}${gap}${border(fillTerminalColumns(horizontal, fillWidth))}${right}`;
}

/** Render a content row whose borders and padded body occupy exactly the requested columns. */
export function renderTerminalFrameRow(value: string, columns: number, options: TerminalFrameOptions = {}): string {
	const target = normalizeColumns(columns);
	if (target === 0) return "";
	const border = options.border ?? IDENTITY_STYLE;
	const vertical = options.vertical ?? "│";
	const left = border(vertical);
	const right = border(vertical);
	const fixedWidth = terminalTextWidth(left) + terminalTextWidth(right) + 2;
	if (target < fixedWidth) return padTerminalText(fitTerminalText(`${left}${right}`, target), target);
	return `${left} ${padTerminalText(value, target - fixedWidth)} ${right}`;
}

/** Render a horizontal frame edge at an exact terminal display width. */
export function renderTerminalFrameBorder(columns: number, options: TerminalFrameBorderOptions): string {
	const target = normalizeColumns(columns);
	if (target === 0) return "";
	const border = options.border ?? IDENTITY_STYLE;
	const left = border(options.left);
	const right = border(options.right);
	const fixedWidth = terminalTextWidth(left) + terminalTextWidth(right);
	if (target < fixedWidth) return padTerminalText(fitTerminalText(`${left}${right}`, target), target);
	const fillWidth = remainingTerminalColumns(target, left, right);
	return `${left}${border(fillTerminalColumns(options.horizontal ?? "─", fillWidth))}${right}`;
}
