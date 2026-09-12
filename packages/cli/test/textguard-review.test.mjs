import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createTextGuardReviewExtension, reviewLines } from "../dist/textguard-review.js";
import { TextGuardRuntime } from "../dist/textguard-runtime.js";

const identityTheme = { fg: (_role, value) => value, bg: (_role, value) => value, bold: (value) => value };
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const PGDN = "\x1b[6~";
/** Wrapped lines break long tokens; match prose against newline-joined text. */
const flat = (text) => text.replace(/\n/g, " ");
/** Fingerprints wrap mid-token; match them against whitespace-stripped text. */
const dense = (text) => text.replace(/\s/g, "");
/** Renderer escapes (resets, cursor styles) are ours; strip them before content assertions. */
const clean = (lines) => stripTerminalSequences(lines.join("\n"));
/** Wrapped lines leave boundary spaces; collapse all whitespace for prose assertions. */
const norm = (text) => text.replace(/\s+/g, " ");

const evidence = {
	status: "findings",
	findings: [{ kind: "bidi_control", severity: "error", offset: 0, codepoint: "U+202E" }],
	findingCount: 1,
	severityCounts: { info: 0, warn: 0, error: 1 },
	decodeReasons: [],
};
const infoEvidence = {
	status: "findings",
	findings: [{ kind: "ansi_escape", severity: "warn", offset: 3, codepoint: "" }],
	findingCount: 1,
	severityCounts: { info: 0, warn: 1, error: 0 },
	decodeReasons: [],
};
const request = {
	toolName: "web_fetch",
	toolCallId: "1",
	input: { url: "https://example.com/日‮\u001b[31m" },
	result: { content: [{ type: "text", text: "private source body" }], details: {} },
};

async function setup(t, scan = evidence, options = {}) {
	const dir = await mkdtemp(join(tmpdir(), "textguard-review-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const runtime = new TextGuardRuntime({
		mode: "strict",
		scanner: {
			async initialize() {
				return "a".repeat(64);
			},
			async scan() {
				return scan;
			},
			async close() {},
		},
		...(options.persist ? { approvalPath: join(dir, "approvals.json") } : {}),
	});
	t.after(() => runtime.close());
	const policy = await runtime.createPolicy({ sessionId: "one", cwd: process.cwd() });
	if (scan !== null) await policy.filterToolResult(request);
	const commands = new Map(),
		events = new Map(),
		messages = [],
		overlays = [];
	let reloads = 0;
	const dimensions = { columns: 48, rows: 24, dumb: false };
	createTextGuardReviewExtension(runtime, {
		terminal: () => dimensions,
		writeDiagnostic: (text) => messages.push(text),
	})({
		on: (name, handler) => events.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
	});
	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: { getSessionId: () => "one" },
		ui: {
			notify: (text) => messages.push(text),
			custom: async (factory, overlayOptions) => {
				let resolveDone;
				const donePromise = new Promise((resolve) => (resolveDone = resolve));
				const component = factory(
					{ terminal: { rows: dimensions.rows, columns: dimensions.columns } },
					identityTheme,
					new KeybindingsManager(TUI_KEYBINDINGS),
					(result) => resolveDone(result),
				);
				overlays.push({ component, options: overlayOptions });
				return donePromise;
			},
		},
		reload: async () => {
			reloads++;
		},
	};
	return {
		runtime,
		policy,
		ctx,
		dimensions,
		overlays,
		messages,
		events,
		dir,
		reloads: () => reloads,
		/** Start /textguard and return the overlay component, or undefined when no overlay opened. */
		open: async (args = "") => {
			const pending = commands.get("textguard").handler(args, ctx);
			const overlay = overlays.at(-1);
			if (!overlay) {
				await pending;
				return { pending, component: undefined };
			}
			return { pending, component: overlay.component };
		},
	};
}

/** In detail state, move the cursor to the named action and confirm. */
function choose(component, label) {
	const visible = () => clean(component.render(48)).includes(`> ${label}`);
	for (let step = 0; step < 6 && !visible(); step++) component.handleInput(UP);
	for (let step = 0; step < 6 && !visible(); step++) component.handleInput(DOWN);
	if (!visible()) assert.fail(`action not reachable: ${label}`);
	component.handleInput(ENTER);
}

