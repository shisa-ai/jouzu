import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { fillTerminalColumns, fitTerminalText, padTerminalText } from "./layout.js";

export interface PromptFrameStyle {
	border(value: string): string;
	rail(value: string): string;
}

export function renderPromptFrameLines(
	baseLines: readonly string[],
	width: number,
	autocompleteLineCount: number,
	style: PromptFrameStyle,
): string[] {
	if (width <= 0) return [];
	if (width < 4 || baseLines.length < 2) return baseLines.map((line) => fitTerminalText(line, width));
	const autocompleteCount = Math.max(0, Math.min(autocompleteLineCount, baseLines.length - 2));
	const frameEnd = baseLines.length - autocompleteCount;
	const frame = baseLines.slice(0, frameEnd);
	const autocomplete = baseLines.slice(frameEnd);
	if (frame.length < 2) return baseLines.map((line) => fitTerminalText(line, width));
	const innerWidth = width - 2;
	const rail = `${style.rail("┃")}\u001b[0m `;
	const border = style.border(fillTerminalColumns("─", width));
	return [
		border,
		...frame.slice(1, -1).map((line) => `${rail}${padTerminalText(line, innerWidth)}`),
		border,
		...autocomplete.map((line) => `  ${fitTerminalText(line, innerWidth)}`),
	];
}

type EditorAutocompleteInternals = {
	autocompleteList?: Pick<Component, "render">;
};

/** Keep the one private Pi-TUI compatibility read isolated until a frame partition API exists. */
function autocompleteLineCount(editor: CustomEditor, width: number): number {
	if (!editor.isShowingAutocomplete()) return 0;
	const list = (editor as unknown as EditorAutocompleteInternals).autocompleteList;
	return typeof list?.render === "function" ? list.render(width).length : 0;
}

export class SessionPromptEditor extends CustomEditor {
	private readonly uiTheme: Pick<Theme, "fg">;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, uiTheme: Pick<Theme, "fg">) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.uiTheme = uiTheme;
		this.borderColor = (value: string) => uiTheme.fg("borderMuted", value);
	}

	render(width: number): string[] {
		if (width < 4) return super.render(width);
		const innerWidth = width - 2;
		const rendered = super.render(innerWidth);
		return renderPromptFrameLines(rendered, width, autocompleteLineCount(this, innerWidth), {
			border: (value) => this.uiTheme.fg("borderMuted", value),
			rail: (value) => this.uiTheme.fg("accent", value),
		});
	}
}
