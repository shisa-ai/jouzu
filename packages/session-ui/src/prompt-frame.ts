import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { fillTerminalColumns, fitTerminalText, padTerminalText } from "./layout.js";
import type { SessionUiStyles } from "./styles.js";

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
	const styledRail = style.rail("┃");
	const rail = `${styledRail}${styledRail === "┃" ? "" : "\u001b[0m"} `;
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

export type ModelCycleDirection = "forward" | "backward";

export interface SessionPromptEditorOptions {
	onModelPicker?: (query?: string) => Promise<boolean>;
	onModelCycle?: (direction: ModelCycleDirection) => Promise<boolean>;
	onScopedModelsCommand?: () => Promise<boolean>;
}

/** Keep the one private Pi-TUI compatibility read isolated until a frame partition API exists. */
function autocompleteLineCount(editor: CustomEditor, width: number): number {
	if (!editor.isShowingAutocomplete()) return 0;
	const list = (editor as unknown as EditorAutocompleteInternals).autocompleteList;
	return typeof list?.render === "function" ? list.render(width).length : 0;
}

export class SessionPromptEditor extends CustomEditor {
	// Pi 0.84.3 restores non-overlay custom UI with setText(savedText). Ignore only
	// that identical write while the Palette is open so cursor and paste state survive.
	private preserveIdenticalSetText = false;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly keybindingsManager: KeybindingsManager,
		private readonly styles: SessionUiStyles,
		private readonly options: SessionPromptEditorOptions = {},
	) {
		super(tui, theme, keybindingsManager, { paddingX: 0 });
		this.borderColor = (value: string) => styles.apply("prompt.border", value);
	}

	private async openModelPicker(query?: string): Promise<boolean> {
		if (!this.options.onModelPicker) return false;
		this.preserveIdenticalSetText = true;
		try {
			return await this.options.onModelPicker(query);
		} catch {
			return false;
		} finally {
			this.preserveIdenticalSetText = false;
		}
	}

	override setText(text: string): void {
		if (this.preserveIdenticalSetText && text === this.getText()) return;
		super.setText(text);
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		const filteredProvider: AutocompleteProvider = {
			...(provider.triggerCharacters ? { triggerCharacters: provider.triggerCharacters } : {}),
			getSuggestions: async (lines, cursorLine, cursorCol, options) => {
				const suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol, options);
				if (!suggestions?.prefix.startsWith("/")) return suggestions;
				const items = suggestions.items.filter((item) => item.value !== "scoped-models");
				return items.length > 0 ? { ...suggestions, items } : null;
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
				provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
			...(provider.shouldTriggerFileCompletion
				? {
						shouldTriggerFileCompletion: (lines: string[], cursorLine: number, cursorCol: number) =>
							provider.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false,
					}
				: {}),
		};
		super.setAutocompleteProvider(filteredProvider);
	}

	override handleInput(data: string): void {
		const piPriorityAction =
			this.keybindingsManager.matches(data, "app.clipboard.pasteImage") ||
			this.keybindingsManager.matches(data, "app.interrupt") ||
			this.keybindingsManager.matches(data, "app.exit") ||
			this.keybindingsManager.matches(data, "tui.editor.historyPrevious") ||
			this.keybindingsManager.matches(data, "tui.editor.historyNext");
		if (piPriorityAction) {
			super.handleInput(data);
			return;
		}
		if (this.options.onModelCycle) {
			const direction = this.keybindingsManager.matches(data, "app.model.cycleForward")
				? "forward"
				: this.keybindingsManager.matches(data, "app.model.cycleBackward")
					? "backward"
					: undefined;
			if (direction) {
				if (this.onExtensionShortcut?.(data)) return;
				void this.options
					.onModelCycle(direction)
					.catch(() => false)
					.then((handled) => {
						if (!handled) super.handleInput(data);
					});
				return;
			}
		}
		if (this.options.onModelPicker && this.keybindingsManager.matches(data, "app.model.select")) {
			if (this.onExtensionShortcut?.(data)) return;
			void this.openModelPicker().then((opened) => {
				if (!opened) super.handleInput(data);
			});
			return;
		}
		if (this.keybindingsManager.matches(data, "tui.input.submit")) {
			const editorText = this.getText();
			if (this.options.onScopedModelsCommand && editorText.trim() === "/scoped-models") {
				if (this.onExtensionShortcut?.(data)) return;
				this.setText("");
				void this.options
					.onScopedModelsCommand()
					.catch(() => false)
					.then((handled) => {
						if (handled) return;
						this.setText(editorText);
						super.handleInput(data);
					});
				return;
			}
			if (this.options.onModelPicker) {
				const match = /^\/model(?:\s+(.*))?$/.exec(editorText.trim());
				if (match) {
					if (this.onExtensionShortcut?.(data)) return;
					this.setText("");
					void this.openModelPicker(match[1]?.trim() || undefined).then((opened) => {
						if (opened) return;
						this.setText(editorText);
						super.handleInput(data);
					});
					return;
				}
			}
		}
		super.handleInput(data);
	}

	render(width: number): string[] {
		if (width < 4) return super.render(width);
		const innerWidth = width - 2;
		const rendered = super.render(innerWidth);
		return renderPromptFrameLines(rendered, width, autocompleteLineCount(this, innerWidth), {
			border: (value) => this.styles.apply("prompt.border", value),
			rail: (value) => this.styles.apply("prompt.rail", value),
		});
	}
}
