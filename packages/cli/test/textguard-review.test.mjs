import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	contentPages,
	createTextGuardReviewExtension,
	summaryChoices,
	summaryPages,
} from "../dist/textguard-review.js";
import { TextGuardRuntime } from "../dist/textguard-runtime.js";

const piRoot = new URL("./", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { ExtensionSelectorComponent } = await import(
	fileURLToPath(new URL("modes/interactive/components/extension-selector.js", piRoot))
);
const { initTheme } = await import(fileURLToPath(new URL("modes/interactive/theme/theme.js", piRoot)));
initTheme("dark");
const VIEW = "View flagged content";
const KEEP = "Keep withheld";
const ALLOW = "Allow this content for this session";
/** Wrapped pages break long tokens; match prose against newline-joined text. */
const flat = (text) => text.replace(/\n/g, " ");
/** Fingerprints wrap mid-token; match them against whitespace-stripped text. */
const dense = (text) => text.replace(/\s/g, "");

const evidence = {
	status: "findings",
	findings: [{ kind: "bidi_control", severity: "error", offset: 0, codepoint: "U+202E" }],
	findingCount: 1,
	severityCounts: { info: 0, warn: 0, error: 1 },
	decodeReasons: [],
};
const request = {
	toolName: "web_fetch",
	toolCallId: "1",
	input: { url: "https://example.com/日\u202e\u001b[31m" },
	result: { content: [{ type: "text", text: "private source body" }], details: {} },
};
async function setup(t, scan = evidence) {
	const runtime = new TextGuardRuntime({
		scanner: {
			async initialize() {
				return "a".repeat(64);
			},
			async scan() {
				return scan;
			},
			async close() {},
		},
	});
	t.after(() => runtime.close());
	const policy = await runtime.createPolicy({ sessionId: "one", cwd: process.cwd() });
	await policy.filterToolResult(request);
	const commands = new Map(),
		events = new Map(),
		messages = [],
		dialogs = [];
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
			select: async (title, choices) => {
				dialogs.push({ title, choices });
				// A user must act on every dialog; cancel instead of looping forever.
				return dialogs.length <= 3 ? choices[0] : undefined;
			},
		},
		reload: async () => {
			reloads++;
		},
	};
	/** Select by exact label or unique prefix; cancel (undefined) when the script runs out. */
	const pick = (labels, limit = 2) => {
		let calls = 0;
		ctx.ui.select = async (title, choices) => {
			dialogs.push({ title, choices });
			if (++calls > limit) return undefined;
			for (const label of labels) {
				const found = choices.find((choice) => choice === label || choice.startsWith(label));
				if (found !== undefined) return found;
			}
			return choices[0];
		};
	};
	return {
		runtime,
		policy,
		ctx,
		dimensions,
		dialogs,
		messages,
		events,
		pick,
		run: (args) => commands.get("textguard").handler(args ?? "", ctx),
		reloads: () => reloads,
	};
}

test("review opens with the flagged content first and approval stays an explicit choice", async (t) => {
	const f = await setup(t);
	await f.run();
	assert.equal(f.reloads(), 0);
	assert.equal(f.policy.reviews().length, 1);
	assert.equal(f.dialogs[1].choices[0], VIEW);
	assert.deepEqual(f.dialogs[1].choices.slice(0, 3), [VIEW, KEEP, ALLOW]);
	assert.equal(f.dialogs[1].choices.at(-1), "Back");
	const title = f.dialogs[1].title;
	// The source identity is readable: CJK stays visible, controls and bidi stay escaped.
	assert.match(title, /https:\/\/example\.com\/日/);
	for (const unsafe of ["\u001b", "\u202e", "private source body"]) assert.equal(title.includes(unsafe), false);
	// The exact fingerprint and a human finding location are on the pages.
	assert.match(dense(title), /Contentfingerprint\(SHA-256\):[a-f0-9]{64}/);
	const review = f.policy.reviews()[0];
	assert.match(summaryPages(review, f.policy.contentSnapshot(review)).join("\n"), /at line 1, column 1/);
	// Taking the defaults opens the viewer, never approves.
	assert.equal(f.policy.reviews().length, 1);
});

