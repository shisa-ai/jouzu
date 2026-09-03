import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	createJouzuKeybindingsManager,
	createJouzuKeybindingsManagerFromConfig,
	effectiveJouzuKeys,
	formatEffectiveJouzuKeybinding,
	isPrintableKeyId,
	JOUZU_KEYBINDING_DEFINITIONS,
	matchesJouzuKeybinding,
} from "../dist/jouzu-keybindings.js";

const CTRL_SHIFT_B = "\u001b[98;6u";
const CTRL_SHIFT_S = "\u001b[115;6u";
const CTRL_F = "\u0006";
const CTRL_F_CSI = "\u001b[102;5u";

function tempPaths() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-keybindings-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	return { root, paths: { agentDir } };
}

test("Jouzu keybinding registry loads user overrides and ignores Pi-owned entries", () => {
	const { root, paths } = tempPaths();
	try {
		writeFileSync(
			join(paths.agentDir, "keybindings.json"),
			JSON.stringify({
				"tui.select.confirm": ["ctrl+s"],
				"jouzu.model.toggleFavorite": ["ctrl+shift+b"],
			}),
		);
		const manager = createJouzuKeybindingsManager(paths);
		assert.deepEqual(effectiveJouzuKeys(manager, "jouzu.model.toggleFavorite"), ["ctrl+shift+b"]);
		assert.equal(matchesJouzuKeybinding(manager, " ", "jouzu.model.toggleFavorite"), false);
		assert.equal(matchesJouzuKeybinding(manager, CTRL_SHIFT_B, "jouzu.model.toggleFavorite"), true);
		assert.equal(matchesJouzuKeybinding(manager, CTRL_SHIFT_S, "jouzu.model.toggleFavorite"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Jouzu keybinding registry keeps code defaults when the config is missing or malformed", () => {
	const { root, paths } = tempPaths();
	try {
		const missing = createJouzuKeybindingsManager(paths);
		assert.deepEqual(
			effectiveJouzuKeys(missing, "jouzu.model.toggleFavorite"),
			JOUZU_KEYBINDING_DEFINITIONS["jouzu.model.toggleFavorite"].defaultKeys,
		);

		writeFileSync(join(paths.agentDir, "keybindings.json"), "{not json");
		const malformed = createJouzuKeybindingsManager(paths);
		assert.deepEqual(
			effectiveJouzuKeys(malformed, "jouzu.model.toggleFavorite"),
			JOUZU_KEYBINDING_DEFINITIONS["jouzu.model.toggleFavorite"].defaultKeys,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Jouzu keybinding matching and hints respect a live text field", () => {
	const manager = createJouzuKeybindingsManagerFromConfig();
	assert.equal(isPrintableKeyId("space"), true);
	assert.equal(isPrintableKeyId("f"), true);
	assert.equal(isPrintableKeyId("ctrl+shift+s"), false);

	assert.equal(matchesJouzuKeybinding(manager, CTRL_F, "jouzu.model.toggleFavorite"), true);
	assert.equal(
		matchesJouzuKeybinding(manager, CTRL_F_CSI, "jouzu.model.toggleFavorite"),
		true,
		"the control byte and the enhanced-protocol encoding both match",
	);
	assert.equal(
		matchesJouzuKeybinding(manager, " ", "jouzu.model.toggleFavorite"),
		false,
		"Space is no longer a favorite binding",
	);
	assert.equal(
		matchesJouzuKeybinding(manager, "\x1b[13;2u", "jouzu.model.toggleFavorite"),
		false,
		"Shift+Enter belongs to Pi's newline action and no longer toggles favorite",
	);
	assert.equal(
		matchesJouzuKeybinding(manager, CTRL_SHIFT_S, "jouzu.model.toggleFavorite"),
		false,
		"Ctrl+Shift+S is no longer a favorite accelerator",
	);
	assert.equal(
		matchesJouzuKeybinding(manager, CTRL_F, "jouzu.model.toggleFavorite", { textFieldLive: true }),
		true,
		"the accelerator works while the field is live",
	);
	assert.equal(matchesJouzuKeybinding(manager, "f", "jouzu.model.toggleFavorite"), false);

	assert.equal(formatEffectiveJouzuKeybinding(manager, "jouzu.model.toggleFavorite"), "Ctrl+F");
	assert.equal(
		formatEffectiveJouzuKeybinding(manager, "jouzu.model.toggleFavorite", { textFieldLive: true }),
		"Ctrl+F",
		"hints keep modified bindings while the field is live",
	);
});
