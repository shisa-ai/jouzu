import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
	Component,
	EditorTheme,
	TUI,
} from "@earendil-works/pi-tui";
import {
	SESSION_UI_BUILTIN_SLASH_COMMANDS,
	SESSION_UI_BUNDLED_SLASH_COMMAND_DESCRIPTIONS,
	SESSION_UI_INSTALLED_SLASH_COMMAND_DESCRIPTIONS,
	SESSION_UI_SLASH_COMMAND_CANONICAL_DESCRIPTIONS,
	SESSION_UI_SLASH_COMMAND_IDS,
	type SessionUiCatalog,
} from "./contracts.js";
import { fillTerminalColumns, fitTerminalText, padTerminalText, terminalTextWidth } from "./layout.js";
import type { SessionUiStyles } from "./styles.js";

const EXIT_ALIAS_COMMAND = "exit";

export interface PromptFrameStyle {
	border(value: string): string;
	leader(value: string): string;
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
	// One leader marks the prompt. Later rows keep the indent alone, so a terminal selection picks up
	// at most one marker character instead of one per wrapped row.
	const leader = `${style.leader("❯")} `;
	const gutter = " ".repeat(terminalTextWidth(leader));
	const border = style.border(fillTerminalColumns("─", width));
	return [
		border,
		...frame.slice(1, -1).map((line, index) => `${index === 0 ? leader : gutter}${padTerminalText(line, innerWidth)}`),
		border,
		...autocomplete.map((line) => `  ${fitTerminalText(line, innerWidth)}`),
	];
}

type EditorAutocompleteInternals = {
	autocompleteList?: Pick<Component, "render">;
};

export type ModelCycleDirection = "forward" | "backward";

export interface SessionPromptEditorOptions {
	/** A line drawn directly above the frame, so it stays attached to the prompt whatever widgets do. */
	topLine?: (width: number) => string | undefined;
	/** Resolve an owned slash-command description from the current catalog, or leave the suggestion unchanged. */
	slashCommandLocalizer?: SlashCommandLocalizer;
	onModelPicker?: (query?: string) => Promise<boolean>;
	onModelCycle?: (direction: ModelCycleDirection) => Promise<boolean>;
	onScopedModelsCommand?: () => Promise<boolean>;
	/** Whether an exact `/exit` submission should submit as `/quit`; read on each submission. */
	exitAlias?: () => boolean;
	/** The localized description for the `/exit` autocomplete alias; read on each completion. */
	exitAliasDescription?: () => string | undefined;
}

/** One command registration as Pi reports it to an extension. */
export interface SlashCommandRegistration {
	readonly name: string;
	readonly description?: string;
	readonly source?: string;
	readonly sourceInfo?: {
		readonly source?: string;
		readonly scope?: "user" | "project" | "temporary";
	};
}

type SlashCommandScope = "u" | "p" | "t";

interface SlashCommandOwnership {
	readonly scopes: Set<SlashCommandScope>;
	allowUntagged: boolean;
	readonly descriptions: Set<string>;
}

/** Ownership evidence accumulated across session starts and locale changes. */
export interface SlashCommandOwnershipState {
	readonly commands: Map<string, SlashCommandOwnership>;
}

export function createSlashCommandOwnershipState(): SlashCommandOwnershipState {
	return { commands: new Map() };
}

/** Return the localized description to use, or undefined to leave the suggestion unchanged. */
export type SlashCommandLocalizer = (command: string, currentDescription: string | undefined) => string | undefined;

interface SlashCommandDescriptionParts {
	readonly prefix: string;
	readonly sourceTag?: string;
	readonly description: string;
}

/**
 * Split the prefix Pi composes before a command description: one or more
 * argument hints, the source tag, or both. The em dash inside a description is
 * left alone because a hint is only recognized at the start of the text.
 */
function splitSlashCommandDescription(current: string): SlashCommandDescriptionParts {
	let prefix = "";
	let rest = current;
	const hint = /^(?:<[^<>]+>\s*)+/u.exec(rest);
	if (hint) {
		const afterHint = rest.slice(hint[0].length);
		const separator = /^—\s*/u.exec(afterHint);
		if (separator) {
			prefix = hint[0] + separator[0];
			rest = afterHint.slice(separator[0].length);
		} else if (afterHint.trim() === "") {
			return { prefix: rest, description: "" };
		}
	}
	const tag = /^\[([upt](?::[^\]]*)?)\]\s*/u.exec(rest);
	if (!tag) return { prefix, description: rest };
	return { prefix: prefix + tag[0], sourceTag: tag[1], description: rest.slice(tag[0].length) };
}