test("viewing flagged content shows the exact escaped body bound to the reviewed fingerprint", async (t) => {
	const withSecret = {
		...request,
		input: { url: "https://example.com/a" },
		result: { content: [{ type: "text", text: "秘密計画\n\u001b[31mred\u202e" }], details: {} },
	};
	const f = await setup(t);
	await f.policy.filterToolResult(withSecret);
	f.pick(["2.", VIEW, "Back"], 3);
	await f.run();
	const review = f.policy.reviews().find((item) => item.source.includes("example.com/a"));
	assert.ok(review);
	const snapshot = f.policy.contentSnapshot(review);
	assert.ok(snapshot.body.includes("秘密計画"));
	const viewer = f.dialogs.find((dialog) => dialog.title.startsWith("Flagged content, part 1"));
	assert.ok(viewer);
	assert.match(dense(viewer.title), new RegExp(`Contentfingerprint\\(SHA-256\\):${review.contentDigest}`));
	// CJK stays readable; control and bidi characters stay escaped even inside the body.
	assert.match(dense(viewer.title), /秘密計画/);
	for (const unsafe of ["\u001b", "\u202e"]) assert.equal(viewer.title.includes(unsafe), false);
	// Access is bound to the exact review identity; a forged identity sees nothing.
	assert.equal(f.policy.contentSnapshot({ ...review, id: "forged" }), undefined);
});

test("each review shows its own fingerprint and body, and a forged identity cannot view content", async (t) => {
	const f = await setup(t);
	await f.policy.filterToolResult({
		...request,
		toolCallId: "2",
		input: { url: "https://example.com/b" },
		result: { content: [{ type: "text", text: "second body" }], details: {} },
	});
	const [first, second] = f.policy.reviews();
	const firstSnapshot = f.policy.contentSnapshot(first);
	const secondSnapshot = f.policy.contentSnapshot(second);
	assert.notEqual(firstSnapshot.body, secondSnapshot.body);
	assert.ok(firstSnapshot.body.includes("private source body"));
	assert.ok(secondSnapshot.body.includes("second body"));
	assert.equal(f.policy.contentSnapshot({ ...first, id: `${first.id.slice(0, 63)}0` }), undefined);
	const firstPages = summaryPages(first, firstSnapshot);
	const secondPages = summaryPages(second, secondSnapshot);
	assert.notEqual(firstPages[0], secondPages[0]);
	// Reviews stay metadata-only; bodies never enter reports, logs, or JSON of records.
	assert.equal(JSON.stringify(f.policy.reviews()).includes("private source body"), false);
});

test("default confirmation keeps content withheld; explicit choice approves and reloads", async (t) => {
	const f = await setup(t);
	f.pick([VIEW], 2);
	await f.run();
	assert.equal(f.reloads(), 0);
	assert.equal(f.policy.reviews().length, 1);
	f.pick([ALLOW]);
	await f.run();
	assert.equal(f.reloads(), 1);
	assert.equal((await f.policy.filterToolResult(request)).isError, false);
});

test("cancellation at either dialog never approves", async (t) => {
	for (const cancelAt of [1, 2]) {
		const f = await setup(t);
		let calls = 0;
		f.ctx.ui.select = async (_title, choices) => (++calls >= cancelAt ? undefined : choices[0]);
		await f.run();
		assert.equal(f.policy.reviews().length, 1);
		assert.equal(f.reloads(), 0);
	}
});

test("arguments and noninteractive or degraded terminals cannot approve", async (t) => {
	for (const mode of ["print", "rpc", "dumb", "narrow", "short", "args", "no-ui"]) {
		const f = await setup(t);
		if (["print", "rpc"].includes(mode)) f.ctx.mode = mode;
		if (mode === "dumb") f.dimensions.dumb = true;
		if (mode === "narrow") f.dimensions.columns = 47;
		if (mode === "short") f.dimensions.rows = 23;
		if (mode === "no-ui") f.ctx.hasUI = false;
		await f.run(mode === "args" ? "approve all" : "");
		assert.equal(f.dialogs.length, 0);
		assert.equal(f.policy.reviews().length, 1);
		assert.equal(f.reloads(), 0);
		assert.ok(f.messages.length);
	}
});

