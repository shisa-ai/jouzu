import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDisplayContext } from "../dist/command-report.js";
import { loadCatalog } from "../dist/locale-catalog.js";
import {
	createSessionUiStyles,
	detectTerminalColorMode,
	renderPromptFrameLines,
	renderSessionLine,
	renderStatusBar,
	sessionUiText,
	terminalTextWidth,
} from "../dist/session-ui/index.js";

const identityTheme = {
	fg: (_role, value) => value,
	bg: (_role, value) => value,
	bold: (value) => value,
};

/** A theme that reports colour support, so the capability cases exercise the RGB roles. */
const colorTheme = {
	fg: (role, value) => `\u001b[38;5;${role.length % 200}m${value}\u001b[39m`,
	bg: (_role, value) => value,
	bold: (value) => value,
};

const plainStyles = createSessionUiStyles(identityTheme, { colorEnabled: false });

// The Session UI's own text, resolved from the shipped catalog once per locale.
const text = {
	en: sessionUiText(loadCatalog("en")),
	ja: sessionUiText(loadCatalog("ja")),
};

/**
 * A fixed Session UI state. It is a literal snapshot rather than a live
 * session, so the goldens move only when the renderers or the caller-supplied
 * text change. The workspace label is Japanese in every locale, which is what
 * a mixed-width session looks like on a real terminal.
 */
const snapshot = {
	schemaVersion: 1,
	observedAt: 1,
	workspace: { label: "日本語 project" },
	activity: { idle: true, idleSince: 1 },
	model: { providerId: "codex", modelId: "gpt-5.6-sol", thinkingLevel: "xhigh", scopedModelCount: 0 },
	context: { status: "known", observedAt: 1, value: { tokens: 38_000, window: 200_000, percent: 19 } },
	usage: {
		status: "known",
		observedAt: 1,
		value: { scope: "active_branch", inputTokens: 124_000, outputTokens: 9000, unknownMessageCount: 0 },
	},
	git: {
		status: "known",
		observedAt: 1,
		value: {
			branch: "feat/v0.1.2",
			dirty: true,
			ahead: 1,
			behind: 0,
			conflicted: 0,
			untracked: 1,
			stashed: 0,
			modified: 1,
			staged: 0,
			renamed: 0,
			deleted: 0,
			typeChanged: 0,
		},
	},
	runtime: { status: "known", observedAt: 1, value: { id: "node", version: "v24.16.0" } },
};

// The Session UI renders caller-supplied hint text. The `ja` hint is what the
// catalog migration will supply for the Palette shortcut hint; today the CLI
// passes one English literal (see the report), so the locale reaches the line
// only through this hint argument.
const hints = {
	en: [{ id: "palette", text: "/model choose", priority: 10, role: "muted" }],
	ja: [{ id: "palette", text: "モデル選択 · ヘルプ", priority: 10, role: "muted" }],
};

const SESSION_LINE_GOLDEN = {
	"en-48": "/model choose          Codex gpt-5.6-sol (xhigh)",
	"en-80": "/model choose                                          Codex gpt-5.6-sol (xhigh)",
	"en-120":
		"/model choose                                                                                  Codex gpt-5.6-sol (xhigh)",
	"ja-48": "モデル選択 · ヘルプ    Codex gpt-5.6-sol (xhigh)",
	"ja-80": "モデル選択 · ヘルプ                                    Codex gpt-5.6-sol (xhigh)",
	"ja-120":
		"モデル選択 · ヘルプ                                                                            Codex gpt-5.6-sol (xhigh)",
};

const STATUS_BAR_GOLDEN = {
	"en-48": "日本語 project · [!?↑] · node   19% | ↑124k | C?",
	"en-80": "日本語 project · feat/v0.1.2 [!?↑] · node v24.16.0     19%/200k | ↑124k ↓9k | C?",
	"en-120":
		"日本語 project · feat/v0.1.2 [!?↑] · node v24.16.0                                             19%/200k | ↑124k ↓9k | C?",
	"ja-48": "日本語 project · [!?↑] · node   19% | ↑124k | C?",
	"ja-80": "日本語 project · feat/v0.1.2 [!?↑] · node v24.16.0     19%/200k | ↑124k ↓9k | C?",
	"ja-120":
		"日本語 project · feat/v0.1.2 [!?↑] · node v24.16.0                                             19%/200k | ↑124k ↓9k | C?",
};

test("the Session UI line and status bar are fixed at 48, 80, and 120 columns in en and ja", () => {
	for (const locale of ["en", "ja"]) {
		for (const width of [48, 80, 120]) {
			const key = `${locale}-${width}`;
			const line = renderSessionLine(snapshot, hints[locale], width, plainStyles, text[locale]);
			const bar = renderStatusBar(snapshot, width, plainStyles, text[locale]);
			assert.equal(line, SESSION_LINE_GOLDEN[key], `line ${key}`);
			assert.equal(bar, STATUS_BAR_GOLDEN[key], `status bar ${key}`);
			assert.equal(terminalTextWidth(line), width, `line ${key} width`);
			assert.equal(terminalTextWidth(bar), width, `status bar ${key} width`);
		}
	}
});

