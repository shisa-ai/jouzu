import { join } from "node:path";
import {
	type Keybinding,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	type KeyId,
	matchesKey,
	KeybindingsManager as TuiKeybindingsManager,
} from "@earendil-works/pi-tui";
import { formatKeyIds } from "./keybinding-hints.js";
import { readKeybindingConfig } from "./keybindings.js";
import type { JouzuPaths } from "./paths.js";

/**
 * Jouzu-owned semantic actions. Pi's KeybindingsManager is constructed with
 * Pi's definitions and cannot learn these IDs, so Jouzu runs its own manager
 * over the same keybindings.json; each manager ignores the other's entries.
 *
 * Default bindings must satisfy docs/ux.md and pass the docs/key-collisions.md
 * audit before they change.
 */
export const JOUZU_KEYBINDING_DEFINITIONS = {
	"jouzu.model.toggleFavorite": {
		defaultKeys: ["ctrl+shift+s"],
		description: "Toggle favorite for the selected model",
	},
} satisfies KeybindingDefinitions;

export type JouzuKeybinding = keyof typeof JOUZU_KEYBINDING_DEFINITIONS;

export type JouzuKeybindingsManager = TuiKeybindingsManager;

/** Defaults plus explicit overrides; tests and the Palette host default use this. */
export function createJouzuKeybindingsManagerFromConfig(userBindings: KeybindingsConfig = {}): JouzuKeybindingsManager {
	return new TuiKeybindingsManager(JOUZU_KEYBINDING_DEFINITIONS, userBindings);
}

export function createJouzuKeybindingsManager(paths: JouzuPaths): JouzuKeybindingsManager {
	let userBindings: KeybindingsConfig = {};
	try {
		// The values are validated keys or key arrays; KeyId is a branded string.
		userBindings = (readKeybindingConfig(join(paths.agentDir, "keybindings.json")) ?? {}) as KeybindingsConfig;
	} catch {
		// A malformed keybindings.json must not strip the code defaults; the
		// keybindings command and Pi's own loader report the file problem.
	}
	return createJouzuKeybindingsManagerFromConfig(userBindings);
}

/**
 * A binding the focused text field owns while it is live: a bare printable
 * character or Space. Modifier combinations are never printable.
 */
export function isPrintableKeyId(key: string): boolean {
	return !key.includes("+");
}

export function effectiveJouzuKeys(manager: JouzuKeybindingsManager, action: JouzuKeybinding): string[] {
	return manager.getKeys(action as Keybinding);
}

/**
 * Match raw input against the action's effective keys. While a text field is
 * live, its printable bindings belong to the field and cannot match.
 */
export function matchesJouzuKeybinding(
	manager: JouzuKeybindingsManager,
	data: string,
	action: JouzuKeybinding,
	options: { textFieldLive?: boolean } = {},
): boolean {
	return effectiveJouzuKeys(manager, action).some(
		(key) => !(options.textFieldLive && isPrintableKeyId(key)) && matchesKey(data, key as KeyId),
	);
}

/**
 * Format the action's effective keys for hints. While a text field is live,
 * printable bindings are omitted because they would type rather than act.
 */
export function formatEffectiveJouzuKeybinding(
	manager: JouzuKeybindingsManager,
	action: JouzuKeybinding,
	options: { textFieldLive?: boolean } = {},
): string {
	const keys = effectiveJouzuKeys(manager, action).filter((key) => !(options.textFieldLive && isPrintableKeyId(key)));
	return formatKeyIds(keys);
}