/**
 * Preserve every argument hint and source tag while replacing only the
 * description text. A standalone source tag keeps a separating space.
 */
export function formatSlashCommandDescription(current: string | undefined, localized: string): string {
	if (!current) return localized;
	const { prefix } = splitSlashCommandDescription(current);
	if (!prefix) return localized;
	if (/\s$/u.test(prefix)) return `${prefix}${localized}`;
	if (prefix.endsWith("]")) return `${prefix} ${localized}`;
	if (prefix.endsWith("—")) return `${prefix} ${localized}`;
	return `${prefix} — ${localized}`;
}

function ownershipFor(state: SlashCommandOwnershipState, command: string): SlashCommandOwnership {
	let entry = state.commands.get(command);
	if (!entry) {
		entry = { scopes: new Set(), allowUntagged: false, descriptions: new Set() };
		state.commands.set(command, entry);
	}
	return entry;
}

function scopeFor(sourceInfo: SlashCommandRegistration["sourceInfo"]): SlashCommandScope | undefined {
	switch (sourceInfo?.scope) {
		case "user":
			return "u";
		case "project":
			return "p";
		case "temporary":
			return "t";
		default:
			return undefined;
	}
}

function activeSlashCommandDescription(catalog: SessionUiCatalog, command: string): string | undefined {
	if (!Object.hasOwn(SESSION_UI_SLASH_COMMAND_IDS, command)) return undefined;
	const id = SESSION_UI_SLASH_COMMAND_IDS[command];
	if (!id) return undefined;
	const value = catalog.format(id);
	return typeof value === "string" && value.length > 0 && value !== id ? value : undefined;
}

/**
 * Build a localizer that only rewrites commands whose ownership is known: Pi
 * built-ins (untagged), bundled extension/skill registrations, or installed
 * Jouzu resources whose full registered description matches. A user prompt,
 * skill, or extension that merely shares a command name keeps its text.
 */