test("the required status-bar segments survive at 48 columns in both locales", () => {
	for (const locale of ["en", "ja"]) {
		const bar = renderStatusBar(snapshot, 48, plainStyles, text[locale]);
		assert.ok(bar.includes("19%"), `${locale}: the required context segment was dropped`);
		assert.ok(bar.includes("日本語 project"), `${locale}: the workspace label was dropped`);
	}
});

// The prompt frame wraps editor content: the first and last base lines become
// the frame edges, and the middle lines carry the prompt. The content is the
// fixed editor state a translation change would touch; the leader is the only
// product-owned marker, and it must survive at 48 columns.
const PROMPT_BASE = {
	en: ["", "model: gpt-5.6-sol", "press Enter to send", ""],
	ja: ["", "モデル: gpt-5.6-sol", "Enter で送信", ""],
};

const PROMPT_FRAME_GOLDEN = {
	"en-48": [
		"────────────────────────────────────────────────",
		"❯ model: gpt-5.6-sol                            ",
		"  press Enter to send                           ",
		"────────────────────────────────────────────────",
	],
	"en-80": [
		"────────────────────────────────────────────────────────────────────────────────",
		"❯ model: gpt-5.6-sol                                                            ",
		"  press Enter to send                                                           ",
		"────────────────────────────────────────────────────────────────────────────────",
	],
	"en-120": [
		"────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
		"❯ model: gpt-5.6-sol                                                                                                    ",
		"  press Enter to send                                                                                                   ",
		"────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
	],
	"ja-48": [
		"────────────────────────────────────────────────",
		"❯ モデル: gpt-5.6-sol                           ",
		"  Enter で送信                                  ",
		"────────────────────────────────────────────────",
	],
	"ja-80": [
		"────────────────────────────────────────────────────────────────────────────────",
		"❯ モデル: gpt-5.6-sol                                                           ",
		"  Enter で送信                                                                  ",
		"────────────────────────────────────────────────────────────────────────────────",
	],
	"ja-120": [
		"────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
		"❯ モデル: gpt-5.6-sol                                                                                                   ",
		"  Enter で送信                                                                                                          ",
		"────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
	],
};

function promptFrameFor(locale, width, styles = plainStyles) {
	return renderPromptFrameLines(PROMPT_BASE[locale], width, 0, {
		border: (value) => styles.apply("prompt.border", value),
		leader: (value) => styles.apply("prompt.leader", value),
	});
}

test("the prompt frame is fixed at 48, 80, and 120 columns in en and ja", () => {
	for (const locale of ["en", "ja"]) {
		for (const width of [48, 80, 120]) {
			const key = `${locale}-${width}`;
			const frame = promptFrameFor(locale, width);
			assert.deepEqual(frame, PROMPT_FRAME_GOLDEN[key], `prompt frame ${key}`);
			for (const line of frame) {
				assert.equal(terminalTextWidth(line), width, `prompt frame ${key}: ${JSON.stringify(line)}`);
			}
		}
		const narrow = promptFrameFor(locale, 48).join("\n");
		assert.ok(narrow.includes("❯"), `${locale}: the prompt leader was dropped at 48 columns`);
		assert.ok(
			narrow.includes("model: gpt-5.6-sol") || narrow.includes("モデル: gpt-5.6-sol"),
			`${locale}: the prompt label was dropped at 48 columns`,
		);
	}
});

test("the Session UI's own text renders in the active locale", () => {
	const unhealthy = {
		...snapshot,
		model: { providerId: "codex", modelId: "", scopedModelCount: 0 },
		git: { status: "error", observedAt: 1 },
		runtime: { status: "unknown", observedAt: 1 },
	};
	const enLine = renderSessionLine(unhealthy, [], 80, plainStyles, text.en);
	const jaLine = renderSessionLine(unhealthy, [], 80, plainStyles, text.ja);
	assert.match(enLine, /no model/);
	assert.match(jaLine, /モデルなし/);
	assert.ok(!jaLine.includes("no model"), "the ja line carries no English model placeholder");
	const enBar = renderStatusBar(unhealthy, 80, plainStyles, text.en);
	const jaBar = renderStatusBar(unhealthy, 80, plainStyles, text.ja);
	assert.match(enBar, /! status/);
	assert.match(jaBar, /! 状態/);
	assert.equal(terminalTextWidth(jaLine), 80);
	assert.equal(terminalTextWidth(jaBar), 80);
});

test("the prompt frame text does not depend on colour", () => {
	const colored = createSessionUiStyles(colorTheme, { colorEnabled: true, colorMode: "truecolor", env: {} });
	for (const locale of ["en", "ja"]) {
		for (const width of [48, 80, 120]) {
			const frame = promptFrameFor(locale, width, colored);
			assert.ok(frame.join("\n").includes(ESCAPE), `${locale} at ${width}: the colour lane emits escapes`);
			assert.deepEqual(
				frame.map(stripSgr),
				PROMPT_FRAME_GOLDEN[`${locale}-${width}`],
				`${locale} at ${width}: colour removed no text`,
			);
		}
	}
});

