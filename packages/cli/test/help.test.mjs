import assert from "node:assert/strict";
import { test } from "node:test";

import { createJouzuHelpExtension } from "../dist/help.js";

const identityTheme = {
	fg: (_role, value) => value,
	bold: (value) => value,
};

test("registers slash and question-mark help shortcuts and closes the overlay", async () => {
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
				const component = factory(
					{},
					identityTheme,
					{ matches: (data, action) => data === "escape" && action === "tui.select.cancel" },
					() => {
						closed = true;
					},
				);
				rendered = component.render(38).join("\n");
				component.handleInput("escape");
				assert.equal(closed, true);
			},
		},
	};
	await shortcuts.get("ctrl+/").handler(ctx);
	assert.equal(customOptions.overlay, true);
	assert.match(rendered, /Jouzu Help/);
	assert.match(rendered, /Ctrl\+L/);
	assert.match(rendered, /Ctrl\+P.*Cycle favorites/);
	assert.match(rendered, /\/hotkeys/);
});