test("confirmation from a replaced session is rejected", async (t) => {
	const f = await setup(t);
	let calls = 0;
	f.ctx.ui.select = async (_title, choices) => {
		if (++calls === 2) {
			await f.runtime.createPolicy({ sessionId: "two", cwd: process.cwd() });
			return choices[choices.indexOf(ALLOW)];
		}
		return calls === 1 ? choices[0] : undefined;
	};
	await f.run();
	assert.equal(f.reloads(), 0);
	assert.match(f.messages.at(-1), /expired/);
});

test("terminal shrink during confirmation leaves content withheld", async (t) => {
	const f = await setup(t);
	let calls = 0;
	f.ctx.ui.select = async (_title, choices) => {
		if (++calls === 2) {
			f.dimensions.rows = 10;
			return choices[choices.indexOf(ALLOW)];
		}
		return calls === 1 ? choices[0] : undefined;
	};
	await f.run();
	assert.equal(f.policy.reviews().length, 1);
	assert.equal(f.reloads(), 0);
	assert.match(f.messages.at(-1), /resize/);
});

test("incomplete scans explain the reason and still allow explicit approval", async (t) => {
	const f = await setup(t, { status: "unavailable", findings: [], reason: "scanner" });
	await f.run();
	assert.match(flat(f.dialogs[1].title), /The check did not finish: the scanner could not run\./);
	assert.equal(f.dialogs[1].choices.includes(ALLOW), true);
	assert.equal(f.policy.reviews().length, 1);
});

test("oversized content shows an honest limitation and keeps approval explicit", async (t) => {
	const oversized = {
		...request,
		input: { url: "https://example.com/big" },
		result: { content: [{ type: "text", text: "x".repeat(300 * 1024) }], details: {} },
	};
	const f = await setup(t);
	const report = await f.policy.filterToolResult(oversized);
	assert.equal(report.isError, true);
	const review = f.policy.reviews().find((item) => item.evidence.reason === "input-limit");
	assert.ok(review);
	const snapshot = f.policy.contentSnapshot(review);
	assert.equal(snapshot.body, undefined);
	const pages = summaryPages(review, snapshot);
	assert.match(flat(pages.join("\n")), /The check did not finish: the content is larger than TextGuard can scan/);
	assert.match(flat(pages.join("\n")), /not retained for viewing/);
	const choices = summaryChoices(snapshot, true, pages.length);
	assert.equal(choices.includes(VIEW), false);
	assert.equal(choices.includes(ALLOW), true);
});

test("informational reports have no approval action", async (t) => {
	const f = await setup(t, {
		...evidence,
		findings: [{ ...evidence.findings[0], severity: "info" }],
		severityCounts: { info: 1, warn: 0, error: 0 },
	});
	await f.run();
	const report = f.dialogs[1];
	assert.match(report.title, /No errors/);
	assert.equal(report.choices.includes(VIEW), false);
	assert.equal(report.choices.includes(KEEP), false);
	assert.equal(report.choices.includes(ALLOW), false);
	assert.equal(report.choices.at(-1), "Back");
	assert.equal(f.reloads(), 0);
});

test("warning counts state what blocks and what does not", async (t) => {
	const f = await setup(t, {
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
	});
	const review = f.policy.reviews()[0];
	const text = flat(summaryPages(review, f.policy.contentSnapshot(review)).join("\n"));
	assert.match(text, /2 errors that block this content until you approve it; 2 warnings do not block it\./);
	assert.match(text, /bundled detection rule \(command_injection\) match\./);
	assert.match(text, /bundled detection rule matched a pattern/);
});

test("diagnostics contain counts rather than source bodies and deduplicate repeated events", async (t) => {
	const f = await setup(t);
	f.ctx.mode = "rpc";
	f.events.get("session_start")({}, f.ctx);
	f.events.get("agent_end")({}, f.ctx);
	assert.equal(f.messages.length, 1);
	assert.match(f.messages[0], /waiting for your review/);
	assert.doesNotMatch(f.messages[0], /private source body|example\.com/);
});