export function createSlashCommandLocalizer(
	catalog: SessionUiCatalog,
	registrations: readonly SlashCommandRegistration[] = [],
	state: SlashCommandOwnershipState = createSlashCommandOwnershipState(),
): SlashCommandLocalizer {
	for (const command of SESSION_UI_BUILTIN_SLASH_COMMANDS) {
		ownershipFor(state, command).allowUntagged = true;
	}
	for (const registration of registrations) {
		if (!Object.hasOwn(SESSION_UI_SLASH_COMMAND_IDS, registration.name)) continue;
		const entry = ownershipFor(state, registration.name);
		const installed = SESSION_UI_INSTALLED_SLASH_COMMAND_DESCRIPTIONS[registration.name];
		const source = registration.sourceInfo?.source;
		const scope = scopeFor(registration.sourceInfo);
		if (installed) {
			if (registration.description === undefined || !installed.includes(registration.description)) continue;
			for (const description of installed) entry.descriptions.add(description);
			if (source === "builtin") entry.allowUntagged = true;
			else entry.scopes.add(scope ?? "u");
			continue;
		}
		// Prompt templates are user content even when loaded from the command line; only the
		// installed-resource table above can grant them ownership.
		if (registration.source === "prompt") continue;
		if (source === "builtin") {
			entry.allowUntagged = true;
			if (registration.description) entry.descriptions.add(registration.description);
			continue;
		}
		const description = registration.description;
		if (description === undefined) continue;
		const active = activeSlashCommandDescription(catalog, registration.name);
		const canonical = SESSION_UI_SLASH_COMMAND_CANONICAL_DESCRIPTIONS[registration.name];
		const bundled = SESSION_UI_BUNDLED_SLASH_COMMAND_DESCRIPTIONS[registration.name];
		if (description !== canonical && description !== active && bundled?.includes(description) !== true) continue;
		if (source === "cli" || source === "inline") {
			entry.scopes.add(scope ?? "t");
			entry.descriptions.add(description);
			continue;
		}
		// A bundled command installed through settings or auto-discovery keeps its
		// source scope, but only a canonical description grants ownership.
		if (scope) entry.scopes.add(scope);
		else entry.allowUntagged = true;
		entry.descriptions.add(description);
	}
	return (command, currentDescription) => {
		if (currentDescription === undefined) return undefined;
		const entry = state.commands.get(command);
		if (!entry) return undefined;
		const localized = activeSlashCommandDescription(catalog, command);
		if (!localized) return undefined;
		const parts = splitSlashCommandDescription(currentDescription);
		if (!parts.description) return undefined;
		const scope = parts.sourceTag?.[0] as SlashCommandScope | undefined;
		if (scope === undefined) {
			if (!entry.allowUntagged) return undefined;
			// Untagged commands are Pi built-ins, so their text is canonical by provenance.
			return parts.description === localized
				? currentDescription
				: formatSlashCommandDescription(currentDescription, localized);
		}
		if (!entry.scopes.has(scope)) return undefined;
		if (parts.description === localized) {
			entry.descriptions.add(parts.description);
			return currentDescription;
		}
		if (!entry.descriptions.has(parts.description)) return undefined;
		entry.descriptions.add(localized);
		return formatSlashCommandDescription(currentDescription, localized);
	};
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
		// Pi assigns onSubmit after constructing a custom editor. Replace the base data
		// property with an accessor so every assignment, including Pi's, crosses the exact
		// /exit alias before the interactive handler sees the submitted text.
		let submitHandler: ((text: string) => void) | undefined;
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			enumerable: true,
			get: () => submitHandler,
			set: (handler: ((text: string) => void) | undefined) => {
				submitHandler = handler ? (text) => handler(this.mapExitAlias(text)) : undefined;
			},
		});
	}

	private exitAliasEnabled(): boolean {
		try {
			return this.options.exitAlias?.() ?? true;
		} catch {
			return false;
		}
	}

	private mapExitAlias(text: string): string {
		if (!this.exitAliasEnabled()) return text;
		const command = text.trim().replace(/^\uFF0F/u, "/");
		return command === "/exit" ? "/quit" : text;
	}

	private withExitAlias(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		suggestions: AutocompleteSuggestions | null,
		items: AutocompleteItem[],
	): AutocompleteSuggestions | null {
		const base = suggestions ? { ...suggestions, items } : { prefix: "", items };
		if (!this.exitAliasEnabled()) return items.length > 0 ? base : null;
		const commandText = (lines[cursorLine] ?? "")
			.slice(0, cursorCol)
			.trimStart()
			.replace(/^\uFF0F/u, "/");
		if (!commandText.startsWith("/")) return items.length > 0 ? base : null;
		const prefix = commandText.slice(1);
		if (prefix.includes(" ") || !EXIT_ALIAS_COMMAND.startsWith(prefix.toLowerCase()))
			return items.length > 0 ? base : null;
		if (items.some((item) => item.value === EXIT_ALIAS_COMMAND)) return base;
		let description: string | undefined;
		try {
			description = this.options.exitAliasDescription?.();
		} catch {
			description = undefined;
		}
		return {
			prefix: base.prefix || commandText,
			items: [
				...items,
				{ value: EXIT_ALIAS_COMMAND, label: EXIT_ALIAS_COMMAND, ...(description ? { description } : {}) },
			],
		};
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
				if (suggestions && !suggestions.prefix.startsWith("/")) return suggestions;
				const items = [...(suggestions?.items ?? [])]
					.filter((item) => item.value !== "scoped-models")
					.map((item) => {
						const localized = this.options.slashCommandLocalizer?.(item.value, item.description);
						if (localized === undefined || localized === item.description) return item;
						return { ...item, description: localized };
					});
				return this.withExitAlias(lines, cursorLine, cursorCol, suggestions, items);
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
		const frame = renderPromptFrameLines(rendered, width, autocompleteLineCount(this, innerWidth), {
			border: (value) => this.styles.apply("prompt.border", value),
			leader: (value) => this.styles.apply("prompt.leader", value),
		});
		const top = this.options.topLine?.(width);
		return top === undefined ? frame : [top, ...frame];
	}
}