test("the list shows source labels and status without leaking content", async (t) => {
	const f = await setup(t);
	const { pending, component } = await f.open();
	const compact = clean(component.render(48));
	assert.match(compact, /Withheld/);
	assert.match(compact, /1 withheld · 0 delivered/);
	// Wide terminals show more of the label; CJK stays readable.
	const wide = clean(component.render(80));
	assert.match(wide, /https:\/\/example\.com\/日/);
	for (const unsafe of ["\u202e", "private source body"]) assert.equal(wide.includes(unsafe), false);
	component.handleInput(ESC);
	await pending;
	assert.equal(f.policy.reviews().length, 1);
	assert.equal(f.reloads(), 0);
});

test("detail shows the fingerprint, findings, and escaped body; escape returns to the list", async (t) => {
	const f = await setup(t);
	const { pending, component } = await f.open();
	component.handleInput(ENTER);
	const detail = clean(component.render(48));
	assert.match(dense(detail), /Contentfingerprint\(SHA-256\):[a-f0-9]{64}/);
	assert.match(norm(detail), /Error \(blocks this content\): bidi control character U\+202E at line 1, column 1\./);
	component.handleInput(PGDN);
	component.handleInput(PGDN);
	const scrolled = clean(component.render(48));
	assert.match(dense(scrolled), /privatesourcebody/);
	assert.match(scrolled, /> Back/);
	// Escape returns to the list instead of discarding the review session.
	component.handleInput(ESC);
	assert.match(clean(component.render(48)), /1 withheld · 0 delivered/);
	component.handleInput(ESC);
	await pending;
	assert.equal(f.policy.reviews().length, 1);
	assert.equal(f.reloads(), 0);
});

test("viewing and deciding are one flow: approve for the session after scrolling", async (t) => {
	const f = await setup(t);
	const { pending, component } = await f.open();
	component.handleInput(ENTER);
	component.handleInput(PGDN);
	choose(component, "Allow for this session");
	await pending;
	assert.equal(f.reloads(), 1);
	assert.match(f.messages.at(-1), /approved for this session/);
	assert.equal((await f.policy.filterToolResult(request)).isError, false);
});

test("always-allow persists across sessions for the exact bytes", async (t) => {
	const f = await setup(t, evidence, { persist: true });
	const { pending, component } = await f.open();
	component.handleInput(ENTER);
	choose(component, "Always allow this exact content");
	await pending;
	assert.equal(f.reloads(), 1);
	assert.match(f.messages.at(-1), /Future sessions admit these exact bytes/);
	await f.runtime.close();

	const second = new TextGuardRuntime({
		mode: "strict",
		scanner: {
			async initialize() {
				return "a".repeat(64);
			},
			async scan() {
				return evidence;
			},
			async close() {},
		},
		approvalPath: join(f.dir, "approvals.json"),
	});
	t.after(() => second.close());
	const policy = await second.createPolicy({ sessionId: "two", cwd: process.cwd() });
	const result = await policy.filterToolResult(request);
	assert.equal(result.isError, false);
	assert.equal(policy.reviews().length, 0);
});

test("cancellation at the list never approves", async (t) => {
	const f = await setup(t);
	const { pending, component } = await f.open();
	component.handleInput(ESC);
	await pending;
	assert.equal(f.policy.reviews().length, 1);
	assert.equal(f.reloads(), 0);
});

test("an accidental confirm lands on Back and withholds", async (t) => {
	const f = await setup(t);
	const { pending, component } = await f.open();
	component.handleInput(ENTER);
	component.handleInput(ENTER);
	// Back was the default action: still in the overlay, still withheld.
	assert.match(clean(component.render(48)), /1 withheld · 0 delivered/);
	component.handleInput(ESC);
	await pending;
	assert.equal(f.policy.reviews().length, 1);
	assert.equal(f.reloads(), 0);
});