const ESCAPE = String.fromCharCode(27);
const SGR = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "gu");
const stripSgr = (value) => value.replace(SGR, "");

/**
 * Render the fixed Session UI line and status bar under one capability
 * configuration. Every case reduces to the same no-colour text, because
 * meaning may not depend on colour.
 */
function renderUnder(styles) {
	return {
		line: renderSessionLine(snapshot, hints.en, 80, styles, text.en),
		bar: renderStatusBar(snapshot, 80, styles, text.en),
	};
}

test("truecolor renders the brand RGB roles with 24-bit escapes", () => {
	const { line, bar } = renderUnder(
		createSessionUiStyles(colorTheme, { colorEnabled: true, colorMode: "truecolor", env: {} }),
	);
	assert.ok(`${line}\n${bar}`.includes("\u001b[38;2;"), "truecolor uses 38;2 escapes");
	assert.equal(stripSgr(line), SESSION_LINE_GOLDEN["en-80"]);
	assert.equal(stripSgr(bar), STATUS_BAR_GOLDEN["en-80"]);
});

test("256 colours renders the brand RGB roles with indexed escapes", () => {
	const { line, bar } = renderUnder(
		createSessionUiStyles(colorTheme, { colorEnabled: true, colorMode: "256", env: {} }),
	);
	assert.ok(`${line}\n${bar}`.includes("\u001b[38;5;"), "256 uses 38;5 escapes");
	assert.ok(!`${line}\n${bar}`.includes("38;2;"), "256 does not use 24-bit escapes");
	assert.equal(stripSgr(line), SESSION_LINE_GOLDEN["en-80"]);
	assert.equal(stripSgr(bar), STATUS_BAR_GOLDEN["en-80"]);
});

test("16 colours renders the brand RGB roles with basic escapes", () => {
	const styles = createSessionUiStyles(colorTheme, { colorEnabled: true, colorMode: "16", env: {} });
	// The brand role is a Jouzu RGB colour, so it is the role the mode maps.
	const basic = new RegExp(`^${ESCAPE}\\[(3[0-7]|9[0-7])mgpt${ESCAPE}\\[39m$`, "u");
	assert.match(styles.apply("session.model", "gpt"), basic, "16 colours uses a basic colour code");
	const { line, bar } = renderUnder(styles);
	assert.equal(stripSgr(line), SESSION_LINE_GOLDEN["en-80"]);
	assert.equal(stripSgr(bar), STATUS_BAR_GOLDEN["en-80"]);
});

test("no colour renders no escape sequences and keeps the text", () => {
	const { line, bar } = renderUnder(createSessionUiStyles(colorTheme, { colorEnabled: false, env: {} }));
	assert.ok(!`${line}\n${bar}`.includes(ESCAPE), "NO_COLOR output carries no escapes");
	assert.equal(line, SESSION_LINE_GOLDEN["en-80"]);
	assert.equal(bar, STATUS_BAR_GOLDEN["en-80"]);
});

test("TERM=dumb renders no escape sequences and keeps the text", () => {
	const styles = createSessionUiStyles(colorTheme, { env: { TERM: "dumb" } });
	assert.equal(detectTerminalColorMode({ env: { TERM: "dumb" } }), "none");
	const { line, bar } = renderUnder(styles);
	assert.ok(!`${line}\n${bar}`.includes(ESCAPE), "a dumb terminal carries no escapes");
	assert.equal(line, SESSION_LINE_GOLDEN["en-80"]);
	assert.equal(bar, STATUS_BAR_GOLDEN["en-80"]);
});

test("a non-TTY stream is detected as no colour and a monochrome theme emits none", () => {
	// The shared colour detector resolves a redirected stream to no colour.
	assert.equal(detectTerminalColorMode({ env: {}, stdoutIsTTY: false }), "none");
	// The CLI's display context is the non-TTY policy: colour needs a terminal
	// unless FORCE_COLOR asks for it.
	const display = resolveDisplayContext({ env: {}, stdoutIsTTY: false });
	assert.equal(display.colorMode, "none");
	assert.equal(display.colorEnabled, false);
	// The Session UI only mounts in TUI mode; on a redirected stream it renders
	// through whatever theme it is given. A theme without colour support emits
	// no escapes, which is the reachable non-TTY rendering.
	const styles = createSessionUiStyles(identityTheme, { env: {}, stdoutIsTTY: false });
	const { line, bar } = renderUnder(styles);
	assert.ok(!`${line}\n${bar}`.includes(ESCAPE), "a non-TTY monochrome rendering carries no escapes");
	assert.equal(line, SESSION_LINE_GOLDEN["en-80"]);
	assert.equal(bar, STATUS_BAR_GOLDEN["en-80"]);
});
