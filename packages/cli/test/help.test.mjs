import assert from "node:assert/strict";
import { test } from "node:test";

import { createJouzuHelpExtension } from "../dist/help.js";

const identityTheme = {
	fg: (_role, value) => value,
	bold: (value) => value,
};

test("registers help shortcuts and renders effective semantic bindings", async () => {
	const shortcuts = new Map();
	createJouzuHelpExtension().factory({
		registerShortcut(shortcut, options) {
			shortcuts.set(shortcut, options);
		},
	});
	assert.deepEqual([...shortcuts.keys()], ["ctrl+/", "ctrl+?"]);

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
	assert.match(rendered, /Alt\+M.*Models/);
	assert.match(rendered, /F6.*Cycle favorites/);
	assert.match(rendered, /Ctrl\+X close/);
	assert.match(rendered, /Ctrl\+\/ or Ctrl\+\?.*Help/);
	assert.doesNotMatch(rendered, /Ctrl\+L|Ctrl\+P|Esc close/);
	assert.match(rendered, /\/hotkeys/);
});
