import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createInteractiveTui } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";
import {
	KeybindingsManager,
	StdinBuffer,
	setCapabilities,
	visibleWidth,
} from "../../../node_modules/@earendil-works/pi-tui/dist/index.js";

import {
	createScrollbackExtension,
	isScrollbackReturnKey,
	renderScrollbackTranscript,
	sanitizeScrollbackText,
} from "../dist/scrollback.js";

setCapabilities({ images: null, trueColor: false, hyperlinks: false });

const COLUMNS = 100;
const ROWS = 30;
const DRAFT = "[paste #1 +12 lines]";
const EXPORTED_AT = new Date("2026-01-01T00:00:00.000Z");
const HINT = "Press Enter, Escape, or Ctrl+C to return to Jouzu.";
const SELECT_KEYBINDINGS = {
	"tui.select.confirm": { defaultKeys: ["enter"] },
	"tui.select.cancel": { defaultKeys: ["escape", "ctrl+c"] },
};

const theme = {
	fg: (_role, value) => value,
	bg: (_role, value) => value,
	bold: (value) => value,
	borderColor: (value) => value,
	selectList: {
		selectedPrefix: (value) => value,
		selectedText: (value) => value,
		description: (value) => value,
		scrollInfo: (value) => value,
		noMatch: (value) => value,
	},
};