test("reports offer dismiss instead of approval and dismissal sticks", async (t) => {
	const f = await setup(t, infoEvidence);
	// Findings that blocked nothing stay out of the default list and keep their own view.
	assert.equal((await f.open()).component, undefined);
	assert.match(f.messages.at(-1), /nothing waiting for a decision/);
	assert.match(f.messages.at(-1), /1 finding blocked nothing/);
	const { pending, component } = await f.open("reports");
	assert.match(clean(component.render(48)), /0 withheld · 1 delivered/);
	component.handleInput(ENTER);
	const detail = clean(component.render(48));
	assert.match(detail, /No errors/);
	assert.equal(detail.includes("Allow"), false);
	choose(component, "Dismiss report");
	await pending;
	assert.equal(f.policy.scanReports().length, 0);
});

test("withheld items cannot be dismissed and keep their approval actions", async (t) => {
	const f = await setup(t);
	const { pending, component } = await f.open();
	component.handleInput(ENTER);
	const detail = clean(component.render(48));
	assert.match(detail, /Allow for this session/);
	assert.match(detail, /Always allow this exact content/);
	assert.equal(detail.includes("Dismiss"), false);
	component.handleInput(ESC);
	component.handleInput(ESC);
	await pending;
	assert.equal(f.policy.reviews().length, 1);
});

test("notifications fire only for content-blocking items", async (t) => {
	const clear = await setup(t, infoEvidence);
	clear.events.get("session_start")({}, clear.ctx);
	clear.events.get("agent_end")({}, clear.ctx);
	assert.equal(clear.messages.length, 0);

	const blocked = await setup(t);
	blocked.events.get("session_start")({}, blocked.ctx);
	// The alert names what was withheld and why, so the waiting-items summary would only repeat it.
	assert.equal(blocked.messages.length, 1);
	assert.match(blocked.messages[0], /TextGuard withheld .*1 error-level finding \(bidi_control\)/);
	assert.match(blocked.messages[0], /Run \/textguard to review and approve it\./);
	assert.doesNotMatch(blocked.messages[0], /scan report|without an exact content identity/);
	// Repeated events deduplicate.
	blocked.events.get("agent_end")({}, blocked.ctx);
	assert.equal(blocked.messages.length, 1);
	assert.doesNotMatch(blocked.messages[0], /private source body/);
});

test("identity-limited checks never notify but remain visible in the list footer", async (t) => {
	const f = await setup(t);
	// An unidentifiable payload produces a notice, not a review.
	await f.policy.filterToolResult({
		toolName: "web_fetch",
		toolCallId: "surrogate",
		input: { url: "https://example.com/s" },
		result: { content: [{ type: "text", text: "broken \ud800 payload" }], details: {} },
	});
	assert.equal(f.policy.scanNotices().length, 1);
	f.events.get("session_start")({}, f.ctx);
	// The withheld result alerts; an unidentifiable payload has nothing to approve and stays quiet.
	assert.equal(f.messages.length, 1);
	assert.match(f.messages[0], /TextGuard withheld/);
	const { pending, component } = await f.open();
	assert.match(norm(clean(component.render(48))), /could not identify the complete content/);
	component.handleInput(ESC);
	await pending;
});

test("scanning can be turned off and back on from the review command", async (t) => {
	const f = await setup(t);
	const { component: none } = await f.open("off");
	assert.equal(none, undefined);
	assert.equal(f.runtime.currentMode(), "off");
	assert.match(f.messages.at(-1), /TextGuard is off for this session/);
	assert.equal(f.reloads(), 1);
	// Turning scanning off discards the decisions taken under the previous mode.
	assert.equal(f.policy.reviews().length, 0);
	assert.deepEqual(await f.policy.filterToolResult(request), request.result);

	// With nothing left to review, the view is the switch that turns scanning back on.
	const { pending, component } = await f.open();
	const view = clean(component.render(48));
	assert.match(view, /scanning off for this session/);
	assert.match(view, /> Turn scanning back on/);
	component.handleInput(ENTER);
	await pending;
	assert.equal(f.runtime.currentMode(), "guarded");
	assert.match(f.messages.at(-1), /Flagged web results reach the model labelled as untrusted data/);
	assert.equal(f.reloads(), 2);
});

