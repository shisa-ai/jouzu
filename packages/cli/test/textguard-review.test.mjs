import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTextGuardReviewExtension, reviewSummary } from "../dist/textguard-review.js";
import { TextGuardRuntime } from "../dist/textguard-runtime.js";

const piRoot = new URL("./", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { ExtensionSelectorComponent } = await import(
	fileURLToPath(new URL("modes/interactive/components/extension-selector.js", piRoot))
);
const { initTheme } = await import(fileURLToPath(new URL("modes/interactive/theme/theme.js", piRoot)));
initTheme("dark");
const evidence = {
	status: "findings",
	findings: [{ kind: "bidi", severity: "error", offset: 0, codepoint: "U+202E" }],
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
				return choices[0];
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
		dialogs,
		messages,
		events,
		run: (args) => commands.get("textguard").handler(args ?? "", ctx),
		reloads: () => reloads,
	};
}
test("default confirmation keeps content withheld; explicit choice approves and reloads", async (t) => {
	const f = await setup(t);
	await f.run();
	assert.equal(f.reloads(), 0);
	assert.equal(f.policy.reviews().length, 1);
	assert.equal(f.dialogs[1].choices[0], "Keep withheld");
	f.ctx.ui.select = async (_title, choices) =>
		choices.includes("Allow this content for this session") ? choices[1] : choices[0];
	await f.run();
	assert.equal(f.reloads(), 1);
	assert.equal((await f.policy.filterToolResult(request)).isError, false);
});
test("cancellation at either dialog never approves", async (t) => {
	for (const cancelAt of [1, 2]) {
		const f = await setup(t);
		let calls = 0;
		f.ctx.ui.select = async (_title, choices) => (++calls === cancelAt ? undefined : choices[0]);
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
			return choices[1];
		}
		return choices[0];
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
			return choices[1];
		}
		return choices[0];
	};
	await f.run();
	assert.equal(f.policy.reviews().length, 1);
	assert.equal(f.reloads(), 0);
});
test("incomplete scans require the same explicit confirmation", async (t) => {
	const f = await setup(t, { status: "unavailable", findings: [], reason: "timeout" });
	await f.run();
	assert.match(f.dialogs[1].title, /Check incomplete/);
	assert.equal(f.policy.reviews().length, 1);
});
test("informational reports have no approval action", async (t) => {
	const f = await setup(t, {
		...evidence,
		findings: [{ ...evidence.findings[0], severity: "info" }],
		severityCounts: { info: 1, warn: 0, error: 0 },
	});
	await f.run();
	assert.deepEqual(f.dialogs[1].choices, ["Back"]);
	assert.equal(f.reloads(), 0);
});
test("diagnostics contain counts rather than source bodies and deduplicate repeated events", async (t) => {
	const f = await setup(t);
	f.ctx.mode = "rpc";
	f.events.get("session_start")({}, f.ctx);
	f.events.get("agent_end")({}, f.ctx);
	assert.equal(f.messages.length, 1);
	assert.match(f.messages[0], /interactive session/);
	assert.doesNotMatch(f.messages[0], /private source body|example.com/);
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
test("escaped evidence renders at 48 columns and inherited keys default to denial", async (t) => {
	const f = await setup(t);
	const review = f.policy.reviews()[0];
	review.source = "日\u202e\u001b[31m".repeat(50);
	review.evidence.findings = Array.from({ length: 2 }, () => ({
		kind: "x".repeat(79),
		severity: "error",
		offset: 262144,
	}));
	const title = reviewSummary(review);
	for (const unsafe of ["\u001b", "\u202e", "日", "private source body"]) assert.equal(title.includes(unsafe), false);
	let choice;
	const component = new ExtensionSelectorComponent(
		title,
		["Keep withheld", "Allow this content for this session"],
		(value) => {
			choice = value;
		},
		() => {
			choice = "cancel";
		},
	);
	t.after(() => component.dispose());
	const lines = component.render(48);
	assert.ok(lines.every((line) => visibleWidth(line) <= 48));
	assert.ok(lines.length <= 24, `height ${lines.length}`);
	component.handleInput("\r");
	assert.equal(choice, "Keep withheld");
	component.handleInput("\x1b[B");
	component.handleInput("\r");
	assert.equal(choice, "Allow this content for this session");
	component.handleInput("\x1b");
	assert.equal(choice, "cancel");
});
test("reload failure does not print exception details", async (t) => {
	const f = await setup(t);
	f.ctx.ui.select = async (_title, choices) =>
		choices.includes("Allow this content for this session") ? choices[1] : choices[0];
	f.ctx.reload = async () => {
		throw new Error("secret exception");
	};
	await f.run();
	assert.match(f.messages.at(-1), /Run \/reload/);
	assert.doesNotMatch(f.messages.join("\n"), /secret exception/);
});