let nextEntryId = 0;
function entry(type, fields = {}) {
	nextEntryId += 1;
	return {
		type,
		id: `entry-${nextEntryId}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		...fields,
	};
}

function message(role, fields = {}) {
	return entry("message", { message: { role, timestamp: 1, ...fields } });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, label = "condition", timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await tick();
	}
	throw new Error(`timed out waiting for ${label}`);
}

/** Records the bytes Pi's real renderer writes. It is not an emulator. */
class RecordingTerminal {
	columns = COLUMNS;
	rows = ROWS;
	kittyProtocolActive = false;
	output = "";
	writes = [];
	startCalls = 0;
	stopCalls = 0;
	onInput;
	onResize;
	titles = [];

	start(onInput, onResize) {
		this.startCalls += 1;
		this.onInput = onInput;
		this.onResize = onResize;
	}

	stop() {
		this.stopCalls += 1;
		this.onInput = undefined;
	}

	async drainInput() {}

	write(data) {
		this.output += data;
		this.writes.push(data);
	}

	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle(title) {
		this.titles.push(title);
	}
	setProgress() {}
}

class FailingWriteTerminal extends RecordingTerminal {
	failOn = "";

	write(data) {
		if (this.failOn && data.includes(this.failOn)) throw new Error("simulated write failure \u001b]0;evil\u0007");
		super.write(data);
	}
}

class FailingStartTerminal extends RecordingTerminal {
	failStartAt = 0;

	start(onInput, onResize) {
		this.startCalls += 1;
		if (this.startCalls === this.failStartAt) throw new Error("simulated terminal start failure");
		this.onInput = onInput;
		this.onResize = onResize;
	}
}

class FakeEditor {
	focused = false;
	lastInput;
	setTextCalls = 0;

	constructor(text) {
		this.text = text;
	}

	getText() {
		return this.text;
	}

	setText(text) {
		this.text = text;
		this.setTextCalls += 1;
	}

	render(width) {
		return [`> ${this.text}`.slice(0, Math.max(1, width))];
	}

	invalidate() {}

	handleInput(data) {
		this.lastInput = data;
	}
}

function createPi() {
	const commands = new Map();
	const handlers = new Map();
	const shortcuts = [];
	return {
		commands,
		handlers,
		shortcuts,
		registerCommand(name, options) {
			commands.set(name, options);
		},
		on(name, handler) {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		registerShortcut(...args) {
			shortcuts.push(args);
		},
	};
}

/** Mirrors Pi's showExtensionCustom() overlay path closely enough to exercise the real TUI. */
function makeCustom(tui, editor, keybindings) {
	const surfaces = [];
	let calls = 0;
	const custom = (factory, options = {}) => {
		calls += 1;
		return new Promise((resolve, reject) => {
			let component;
			let handle;
			let closed = false;
			const close = (result) => {
				if (closed) return;
				closed = true;
				if (options.overlay) {
					handle?.hide();
				} else {
					tui.removeChild(component);
					tui.addChild(editor);
					tui.setFocus(editor);
				}
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					// Match Pi: dispose failures do not reject the custom() promise.
				}
				tui.requestRender();
			};
			Promise.resolve(factory(tui, theme, keybindings, close))
				.then((created) => {
					if (closed) return;
					component = created;
					if (options.overlay) {
						handle = tui.showOverlay(created, options.overlayOptions);
						options.onHandle?.(handle);
					} else {
						tui.addChild(created);
						tui.setFocus(created);
					}
					surfaces.push({ component: created, options });
					tui.requestRender();
				})
				.catch((error) => {
					if (!closed) reject(error);
				});
		});
	};
	return { custom, surfaces, calls: () => calls };
}

function createContext({ ui, branch, state, mode, hasUI, sessionId, sessionName }) {
	return {
		mode,
		hasUI,
		sessionManager: {
			getBranch() {
				state.getBranchCalls += 1;
				return branch;
			},
			getSessionId: () => sessionId,
			getSessionName: () => sessionName,
			getEntries() {
				throw new Error("the export must not read all session entries");
			},
			getTree() {
				throw new Error("the export must not read the session tree");
			},
			getSessionFile() {
				throw new Error("the export must not read the session file");
			},
		},
		isIdle: () => state.idle,
		signal: state.signal,
		hasPendingMessages: () => state.pending,
		ui: {
			custom: ui.custom,
			notify: (text, type) => state.notifications.push({ text, type }),
			setEditorText: (...args) => state.editorTextCalls.push(args),
		},
	};
}

async function createHarness(options = {}) {
	const {
		terminal = new RecordingTerminal(),
		tuiMode = "fullscreen",
		branch = [],
		idle = true,
		signal,
		pending = false,
		mode = "tui",
		hasUI = true,
		sessionId = "session-1",
		sessionName,
		keybindings: keybindingsOption,
		deps = {},
	} = options;
	const root = mkdtempSync(join(tmpdir(), "jouzu-scrollback-"));
	const tui = createInteractiveTui({ terminal, tuiMode, showHardwareCursor: false, logDirectory: root });
	const editor = new FakeEditor(DRAFT);
	tui.start();
	tui.addChild(editor);
	tui.setFocus(editor);
	tui.renderNow(true);
	const keybindings = keybindingsOption ?? new KeybindingsManager(SELECT_KEYBINDINGS);
	const ui = makeCustom(tui, editor, keybindings);
	const state = {
		idle,
		signal,
		pending,
		getBranchCalls: 0,
		notifications: [],
		editorTextCalls: [],
	};
	const ctx = createContext({ ui, branch, state, mode, hasUI, sessionId, sessionName });
	const pi = createPi();
	const extension = createScrollbackExtension({
		isTTY: () => true,
		env: { TERM: "xterm-256color" },
		now: () => EXPORTED_AT,
		chunkSize: 4096,
		...deps,
	});
	extension.factory(pi);
	return {
		root,
		terminal,
		tui,
		editor,
		keybindings,
		ui,
		ctx,
		pi,
		state,
		extension,
		command: pi.commands.get("scrollback"),
		cleanup() {
			try {
				tui.stop();
			} catch {
				// Best-effort test cleanup.
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

async function beginExport(harness) {
	const from = harness.terminal.output.length;
	const promise = harness.command.handler("", harness.ctx);
	await waitFor(
		() => harness.terminal.output.indexOf("Jouzu transcript export", from) >= 0,
		"the transcript to reach the terminal",
	);
	// Return an object so awaiting beginExport() does not adopt the open export promise.
	return { promise };
}

async function returnFromExport(harness, promise, key = "\r") {
	assert.equal(typeof harness.terminal.onInput, "function", "the export owns terminal input");
	harness.terminal.onInput(key);
	await promise;
	await tick();
	harness.tui.renderNow(true);
}

function transcriptText(terminal, fromIndex = 0) {
	const start = terminal.output.indexOf("Jouzu transcript export", fromIndex);
	if (start < 0) return "";
	const end = terminal.output.indexOf("Scroll and copy with your terminal or tmux.", start);
	return terminal.output.slice(start, end < 0 ? undefined : end + "Scroll and copy with your terminal or tmux.".length);
}

function assertPlainText(value, label) {
	for (const char of value) {
		const code = char.charCodeAt(0);
		assert.ok(
			code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)),
			`${label} contains a control character U+${code.toString(16).padStart(4, "0")}`,
		);
	}
}

test("exports the active branch through the real fullscreen renderer and returns", async () => {
	const branch = [
		message("system", { content: "SECRET SYSTEM PROMPT" }),
		message("user", {
			content: [
				{ type: "text", text: "hello 日本語" },
				{ type: "image", data: "QUJD", mimeType: "image/png" },
			],
		}),
		message("assistant", {
			content: [
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "plan" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
			],
			stopReason: "toolUse",
		}),
		message("toolResult", {
			toolCallId: "t1",
			toolName: "bash",
			content: [{ type: "text", text: "file.txt" }],
			isError: false,
		}),
		entry("custom_message", { customType: "note", content: "custom note", display: true }),
		entry("compaction", { summary: "older context", firstKeptEntryId: "entry-1", tokensBefore: 1234 }),
		entry("branch_summary", { summary: "other branch", fromId: "abc" }),
		message("bashExecution", {
			command: "echo hi",
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		}),
		entry("model_change", { provider: "provider", modelId: "model" }),
		message("user", { content: "after compaction" }),
	];
	const harness = await createHarness({ branch });
	try {
		assert.equal(harness.tui.constructor.name, "TuiAltScreen");
		assert.equal(harness.tui.mode, "fullscreen");
		const { promise } = await beginExport(harness);

		const altExit = harness.terminal.output.indexOf("\u001b[?1049l");
		const transcriptStart = harness.terminal.output.indexOf("Jouzu transcript export");
		assert.ok(altExit >= 0, "the export leaves the alternate screen");
		assert.ok(transcriptStart > altExit, "the transcript is written after leaving the alternate screen");
		assert.equal(harness.terminal.output.slice(0, altExit).includes("Jouzu transcript export"), false);

		const body = transcriptText(harness.terminal);
		for (const expected of [
			"Jouzu transcript export",
			"Session: session-1",
			"Exported: 2026-01-01T00:00:00.000Z",
			"Scope: stored entries on the active branch",
			"Limits: system prompts, tool details, and raw image data are not included",
			"User",
			"hello 日本語",
			"[image: image/png, 3 B]",
			"Assistant",
			"answer",
			"Thinking",
			"plan",
			"Tool call: bash",
			'"command": "ls"',
			"Tool result: bash",
			"file.txt",
			"Custom message (note)",
			"custom note",
			"Compaction summary",
			"older context",
			"1234 tokens before",
			"Branch summary",
			"other branch",
			"[from abc]",
			"Bash",
			"$ echo hi",
			"hi",
			"[exit code 0]",
			"after compaction",
			HINT,
		]) {
			assert.ok(body.includes(expected), `the transcript includes ${JSON.stringify(expected)}`);
		}
		assert.equal(body.includes("SECRET SYSTEM PROMPT"), false, "the system prompt is omitted");
		assert.equal(body.includes("QUJD"), false, "raw image data is not exported");
		assert.equal(body.includes("OFF BRANCH SECRET"), false, "only the supplied active branch is read");
		assert.equal(harness.state.getBranchCalls, 1, "the export reads the active branch");
		assertPlainText(body, "the transcript");

		assert.equal(harness.tui.hasOverlay(), true, "the custom screen is mounted as an overlay");
		assert.equal(harness.ui.surfaces[0].options.overlay, true, "the overlay preserves the editor container");
		assert.equal(harness.editor.getText(), DRAFT, "the draft is unchanged while the export is open");
		assert.equal(harness.terminal.titles.length, 0, "the export does not change the terminal title");

		const beforeReturn = harness.terminal.output.length;
		harness.tui.requestRender(true);
		await tick();
		assert.equal(harness.terminal.output.length, beforeReturn, "the stopped renderer does not redraw over the export");

		await returnFromExport(harness, promise, "\r");
		assert.ok(harness.terminal.output.lastIndexOf("\u001b[?1049h") > transcriptStart, "the TUI re-enters fullscreen");
		assert.equal(harness.tui.hasOverlay(), false, "return closes the overlay");
		assert.equal(harness.tui.getFocusedComponent(), harness.editor, "focus returns to the prompt");
		assert.equal(harness.editor.getText(), DRAFT, "the draft survives the export");
		assert.equal(harness.editor.setTextCalls, 0, "the export never rewrites the editor");
		assert.equal(harness.state.editorTextCalls.length, 0, "the export never sets editor text");
		assert.equal(harness.tui.mode, "fullscreen", "the TUI mode is unchanged");
		assert.equal(harness.terminal.titles.length, 0, "the terminal title is still unchanged");
		assert.equal(harness.state.notifications.length, 0, "a successful return needs no notification");
	} finally {
		harness.cleanup();
	}
});

test("Enter, Escape, and Ctrl+C all return from the export", async () => {
	for (const [name, key] of [
		["Enter", "\r"],
		["Escape", "\u001b"],
		["Ctrl+C", "\u0003"],
	]) {
		await test(name, async () => {
			const harness = await createHarness({ branch: [message("user", { content: "hello" })] });
			try {
				const { promise } = await beginExport(harness);
				await returnFromExport(harness, promise, key);
				assert.equal(harness.tui.hasOverlay(), false, `${name} closes the export`);
				assert.equal(harness.terminal.output.includes(HINT), true, "the return hint is printed");
				assert.equal(harness.editor.getText(), DRAFT, `${name} preserves the draft`);
			} finally {
				harness.cleanup();
			}
		});
	}
});

test("a real StdinBuffer batch cannot leak trailing input into the editor", async () => {
	const harness = await createHarness({ branch: [message("user", { content: "hello" })] });
	const buffer = new StdinBuffer();
	buffer.on("data", (sequence) => harness.terminal.onInput?.(sequence));
	buffer.on("paste", (content) => harness.terminal.onInput?.(`\u001b[200~${content}\u001b[201~`));
	try {
		const { promise } = await beginExport(harness);

		buffer.process("\u001b[200~\rtext\r\u001b[201~");
		assert.equal(harness.tui.hasOverlay(), true, "pasted return keys do not dismiss");
		assert.equal(harness.editor.lastInput, undefined, "paste payload never reaches the editor");

		buffer.process("\rtext\r");
		assert.equal(harness.tui.hasOverlay(), false, "the first Enter closes the export");
		assert.equal(harness.terminal.startCalls, 2, "the restart waits for the parser batch to unwind");
		assert.equal(typeof harness.terminal.onInput, "function", "the closed input sink stays installed");
		assert.equal(harness.editor.lastInput, undefined, "the rest of the batch is swallowed");
		harness.terminal.onInput("still-closed");
		assert.equal(harness.editor.lastInput, undefined, "the sink ignores input until restart");

		await promise;
		await tick();
		assert.equal(harness.terminal.startCalls, 3, "the deferred restart happens once");
		assert.equal(harness.editor.lastInput, undefined, "the deferred restart does not replay the batch");
		harness.terminal.onInput("x");
		assert.equal(harness.editor.lastInput, "x", "the restarted TUI owns input again");
		assert.equal(harness.editor.getText(), DRAFT);
	} finally {
		buffer.destroy();
		harness.cleanup();
	}
});

test("literal return keys still work after semantic rebinding", async () => {
	const rebound = new KeybindingsManager(SELECT_KEYBINDINGS, {
		"tui.select.confirm": ["space"],
		"tui.select.cancel": ["q"],
	});
	assert.equal(isScrollbackReturnKey("\r", rebound), true, "literal Enter is guaranteed");
	assert.equal(isScrollbackReturnKey("\u001b", rebound), true, "literal Escape is guaranteed");
	assert.equal(isScrollbackReturnKey("\u0003", rebound), true, "literal Ctrl+C is guaranteed");
	assert.equal(isScrollbackReturnKey(" ", rebound), true, "the rebound confirm key works");
	assert.equal(isScrollbackReturnKey("q", rebound), true, "the rebound cancel key works");
	assert.equal(isScrollbackReturnKey("a", rebound), false);
	assert.equal(isScrollbackReturnKey("\u001b[200~\r\u001b[201~", rebound), false);
	assert.equal(isScrollbackReturnKey("\u001b[13;1:3u", rebound), false);

	const harness = await createHarness({
		keybindings: rebound,
		branch: [message("user", { content: "hello" })],
	});
	try {
		const { promise } = await beginExport(harness);
		await returnFromExport(harness, promise, " ");
		assert.equal(harness.tui.hasOverlay(), false);
		assert.ok(
			harness.terminal.output.lastIndexOf("\u001b[?1049h") > harness.terminal.output.lastIndexOf("\u001b[?1049l"),
		);
		assert.equal(harness.editor.getText(), DRAFT);
	} finally {
		harness.cleanup();
	}
});

test("bracketed paste and key releases are inert; data after return is swallowed", async () => {
	const harness = await createHarness({ branch: [message("user", { content: "hello" })] });
	try {
		const { promise } = await beginExport(harness);
		const returnHandler = harness.terminal.onInput;
		const altExit = harness.terminal.output.lastIndexOf("\u001b[?1049l");

		harness.terminal.onInput("\u001b[200~\r\u001b[201~");
		harness.terminal.onInput("\u001b[200~\u001b\u001b[201~");
		harness.terminal.onInput("\u001b[13;1:3u");
		harness.terminal.onInput("\u001b[27;1:3u");
		await tick();
		assert.equal(harness.tui.hasOverlay(), true, "pasted return keys and key releases do not dismiss");
		assert.equal(
			harness.terminal.output.lastIndexOf("\u001b[?1049l"),
			altExit,
			"the export is still on the main screen",
		);

		harness.terminal.onInput("\r");
		await promise;
		await tick();
		const reentry = harness.terminal.output.lastIndexOf("\u001b[?1049h");
		const outputLength = harness.terminal.output.length;

		// The old handler is detached; calling it cannot restore a second time or replay data.
		returnHandler("\r");
		returnHandler("leaked text");
		await tick();
		assert.equal(harness.terminal.output.lastIndexOf("\u001b[?1049h"), reentry, "a stale handler cannot re-enter");
		assert.equal(harness.terminal.output.length, outputLength, "a stale handler writes nothing");
		assert.notEqual(harness.editor.lastInput, "leaked text", "input after return does not reach the editor");
		assert.equal(harness.editor.getText(), DRAFT, "the draft is unchanged");

		// The TUI owns input again and routes ordinary keys to the prompt.
		harness.terminal.onInput("x");
		assert.equal(harness.editor.lastInput, "x", "the restarted TUI owns the input handler");
	} finally {
		harness.cleanup();
	}
});

test("sanitizes hostile OSC, DCS, APC, PM, SOS, C0, and C1 before line splitting", () => {
	assert.equal(sanitizeScrollbackText("a\r\nb\rc"), "a\nb\nc");
	assert.equal(sanitizeScrollbackText("a\tb"), "a    b");
	assert.equal(sanitizeScrollbackText("a\u001b]0;x\u0007b"), "ab");
	assert.equal(sanitizeScrollbackText("a\u001b]0;x\nstill evil\u0007b"), "ab");
	assert.equal(sanitizeScrollbackText("a\u001b]0;x\nstill evil"), "a");
	assert.equal(sanitizeScrollbackText("a\u001b]0;x\u001b\\b"), "ab");
	assert.equal(sanitizeScrollbackText("a\u001b]0;x\u009cb"), "ab");
	assert.equal(sanitizeScrollbackText("a\u001b[31mb"), "ab");
	assert.equal(sanitizeScrollbackText("a\u001b[31"), "a");
	assert.equal(sanitizeScrollbackText("a\u009b31mb"), "ab");
	assert.equal(sanitizeScrollbackText("a\u001bPdcs\u001b\\b"), "ab");
	assert.equal(sanitizeScrollbackText("a\u001b_apc\u001b\\b"), "ab");
	assert.equal(sanitizeScrollbackText("a\u001b^pm\u001b\\b"), "ab");
	assert.equal(sanitizeScrollbackText("a\u001bXsos\u001b\\b"), "ab");
	// A malformed C1 CSI still consumes through its final byte; no control text leaks.
	assert.equal(sanitizeScrollbackText("a\u0000\u0001\u0007\u007f\u009b\u009db"), "a");
	assert.equal(sanitizeScrollbackText("a\u001b\\b"), "ab");
	assert.equal(sanitizeScrollbackText("a\u001b7b"), "ab");
	assert.equal(sanitizeScrollbackText("a\u001b"), "a");
	assert.equal(sanitizeScrollbackText("a\uD800b"), "a\uFFFDb");
	assert.equal(sanitizeScrollbackText("日本語🙂e\u0301"), "日本語🙂e\u0301");
});

test("keeps hostile branch text plain and documents history limits", async () => {
	const hostile = [
		"before\u001b]0;evil title\u0007after",
		"line\u001b[31mred\u001b[0m",
		"dcs\u001bP1;2;3+q\u001b\\done",
		"apc\u001b_apc payload\u001b\\done",
		"pm\u001b^pm payload\u001b\\done",
		"sos\u001bXsos payload\u001b\\done",
		"controls\u0000\u0001\u0007\u007f\u009b\u009d",
		"tab\there",
		"日本語🙂e\u0301",
		"unterminated\u001b]0;still evil\nstill evil",
	].join("\n");
	const harness = await createHarness({ branch: [message("user", { content: hostile })] });
	try {
		const { promise } = await beginExport(harness);
		const body = transcriptText(harness.terminal);
		assertPlainText(body, "the hostile transcript");
		assert.equal(body.includes("\u001b"), false);
		assert.equal(body.includes("\u0007"), false);
		assert.equal(body.includes("\u0000"), false);
		assert.equal(body.includes("\u009b"), false);
		assert.equal(body.includes("\u009d"), false);
		for (const expected of ["beforeafter", "linered", "dcsdone", "apcdone", "pmdone", "sosdone", "unterminated"]) {
			assert.ok(body.includes(expected), `the sanitized text keeps ${JSON.stringify(expected)}`);
		}
		assert.equal(body.includes("evil title"), false, "OSC payloads are removed");
		assert.equal(body.includes("still evil"), false, "unterminated OSC payloads are removed");
		assert.ok(body.includes("日本語🙂e\u0301"), "Unicode survives sanitization");
		await returnFromExport(harness, promise);
	} finally {
		harness.cleanup();
	}
});

test("fits every rendered line to the requested width with CJK and emoji", () => {
	const branch = [
		message("user", {
			content: `${"日本語".repeat(20)} ${"🙂".repeat(10)} ${"e\u0301".repeat(10)}`,
		}),
	];
	for (const width of [12, 24, 48, 100]) {
		const document = renderScrollbackTranscript(branch, {
			width,
			sessionId: "session-1",
			exportedAt: EXPORTED_AT,
		});
		for (const line of document.lines) {
			assert.ok(visibleWidth(line) <= width, `width ${width} line ${JSON.stringify(line)} is ${visibleWidth(line)}`);
		}
		const joined = document.lines.join("");
		assert.ok(joined.includes("日本語"), `width ${width} preserves CJK text`);
		assert.ok(joined.includes("🙂"), `width ${width} preserves emoji`);
		assert.ok(joined.includes("e\u0301"), `width ${width} preserves combining text`);
	}
});

test("structured inference text survives scrollback width wrapping", async () => {
	const { normalizeProviderError, formatProviderError } = await import(
		"../../../node_modules/@earendil-works/pi-ai/dist/utils/error-body.js"
	);
	const errorMessage = formatProviderError(
		normalizeProviderError(
			Object.assign(new Error("SDK error"), {
				status: 429,
				error: {
					code: "free_allowance_exhausted",
					type: "free_allowance_exhausted",
					message: "Add credits.\u001b\u202e\r\n日本語 👩‍💻",
				},
			}),
		),
	);
	for (const width of [24, 48, 100]) {
		const document = renderScrollbackTranscript(
			[message("assistant", { content: [], stopReason: "error", errorMessage })],
			{ width, sessionId: "structured", exportedAt: EXPORTED_AT },
		);
		const text = document.lines.map((line) => line.trim()).join("");
		assert.ok(text.includes("Addcredits.") || text.includes("Add credits."));
		assert.ok(text.includes("free_allowance_exhausted"));
		assert.equal(text.includes("\u001b"), false);
		assert.equal(text.includes("\u202e"), false);
		assert.doesNotMatch(text, /"type":/);
		for (const line of document.lines) assert.ok(visibleWidth(line) <= width);
	}
});

test("renders 150k+ lines without argument overflow", () => {
	const count = 150_500;
	const content = Array.from({ length: count }, (_value, index) => `line ${index}`).join("\n");
	const document = renderScrollbackTranscript([message("user", { content })], {
		width: 80,
		sessionId: "large",
		exportedAt: EXPORTED_AT,
	});
	assert.ok(document.lines.length >= count, `rendered ${document.lines.length} lines`);
	assert.ok(
		document.lines.some((line) => line.trim() === `line ${count - 1}`),
		"the final line is present",
	);
});

test("renders an empty session and reports zero counts", () => {
	const document = renderScrollbackTranscript([], { width: 120, sessionId: "empty", exportedAt: EXPORTED_AT });
	assert.equal(document.entryCount, 0);
	assert.equal(document.imageCount, 0);
	assert.ok(document.lines.includes("No transcript content is stored on this branch yet."));
	assert.ok(
		document.lines.includes(
			"Active branch: 0 entries | 0 image placeholders | 0 system messages | 0 state entries omitted",
		),
	);
	for (const line of document.lines) assert.ok(visibleWidth(line) <= 120);
});

test("guards non-TUI, non-TTY, TERM=dumb, and busy sessions", async () => {
	const cases = [
		["non-TUI", { mode: "rpc", hasUI: true }, {}, /interactive terminal/, 1],
		["no UI", { mode: "print", hasUI: false }, {}, undefined, 0],
		["non-TTY", {}, { isTTY: () => false }, /interactive terminal/, 1],
		["TERM=dumb", {}, { env: { TERM: "dumb" } }, /TERM=dumb/, 1],
		["streaming", { idle: false }, {}, /Wait for the current run/, 1],
		["shell busy", {}, { isShellBusy: () => true }, /Wait for the current run/, 1],
		["signal", { signal: new AbortController().signal }, {}, /Wait for the current run/, 1],
		["pending messages", { pending: true }, {}, /Wait for the current run/, 1],
	];
	for (const [name, harnessOptions, deps, pattern, notificationCount] of cases) {
		await test(name, async () => {
			const harness = await createHarness({ ...harnessOptions, deps });
			try {
				await harness.command.handler("", harness.ctx);
				assert.equal(harness.ui.calls(), 0, `${name} does not open a custom screen`);
				assert.equal(
					harness.state.notifications.length,
					notificationCount,
					`${name} reports ${notificationCount} reason(s)`,
				);
				if (pattern) assert.match(harness.state.notifications[0].text, pattern);
				assert.equal(harness.terminal.output.includes("\u001b[?1049l"), false, `${name} does not leave fullscreen`);
			} finally {
				harness.cleanup();
			}
		});
	}
});

test("refuses regular mode inside the custom factory before takeover", async () => {
	const harness = await createHarness({ tuiMode: "regular", branch: [message("user", { content: "hello" })] });
	try {
		assert.equal(harness.tui.mode, "regular");
		await harness.command.handler("", harness.ctx);
		assert.equal(harness.ui.calls(), 1, "the command reaches the custom factory");
		assert.equal(harness.ui.surfaces.length, 0, "no overlay component is mounted");
		assert.equal(harness.state.notifications.length, 1);
		assert.match(harness.state.notifications[0].text, /fullscreen mode/);
		assert.match(harness.state.notifications[0].text, /requires fullscreen mode/);
		assert.equal(harness.terminal.startCalls, 1, "the export never takes over terminal input");
		assert.equal(harness.terminal.output.includes("Jouzu transcript export"), false);
		assert.equal(harness.editor.getText(), DRAFT);
	} finally {
		harness.cleanup();
	}
});

test("re-checks busy state before takeover and reports the race", async () => {
	const harness = await createHarness({ branch: [message("user", { content: "hello" })] });
	try {
		const promise = harness.command.handler("", harness.ctx);
		harness.state.idle = false;
		await promise;
		await tick();
		assert.equal(harness.ui.calls(), 1, "the custom screen was mounted before the race check");
		assert.equal(harness.ui.surfaces.length, 1);
		assert.equal(
			harness.terminal.output.includes("\u001b[?1049l"),
			false,
			"the race check runs before leaving fullscreen",
		);
		assert.match(harness.state.notifications.at(-1).text, /Wait for the current run/);
		assert.equal(harness.tui.hasOverlay(), false, "the overlay is closed again");
	} finally {
		harness.cleanup();
	}
});

test("agent_start, user_bash, and session switch restart; shutdown does not", async () => {
	for (const [name, eventName, restarts] of [
		["agent_start", "agent_start", true],
		["user_bash", "user_bash", true],
		["session_before_switch", "session_before_switch", true],
		["session_shutdown", "session_shutdown", false],
	]) {
		await test(name, async () => {
			const harness = await createHarness({ branch: [message("user", { content: "hello" })] });
			try {
				const { promise } = await beginExport(harness);
				const handler = harness.pi.handlers.get(eventName);
				assert.equal(typeof handler, "function", `${eventName} is registered`);
				const startCalls = harness.terminal.startCalls;
				if (!restarts) {
					// Pi stops the TUI before session_shutdown; the export has already stopped it once.
					harness.tui.stop({ preserveScreen: true });
				}
				handler({}, harness.ctx);
				await promise;
				await tick();
				assert.equal(harness.tui.hasOverlay(), false, `${eventName} closes the overlay`);
				assert.equal(harness.state.notifications.length, 0, `${eventName} closes silently`);
				assert.equal(harness.editor.getText(), DRAFT);
				if (restarts) {
					assert.ok(
						harness.terminal.output.lastIndexOf("\u001b[?1049h") > harness.terminal.output.lastIndexOf("\u001b[?1049l"),
						`${eventName} restarts the TUI`,
					);
				} else {
					assert.equal(harness.terminal.startCalls, startCalls, `${eventName} does not restart raw input`);
					assert.equal(harness.terminal.onInput, undefined, `${eventName} leaves the terminal stopped`);
					assert.ok(
						harness.terminal.output.lastIndexOf("\u001b[?1049l") > harness.terminal.output.lastIndexOf("\u001b[?1049h"),
						`${eventName} leaves no alternate screen`,
					);
				}
			} finally {
				harness.cleanup();
			}
		});
	}
});

test("reload restores terminal ownership even with a queued return", async () => {
	for (const returning of [false, true]) {
		const harness = await createHarness({ branch: [message("user", { content: "hello" })] });
		try {
			const { promise } = await beginExport(harness);
			const starts = harness.terminal.startCalls;
			if (returning) harness.terminal.onInput("\r");
			harness.pi.handlers.get("session_shutdown")({ reason: "reload" }, harness.ctx);
			assert.equal(harness.terminal.startCalls, starts + 1);
			await promise;
			await tick();
			assert.equal(harness.terminal.startCalls, starts + 1, "no stale restart after reload");
			assert.equal(typeof harness.terminal.onInput, "function");
			assert.equal(harness.editor.getText(), DRAFT);
		} finally {
			harness.cleanup();
		}
	}
});

test("shutdown cancels a return restart that is still queued", async () => {
	const harness = await createHarness({ branch: [message("user", { content: "hello" })] });
	try {
		const { promise } = await beginExport(harness);
		const starts = harness.terminal.startCalls;
		harness.terminal.onInput("\r");
		harness.tui.stop({ preserveScreen: true });
		harness.pi.handlers.get("session_shutdown")({}, harness.ctx);
		await promise;
		await tick();
		assert.equal(harness.terminal.startCalls, starts);
		assert.equal(harness.terminal.onInput, undefined);
	} finally {
		harness.cleanup();
	}
});

test("reports a custom rejection before the export exists", async () => {
	const harness = await createHarness({ branch: [message("user", { content: "hello" })] });
	try {
		harness.ctx.ui.custom = async () => {
			throw new Error("custom failed \u001b]0;evil\u0007");
		};
		await harness.command.handler("", harness.ctx);
		assert.equal(harness.state.notifications.length, 1);
		assert.match(harness.state.notifications[0].text, /Transcript export failed/);
		assert.equal(harness.state.notifications[0].text.includes("\u001b"), false, "the notice is sanitized");
		assert.equal(harness.terminal.output.includes("\u001b[?1049l"), false);
		assert.equal(harness.editor.getText(), DRAFT);
	} finally {
		harness.cleanup();
	}
});

test("a failing transcript write restores the terminal and reports the failure", async () => {
	const terminal = new FailingWriteTerminal();
	terminal.failOn = "Jouzu transcript export";
	const harness = await createHarness({ terminal, branch: [message("user", { content: "hello" })] });
	try {
		const promise = harness.command.handler("", harness.ctx);
		await waitFor(() => harness.state.notifications.length > 0, "the failure notice");
		await promise;
		await tick();
		harness.tui.renderNow(true);
		assert.ok(harness.terminal.output.includes("\u001b[?1049l"), "the export left fullscreen before failing");
		assert.ok(
			harness.terminal.output.lastIndexOf("\u001b[?1049h") > harness.terminal.output.lastIndexOf("\u001b[?1049l"),
		);
		assert.equal(harness.tui.hasOverlay(), false);
		assert.equal(harness.tui.getFocusedComponent(), harness.editor);
		assert.equal(harness.state.notifications.length, 1);
		assert.match(harness.state.notifications[0].text, /Transcript export failed/);
		assert.equal(harness.state.notifications[0].text.includes("\u001b"), false, "the failure notice is sanitized");
	} finally {
		harness.cleanup();
	}
});

test("a failing terminal start restores the terminal", async () => {
	const terminal = new FailingStartTerminal();
	terminal.failStartAt = 2; // The first start is the TUI; the second is the export's input parser.
	const harness = await createHarness({ terminal, branch: [message("user", { content: "hello" })] });
	try {
		const promise = harness.command.handler("", harness.ctx);
		await waitFor(() => harness.state.notifications.length > 0, "the failure notice");
		await promise;
		await tick();
		harness.tui.renderNow(true);
		assert.ok(harness.terminal.output.includes("\u001b[?1049l"));
		assert.ok(
			harness.terminal.output.lastIndexOf("\u001b[?1049h") > harness.terminal.output.lastIndexOf("\u001b[?1049l"),
		);
		assert.equal(harness.tui.hasOverlay(), false);
		assert.match(harness.state.notifications.at(-1).text, /Transcript export failed/);
	} finally {
		harness.cleanup();
	}
});

test("a failing final TUI start leaves no alternate screen", async () => {
	const terminal = new FailingStartTerminal();
	terminal.failStartAt = 3; // The third start is the deferred return to the TUI.
	const harness = await createHarness({ terminal, branch: [message("user", { content: "hello" })] });
	try {
		const { promise } = await beginExport(harness);
		const altExitBefore = harness.terminal.output.lastIndexOf("\u001b[?1049l");
		harness.terminal.onInput("\r");
		await waitFor(() => harness.state.notifications.length > 0, "the final-start failure notice");
		await promise;
		await tick();
		const altEnter = harness.terminal.output.lastIndexOf("\u001b[?1049h");
		const altExit = harness.terminal.output.lastIndexOf("\u001b[?1049l");
		assert.ok(altEnter > altExitBefore, "the failed start entered the alternate screen");
		assert.ok(altExit > altEnter, "renderer cleanup leaves the alternate screen");
		assert.equal(harness.terminal.onInput, undefined, "terminal input is stopped");
		assert.equal(harness.tui.hasOverlay(), false);
		assert.match(harness.state.notifications.at(-1).text, /Transcript export failed/);
	} finally {
		harness.cleanup();
	}
});

test("a failing tui.stop restores the terminal", async () => {
	const terminal = new FailingWriteTerminal();
	terminal.failOn = "\u001b[?1049l";
	const harness = await createHarness({ terminal, branch: [message("user", { content: "hello" })] });
	try {
		const promise = harness.command.handler("", harness.ctx);
		await waitFor(() => harness.state.notifications.length > 0, "the failure notice");
		await promise;
		await tick();
		harness.tui.renderNow(true);
		assert.ok(
			harness.terminal.output.lastIndexOf("\u001b[?1049h") > harness.terminal.output.lastIndexOf("\u001b[?1049l"),
		);
		assert.equal(harness.tui.hasOverlay(), false);
		assert.match(harness.state.notifications.at(-1).text, /Transcript export failed/);
	} finally {
		harness.cleanup();
	}
});

test("dispose without a return key restores the terminal exactly once", async () => {
	const harness = await createHarness({ branch: [message("user", { content: "hello" })] });
	try {
		const { promise } = await beginExport(harness);
		const component = harness.ui.surfaces[0].component;
		component.dispose();
		await promise;
		await tick();
		assert.equal(harness.tui.hasOverlay(), false);
		assert.ok(
			harness.terminal.output.lastIndexOf("\u001b[?1049h") > harness.terminal.output.lastIndexOf("\u001b[?1049l"),
		);
		assert.equal(harness.terminal.startCalls, 3, "the TUI, the export, and the restored TUI each started once");
		assert.equal(harness.state.notifications.length, 0);
	} finally {
		harness.cleanup();
	}
});

test("returns after a resize while the export is active", async () => {
	const harness = await createHarness({ branch: [message("user", { content: "hello" })] });
	try {
		const { promise } = await beginExport(harness);
		const startCalls = harness.terminal.startCalls;
		harness.terminal.columns = 64;
		harness.terminal.onResize?.();
		await tick();
		assert.equal(harness.tui.hasOverlay(), true, "a resize does not close the export");

		await returnFromExport(harness, promise);
		assert.equal(harness.terminal.startCalls, startCalls + 1, "the TUI restarts once");
		assert.equal(harness.terminal.columns, 64);
		assert.equal(typeof harness.terminal.onResize, "function", "the restarted TUI owns resize handling");

		harness.terminal.columns = 48;
		harness.terminal.onResize();
		await tick();
		harness.tui.renderNow(true);
		for (const line of harness.tui.getScreenLines()) {
			assert.ok(visibleWidth(line) <= 48, `resized line is ${visibleWidth(line)} columns`);
		}
	} finally {
		harness.cleanup();
	}
});

test("repeated exports work and the extension registers no shortcut", async () => {
	const harness = await createHarness({ branch: [message("user", { content: "hello" })] });
	try {
		assert.equal(harness.extension.name, "jouzu-scrollback");
		assert.equal(typeof harness.command, "object");
		assert.match(harness.command.description, /transcript/);
		assert.equal(harness.pi.shortcuts.length, 0, "no new key default is registered");

		const first = (await beginExport(harness)).promise;
		await returnFromExport(harness, first);
		const second = (await beginExport(harness)).promise;
		await returnFromExport(harness, second);
		assert.equal(harness.terminal.output.split("Jouzu transcript export").length - 1, 2, "both exports printed");
		assert.equal(harness.terminal.output.split("\u001b[?1049h").length - 1, 3, "the TUI re-entered twice");
		assert.equal(harness.editor.getText(), DRAFT);
		assert.equal(harness.editor.setTextCalls, 0);
	} finally {
		harness.cleanup();
	}
});

test("rejects a second export while one is open", async () => {
	const harness = await createHarness({ branch: [message("user", { content: "hello" })] });
	try {
		const first = (await beginExport(harness)).promise;
		await harness.command.handler("", harness.ctx);
		assert.match(harness.state.notifications.at(-1).text, /already open/);
		assert.equal(harness.ui.calls(), 1, "the second command did not mount another overlay");
		await returnFromExport(harness, first);
	} finally {
		harness.cleanup();
	}
});

test("chunks large transcripts and yields between writes", async () => {
	const lines = Array.from({ length: 80 }, (_value, index) => `line ${index} ${"日本語".repeat(12)}`).join("\n");
	const branch = [message("user", { content: lines })];
	let yields = 0;
	const harness = await createHarness({
		branch,
		deps: {
			chunkSize: 64,
			yieldToEventLoop: async () => {
				yields += 1;
				await tick();
			},
		},
	});
	try {
		const { promise } = await beginExport(harness);
		await waitFor(
			() => transcriptText(harness.terminal).includes("Scroll and copy with your terminal or tmux."),
			"the transcript to finish writing",
		);
		const altExit = harness.terminal.output.lastIndexOf("\u001b[?1049l");
		const exitIndex = harness.terminal.writes.findIndex((write) => write.includes("\u001b[?1049l"));
		const transcriptWrites = harness.terminal.writes
			.slice(exitIndex)
			.filter((write) => write.length > 0 && !write.includes("\u001b"));
		assert.ok(altExit >= 0, "the export left the alternate screen");
		assert.ok(transcriptWrites.length > 1, "the transcript is written in more than one chunk");
		assert.ok(yields > 0, "the writer yields between chunks");
		for (const write of transcriptWrites) assert.ok(write.length <= 64, `chunk length ${write.length} exceeds 64`);
		assert.ok(transcriptText(harness.terminal).includes("line 79"), "the final content is present");
		await returnFromExport(harness, promise);
		assert.ok(harness.terminal.output.lastIndexOf("\u001b[?1049h") > altExit, "the TUI re-entered fullscreen");
	} finally {
		harness.cleanup();
	}
});

test("return during a chunked write aborts the remaining output and restores the TUI", async () => {
	const lines = Array.from({ length: 200 }, (_value, index) => `line ${index}`).join("\n");
	const branch = [message("user", { content: lines })];
	let interrupted = false;
	const harness = await createHarness({
		branch,
		deps: {
			chunkSize: 32,
			yieldToEventLoop: async () => {
				if (!interrupted) {
					interrupted = true;
					harness.terminal.onInput("\r");
				}
				await tick();
			},
		},
	});
	try {
		const { promise } = await beginExport(harness);
		await promise;
		await tick();
		harness.tui.renderNow(true);
		assert.equal(interrupted, true);
		assert.ok(harness.terminal.output.includes("\u001b[?1049l"));
		assert.ok(
			harness.terminal.output.lastIndexOf("\u001b[?1049h") > harness.terminal.output.lastIndexOf("\u001b[?1049l"),
		);
		assert.equal(harness.tui.hasOverlay(), false);
		assert.equal(harness.editor.getText(), DRAFT);
	} finally {
		harness.cleanup();
	}
});

test("the return-key predicate ignores pasted and released keys", () => {
	const keybindings = new KeybindingsManager(SELECT_KEYBINDINGS);
	assert.equal(isScrollbackReturnKey("\r", keybindings), true);
	assert.equal(isScrollbackReturnKey("\u001b", keybindings), true);
	assert.equal(isScrollbackReturnKey("\u0003", keybindings), true);
	assert.equal(isScrollbackReturnKey("", keybindings), false);
	assert.equal(isScrollbackReturnKey("a", keybindings), false);
	assert.equal(isScrollbackReturnKey("\u001b[200~\r\u001b[201~", keybindings), false);
	assert.equal(isScrollbackReturnKey("\u001b[200~\u001b\u001b[201~", keybindings), false);
	assert.equal(isScrollbackReturnKey("\u001b[13;1:3u", keybindings), false);
	assert.equal(isScrollbackReturnKey("\u001b[27;1:3u", keybindings), false);
});

test("the export source reads no files and no other branch APIs", () => {
	const source = readFileSync(new URL("../src/scrollback.ts", import.meta.url), "utf8");
	assert.equal(source.includes("node:fs"), false, "the extension does not import the filesystem");
	assert.equal(source.includes("readFile"), false, "the extension does not read files");
	assert.equal(source.includes("getEntries("), false, "the extension does not read every entry");
	assert.equal(source.includes("getTree("), false, "the extension does not read the session tree");
	assert.equal(source.includes("getSessionFile("), false, "the extension does not read the session file");
});