test("an unknown argument explains the modes without opening the review", async (t) => {
	const f = await setup(t);
	assert.equal((await f.open("sometimes")).component, undefined);
	assert.match(f.messages.at(-1), /\/textguard on, strict, or off/);
	assert.equal(f.runtime.currentMode(), "strict");
	assert.equal(f.reloads(), 0);
	// Selecting the mode a session already uses changes nothing.
	await f.open("strict");
	assert.match(f.messages.at(-1), /already set to strict/);
	assert.equal(f.reloads(), 0);
});

test("arguments and noninteractive or degraded terminals cannot approve", async (t) => {
	for (const mode of ["print", "rpc", "dumb", "narrow", "short", "args", "no-ui"]) {
		const f = await setup(t);
		if (["print", "rpc"].includes(mode)) f.ctx.mode = mode;
		if (mode === "dumb") f.dimensions.dumb = true;
		if (mode === "narrow") f.dimensions.columns = 47;
		if (mode === "short") f.dimensions.rows = 23;
		if (mode === "no-ui") f.ctx.hasUI = false;
		const { pending, component } = await f.open(mode === "args" ? "approve all" : "");
		assert.equal(component, undefined, mode);
		await pending;
		assert.equal(f.policy.reviews().length, 1, mode);
		assert.equal(f.reloads(), 0, mode);
		assert.ok(f.messages.length, mode);
	}
});

test("confirmation from a replaced session is rejected", async (t) => {
	const f = await setup(t);
	const original = f.ctx.ui.custom;
	f.ctx.ui.custom = async (factory, opts) => {
		const resultPromise = original(factory, opts);
		return resultPromise.then(async (outcome) => {
			await f.runtime.createPolicy({ sessionId: "two", cwd: process.cwd() });
			return outcome;
		});
	};
	const { pending, component } = await f.open();
	component.handleInput(ENTER);
	choose(component, "Allow for this session");
	await pending;
	assert.equal(f.reloads(), 0);
	assert.match(f.messages.at(-1), /expired/);
});

test("terminal shrink after review leaves content withheld", async (t) => {
	const f = await setup(t);
	const original = f.ctx.ui.custom;
	f.ctx.ui.custom = async (factory, opts) => {
		const resultPromise = original(factory, opts);
		return resultPromise.then((outcome) => {
			f.dimensions.rows = 10;
			return outcome;
		});
	};
	const { pending, component } = await f.open();
	component.handleInput(ENTER);
	choose(component, "Allow for this session");
	await pending;
	assert.equal(f.policy.reviews().length, 1);
	assert.equal(f.reloads(), 0);
	assert.match(f.messages.at(-1), /resize/);
});

test("list and detail render inside 48x24 with hostile mixed-width content", async (t) => {
	const hostile = {
		...request,
		input: { url: `https://example.com/${"日‮\u001b[31m".repeat(30)}/very/long/path` },
		result: { content: [{ type: "text", text: `秘密\n\u001b[31m${"x".repeat(400)}` }], details: {} },
	};
	const f = await setup(t);
	const blockedHostile = await f.policy.filterToolResult(hostile);
	assert.equal(blockedHostile.isError, true);
	const { pending, component } = await f.open();
	const check = (lines) => {
		assert.ok(lines.length <= 24, `height ${lines.length}`);
		assert.ok(
			lines.every((line) => visibleWidth(line) <= 48),
			"width",
		);
	};
	check(component.render(48));
	// The second item carries the hostile body.
	component.handleInput(DOWN);
	component.handleInput(ENTER);
	for (let page = 0; page < 3; page++) {
		check(component.render(48));
		component.handleInput(PGDN);
	}
	const detail = clean(component.render(48));
	assert.match(dense(detail), /秘密/);
	assert.match(dense(detail), /\\u001b/);
	for (const unsafe of ["\u001b", "\u202e"]) assert.equal(detail.includes(unsafe), false);
	// The complete source label is reachable through scrolling.
	let scrolled = "";
	component.handleInput(ESC);
	component.handleInput(DOWN);
	component.handleInput(ENTER);
	for (let page = 0; page < 40; page++) {
		scrolled += clean(component.render(48));
		component.handleInput(PGDN);
	}
	const label = f.policy.admission.snapshotFor(f.policy.reviews()[1].id).source;
	assert.ok(dense(scrolled).includes(label.slice(-12)), "source label tail is reachable");
	component.handleInput(ESC);
	component.handleInput(ESC);
	await pending;
});

