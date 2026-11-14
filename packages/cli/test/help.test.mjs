import assert from "node:assert/strict";
import { test } from "node:test";

import { createJouzuHelpExtension } from "../dist/help.js";
import { resolveCatalog } from "../dist/locale-catalog.js";

const identityTheme = {
	fg: (_role, value) => value,
	bold: (value) => value,
};

test("registers /help and shortcuts with the same overlay and effective bindings", async () => {
	const shortcuts = new Map();
	const commands = new Map();
	createJouzuHelpExtension().factory({
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerShortcut(shortcut, options) {
			shortcuts.set(shortcut, options);
		},
	});
	assert.deepEqual([...shortcuts.keys()], ["ctrl+/", "ctrl+?"]);
	assert.deepEqual([...commands.keys()], ["help"]);
	assert.equal(commands.get("help").description, shortcuts.get("ctrl+/").description);

	let customOptions;
	let rendered = "";
	const ctx = {
		mode: "tui",
		ui: {
			async custom(factory, options) {
				customOptions = options;
				let closed = false;
				const keys = {
					"app.model.select": ["alt+m"],
					"app.model.cycleForward": ["f6"],
					"tui.select.cancel": ["ctrl+x"],
				};
				const component = factory(
					{},
					identityTheme,
					{
						matches: (data, action) => keys[action]?.includes(data) ?? false,
						getKeys: (action) => [...(keys[action] ?? [])],
					},
					() => {
						closed = true;
					},
				);
				rendered = component.render(38).join("\n");
				component.handleInput("ctrl+x");
				assert.equal(closed, true);
			},
		},
	};
	await shortcuts.get("ctrl+/").handler(ctx);
	assert.equal(customOptions.overlay, true);
	assert.match(rendered, /Jouzu Help/);
	assert.ok(rendered.includes(`${process.platform === "darwin" ? "Option" : "Alt"}+M  Models`));
	assert.match(rendered, /F6.*Cycle favorites/);
	assert.match(rendered, /Ctrl\+X close/);
	assert.match(rendered, /Ctrl\+\/ or Ctrl\+\?.*Help/);
	assert.doesNotMatch(rendered, /Ctrl\+L|Ctrl\+P|Esc close/);
	assert.match(rendered, /\/plugins.*Plugins and customization/);
	assert.match(rendered, /\/hotkeys/);
	assert.match(rendered, /\/scrollback.*Export transcript/);
	const shortcutRendered = rendered;
	rendered = "";
	await commands.get("help").handler("", ctx);
	assert.equal(rendered, shortcutRendered);
	assert.equal(customOptions.overlay, true);
	await commands.get("help").handler("", {
		mode: "rpc",
		ui: { custom: () => assert.fail("non-TUI help must not open an overlay") },
	});
});

test("renders the overlay labels from the Japanese catalog with resolved keys", async () => {
	const shortcuts = new Map();
	const commands = new Map();
	createJouzuHelpExtension(resolveCatalog("ja").bundle).factory({
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerShortcut(shortcut, options) {
			shortcuts.set(shortcut, options);
		},
	});

	let rendered = "";
	const ctx = {
		mode: "tui",
		ui: {
			async custom(factory) {
				const keys = {
					"app.model.select": ["alt+m"],
					"app.model.cycleForward": ["f6"],
					"tui.select.cancel": ["ctrl+x"],
				};
				const component = factory(
					{},
					identityTheme,
					{
						matches: (data, action) => keys[action]?.includes(data) ?? false,
						getKeys: (action) => [...(keys[action] ?? [])],
					},
					() => {},
				);
				rendered = component.render(38).join("\n");
			},
		},
	};
	await shortcuts.get("ctrl+/").handler(ctx);
	assert.match(rendered, /Jouzu Help/);
	assert.ok(rendered.includes(`${process.platform === "darwin" ? "Option" : "Alt"}+M  モデル`));
	assert.match(rendered, /F6.*お気に入りを切り替え/);
	assert.match(rendered, /Ctrl\+X 閉じる/);
	assert.match(rendered, /Ctrl\+\/ または Ctrl\+\?.*ヘルプ/);
	assert.match(rendered, /\/hotkeys.*すべてのキーバインド/);
	assert.doesNotMatch(rendered, /Models|All shortcuts/);
	// The shortcut description Pi shows in its hotkeys table is catalog text too.
	assert.equal(shortcuts.get("ctrl+/").description, "Jouzu ヘルプを開く");
	assert.equal(commands.get("help").description, "Jouzu ヘルプを開く");
	const shortcutRendered = rendered;
	rendered = "";
	await commands.get("help").handler("", ctx);
	assert.equal(rendered, shortcutRendered);
});
