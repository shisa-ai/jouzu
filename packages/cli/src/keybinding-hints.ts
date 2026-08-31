import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Keybinding } from "@earendil-works/pi-tui";

const KEY_PART_LABELS: Readonly<Record<string, string>> = Object.freeze({
	alt: process.platform === "darwin" ? "Option" : "Alt",
	backspace: "Backspace",
	ctrl: "Ctrl",
	delete: "Delete",
	down: "↓",
	end: "End",
	enter: "Enter",
	esc: "Esc",
	escape: "Esc",
	home: "Home",
	insert: "Insert",
	left: "←",
	pagedown: "PgDn",
	pageup: "PgUp",
	return: "Enter",
	right: "→",
	shift: "Shift",
	space: "Space",
	super: "Super",
	tab: "Tab",
	up: "↑",
});

function formatKeyPart(part: string): string {
	const label = KEY_PART_LABELS[part.toLowerCase()];
	if (label) return label;
	return part.length === 1 ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
}

export function formatKeyId(key: string): string {
	return key
		.split("+")
		.map((part) => formatKeyPart(part))
		.join("+");
}

export function formatKeyIds(keys: readonly string[]): string {
	return keys.length > 0 ? keys.map((key) => formatKeyId(key)).join("/") : "Unbound";
}

export function formatEffectiveKeybinding(keybindings: KeybindingsManager, action: Keybinding): string {
	return formatKeyIds(keybindings.getKeys(action));
}

export function formatEffectiveKeyPair(
	keybindings: KeybindingsManager,
	firstAction: Keybinding,
	secondAction: Keybinding,
): string {
	const first = formatEffectiveKeybinding(keybindings, firstAction);
	const second = formatEffectiveKeybinding(keybindings, secondAction);
	return /^[←→↑↓]$/u.test(first) && /^[←→↑↓]$/u.test(second) ? `${first}${second}` : `${first}/${second}`;
}