test("review lines state honest limits for content that was not retained", async (t) => {
	const oversized = {
		...request,
		toolCallId: "big",
		input: { url: "https://example.com/big" },
		result: { content: [{ type: "text", text: "x".repeat(300 * 1024) }], details: {} },
	};
	const f = await setup(t);
	const result = await f.policy.filterToolResult(oversized);
	assert.equal(result.isError, true);
	const review = f.policy.reviews().find((item) => item.evidence.reason === "input-limit");
	assert.ok(review);
	assert.equal(f.policy.admission.snapshotFor(review.id).body, undefined);
	const text = flat(reviewLines(review, f.policy.admission.snapshotFor(review.id)).join("\n"));
	assert.match(text, /The check did not finish: the content is larger than TextGuard can scan/);
	assert.match(text, /not retained for viewing/);
	// Access is bound to the exact review identity; a forged identity sees nothing.
	assert.equal(f.policy.admission.snapshotFor("forged"), undefined);
});

test("incomplete scans explain the reason and offer approval", async (t) => {
	const f = await setup(t, { status: "unavailable", findings: [], reason: "scanner" });
	const { pending, component } = await f.open();
	component.handleInput(ENTER);
	const detail = clean(component.render(48));
	assert.match(norm(detail), /The check did not finish: the scanner could not run\./);
	assert.match(detail, /Allow for this session/);
	component.handleInput(ESC);
	component.handleInput(ESC);
	await pending;
	assert.equal(f.policy.reviews().length, 1);
});

test("warning counts state what blocks and what does not", async (t) => {
	const mixed = {
		status: "findings",
		findings: [
			{ kind: "bidi_control", severity: "error", offset: 0, codepoint: "U+202E" },
			{ kind: "ansi_escape", severity: "warn", offset: 12, codepoint: "" },
			{ kind: "invisible_char", severity: "warn", offset: 21, codepoint: "U+200B" },
			{ kind: "yara:command_injection", severity: "error", offset: null, codepoint: "" },
		],
		findingCount: 4,
		severityCounts: { info: 0, warn: 2, error: 2 },
		decodeReasons: [],
	};
	const f = await setup(t, mixed);
	const review = f.policy.reviews()[0];
	const text = flat(reviewLines(review, f.policy.admission.snapshotFor(review.id)).join("\n"));
	assert.match(text, /2 errors that block this content until you approve it; 2 warnings do not block it\./);
	assert.match(text, /bundled detection rule \(command_injection\) match\./);
	assert.match(text, /bundled detection rule matched a pattern/);
});

test("reload failure does not print exception details", async (t) => {
	const f = await setup(t);
	f.ctx.reload = async () => {
		throw new Error("secret exception");
	};
	const { pending, component } = await f.open();
	component.handleInput(ENTER);
	choose(component, "Allow for this session");
	await pending;
	assert.match(f.messages.at(-1), /Run \/reload/);
	assert.doesNotMatch(f.messages.join("\n"), /secret exception/);
});

test("the component renders a bounded list for many items", async (t) => {
	const f = await setup(t);
	for (let i = 0; i < 20; i++)
		await f.policy.filterToolResult({ ...request, toolCallId: `t${i}`, input: { url: `https://example.com/${i}` } });
	const { pending, component } = await f.open();
	const lines = component.render(48);
	assert.ok(lines.length <= 24);
	assert.match(clean(lines), /21 withheld · 0 delivered/);
	component.handleInput(PGDN);
	component.handleInput(PGDN);
	component.handleInput(PGDN);
	assert.match(clean(component.render(48)), /\(\d+\/21\)/);
	component.handleInput(ESC);
	await pending;
});