test("review pagination bounds the inherited selector height", async (t) => {
	const f = await setup(t);
	for (let i = 0; i < 20; i++)
		await f.policy.filterToolResult({ ...request, input: { url: `https://example.com/${i}` } });
	let calls = 0;
	f.ctx.ui.select = async (title, choices) => {
		f.dialogs.push({ title, choices });
		return ++calls === 1 ? "Next page" : undefined;
	};
	await f.run();
	assert.equal(f.dialogs.length, 2);
	for (const dialog of f.dialogs) {
		const component = new ExtensionSelectorComponent(
			dialog.title,
			dialog.choices,
			() => {},
			() => {},
		);
		assert.ok(component.render(48).length <= 24);
		component.dispose();
	}
});

test("summary and content pages render at 48x24 with mixed-width text and safe escaping", async (t) => {
	const hostile = {
		...request,
		input: { url: `https://example.com/${"日\u202e\u001b[31m".repeat(30)}/very/long/path` },
		result: { content: [{ type: "text", text: `秘密\n\u001b[31m${"x".repeat(400)}` }], details: {} },
	};
	const f = await setup(t);
	await f.policy.filterToolResult(hostile);
	for (const review of f.policy.reviews()) {
		const snapshot = f.policy.contentSnapshot(review);
		const pages = summaryPages(review, snapshot);
		const choices = summaryChoices(snapshot, true, pages.length);
		for (const [index, page] of pages.entries()) {
			const component = new ExtensionSelectorComponent(
				page,
				choices,
				() => {},
				() => {},
			);
			t.after(() => component.dispose());
			const lines = component.render(48);
			assert.ok(lines.length <= 24, `page ${index} height ${lines.length}`);
			assert.ok(
				lines.every((line) => visibleWidth(line) <= 48),
				`page ${index} width`,
			);
			component.dispose();
		}
		for (const unsafe of ["\u001b", "\u202e"]) assert.equal(pages.join("\n").includes(unsafe), false);
		assert.match(pages.join("\n"), /日/);
		// The complete source label is shown across pages; nothing is cut short.
		const label = snapshot ? snapshot.source : review.source;
		const tail = label.slice(-12);
		assert.ok(
			pages.some((page) => page.includes(tail)),
			"source label tail is reachable",
		);
		// The content viewer obeys the same bounds.
		const body = snapshot.body;
		assert.ok(typeof body === "string" && body.length > 0);
		for (const page of contentPages(review.contentDigest, body)) {
			const component = new ExtensionSelectorComponent(
				page,
				["Next part", "Back"],
				() => {},
				() => {},
			);
			t.after(() => component.dispose());
			const lines = component.render(48);
			assert.ok(lines.length <= 24, `viewer height ${lines.length}`);
			assert.ok(
				lines.every((line) => visibleWidth(line) <= 48),
				"viewer width",
			);
			component.dispose();
		}
	}
});

test("inherited keys default to denial in the summary dialog", async (t) => {
	const f = await setup(t);
	const review = f.policy.reviews()[0];
	const snapshot = f.policy.contentSnapshot(review);
	const pages = summaryPages(review, snapshot);
	const choices = summaryChoices(snapshot, true, pages.length);
	let choice;
	const component = new ExtensionSelectorComponent(
		pages[0],
		choices,
		(value) => {
			choice = value;
		},
		() => {
			choice = "cancel";
		},
	);
	t.after(() => component.dispose());
	component.handleInput("\r");
	assert.equal(choice, VIEW);
	const move = (label) => {
		const target = choices.indexOf(label);
		for (let step = component.selectedIndex; step < target; step++) component.handleInput("\x1b[B");
		for (let step = target; step < component.selectedIndex; step++) component.handleInput("\x1b[A");
		component.handleInput("\r");
	};
	move(KEEP);
	assert.equal(choice, KEEP);
	move(ALLOW);
	assert.equal(choice, ALLOW);
	component.handleInput("\x1b");
	assert.equal(choice, "cancel");
});

test("reload failure does not print exception details", async (t) => {
	const f = await setup(t);
	f.ctx.ui.select = async (_title, choices) => choices[choices.indexOf(ALLOW)] ?? choices[0];
	f.ctx.reload = async () => {
		throw new Error("secret exception");
	};
	await f.run();
	assert.match(f.messages.at(-1), /Run \/reload/);
	assert.doesNotMatch(f.messages.join("\n"), /secret exception/);
});
