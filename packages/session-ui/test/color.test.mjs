import assert from "node:assert/strict";
import { test } from "node:test";

import { detectTerminalColorMode, renderTerminalRgb, rgbToAnsi16, rgbToAnsi256 } from "../dist/index.js";

test("detects truecolor, indexed, basic, and no-color terminal modes", () => {
	assert.equal(detectTerminalColorMode({ colorDepth: 24, env: {} }), "truecolor");
	assert.equal(detectTerminalColorMode({ colorDepth: 8, env: {} }), "256");
	assert.equal(detectTerminalColorMode({ colorDepth: 4, env: {} }), "16");
	assert.equal(detectTerminalColorMode({ env: { TERM: "xterm-256color" }, stdoutIsTTY: false }), "256");
	assert.equal(detectTerminalColorMode({ env: { TERM: "xterm" }, stdoutIsTTY: false }), "16");
	assert.equal(detectTerminalColorMode({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: false }), "truecolor");
	assert.equal(detectTerminalColorMode({ env: { NO_COLOR: "1", COLORTERM: "truecolor" } }), "none");
	assert.equal(detectTerminalColorMode({ env: { TERM: "dumb" } }), "none");
});

test("maps Jouzu RGB colors to bounded terminal palettes", () => {
	const cyan = { red: 103, green: 232, blue: 249 };
	assert.equal(rgbToAnsi256(cyan.red, cyan.green, cyan.blue), 81);
	assert.equal(rgbToAnsi16(cyan.red, cyan.green, cyan.blue), 96);
	assert.equal(renderTerminalRgb("x", cyan, "truecolor"), "\u001b[38;2;103;232;249mx\u001b[39m");
	assert.equal(renderTerminalRgb("x", cyan, "256"), "\u001b[38;5;81mx\u001b[39m");
	assert.equal(renderTerminalRgb("x", cyan, "16"), "\u001b[96mx\u001b[39m");
	assert.equal(renderTerminalRgb("x", cyan, "none"), "x");
});
