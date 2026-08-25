import assert from "node:assert/strict";
import { test } from "node:test";

import { createSessionUiStyles, DEFAULT_SESSION_UI_STYLE_SCHEME } from "../dist/index.js";

const taggedTheme = {
	fg: (role, value) => `<${role}>${value}</${role}>`,
};

test("maps Jouzu semantic roles to the retained Session UI color baseline", () => {
	const styles = createSessionUiStyles(taggedTheme, { colorEnabled: true });
	assert.equal(styles.apply("prompt.border", "border"), "<borderMuted>border</borderMuted>");
	assert.equal(styles.apply("prompt.rail", "┃"), "\u001b[38;2;103;232;249m┃\u001b[39m");
	assert.equal(styles.apply("session.provider", "Codex"), "<dim>Codex</dim>");
	assert.equal(styles.apply("session.model", "gpt"), "<mdCode>gpt</mdCode>");
	assert.equal(styles.apply("status.workspace", "work"), "\u001b[38;2;215;215;255mwork\u001b[39m");
	assert.equal(styles.apply("status.git.branch", "main"), "<syntaxKeyword>main</syntaxKeyword>");
	assert.equal(styles.apply("status.git.changes", "[!]"), "<error>[!]</error>");
	assert.equal(styles.apply("status.context.normal", "19%"), "\u001b[38;2;250;204;21m19%\u001b[39m");
	assert.equal(styles.apply("status.tokens", "↑1k"), "\u001b[38;2;255;175;215m↑1k\u001b[39m");
	assert.equal(styles.apply("status.separator", " | "), "<borderMuted> | </borderMuted>");
});

test("preserves runtime-specific baseline mappings behind semantic roles", () => {
	const styles = createSessionUiStyles(taggedTheme, { colorEnabled: true });
	const expected = {
		node: "success",
		deno: "syntaxType",
		bun: "warning",
		python: "warning",
		java: "warning",
		rust: "error",
		ruby: "error",
		go: "syntaxType",
		lua: "accent",
		php: "accent",
		default: "text",
	};
	for (const [runtime, token] of Object.entries(expected)) {
		assert.equal(styles.apply(`status.runtime.${runtime}`, runtime), `<${token}>${runtime}</${token}>`);
	}
});

test("maps custom RGB roles to the selected terminal color mode", () => {
	const indexed = createSessionUiStyles(taggedTheme, { colorEnabled: true, colorMode: "256" });
	assert.equal(indexed.apply("status.workspace", "work"), "\u001b[38;5;189mwork\u001b[39m");
	const basic = createSessionUiStyles(taggedTheme, { colorEnabled: true, colorMode: "16" });
	assert.equal(basic.apply("prompt.rail", "┃"), "\u001b[96m┃\u001b[39m");
});

test("supports no-color output and replacement schemes without renderer changes", () => {
	const plain = createSessionUiStyles(taggedTheme, { colorEnabled: false });
	assert.equal(plain.apply("prompt.rail", "┃"), "┃");
	assert.equal(plain.apply("status.workspace", "work"), "work");
	const detectedPlain = createSessionUiStyles({ fg: (_role, value) => value }, { env: {} });
	assert.equal(detectedPlain.apply("prompt.rail", "┃"), "┃");
	const noColor = createSessionUiStyles(taggedTheme, { env: { NO_COLOR: "1" } });
	assert.equal(noColor.apply("status.workspace", "work"), "work");

	const scheme = {
		...DEFAULT_SESSION_UI_STYLE_SCHEME,
		"prompt.rail": { source: "theme", value: "accent" },
	};
	const themed = createSessionUiStyles(taggedTheme, { colorEnabled: true, scheme });
	assert.equal(themed.apply("prompt.rail", "┃"), "<accent>┃</accent>");
});
