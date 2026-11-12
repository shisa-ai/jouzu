import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { assistant, createFlowSession } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { runPromptHook } from "../../../scripts/fixtures/prompt-hook.mjs";
import { resolveCatalog } from "../dist/locale-catalog.js";
import {
	applyJouzuPromptSections,
	buildCapabilityRoutingGuidance,
	catalogStartupNotice,
	clearStartupNotice,
	createJouzuPresentationExtension,
	detectBannerColorMode,
	isInteractivePiStartup,
	JOUZU_ASYNC_WAIT_GUIDANCE,
	JOUZU_DEFAULT_GUIDANCE,
	JOUZU_HARNESS_GUIDANCE,
	JOUZU_REPOSITORY_WORK_GUIDANCE,
	JOUZU_TOOL_GUIDELINES,
	JOUZU_USER_COMMUNICATION_GUIDANCE,
	jouzuDateSection,
	jouzuPreamble,
	renderBannerLines,
	renderBrandGradient,
	shouldClearInteractiveStartup,
	writeStartupNotice,
} from "../dist/presentation.js";

const metadata = {
	jouzuVersion: "0.1.0",
	displayVersion: "0.1.0",
	build: undefined,
	piVersion: "0.84.2",
	profileSchemaVersion: 1,
	lock: { tag: "v0.84.2", tagCommit: "commit", commit: "commit", compatibilityStatus: "qualified", deviations: [] },
};
const profile = { id: "core", source: "default" };
const identityTheme = {
	bold: (text) => text,
	fg: (_color, text) => text,
};

function interactiveContext() {
	const calls = { title: [], indicator: [], header: [], notifications: [] };
	const ctx = {
		mode: "tui",
		cwd: "/work/日本語 project",
		model: { provider: "anthropic", id: "claude-test" },
		thinkingLevel: "high",
		scopedModels: [{}, {}],
		sessionManager: { getSessionId: () => "session-test-123" },
		getContextUsage: () => ({ tokens: 12_345, contextWindow: 200_000, percent: 6.2 }),
		ui: {
			theme: identityTheme,
			setTitle: (value) => calls.title.push(value),
			setWorkingIndicator: (value) => calls.indicator.push(value),
			setHeader: (value) => calls.header.push(value),
			notify: (...args) => calls.notifications.push(args),
		},
	};
	return { calls, ctx };
}

function installExtension(catalog) {
	const handlers = new Map();
	const commands = new Map();
	const tools = new Map();
	const sent = [];
	const pi = {
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, command) => commands.set(name, command),
		registerTool: (tool) => tools.set(tool.name, tool),
		sendMessage: async (message, options) => {
			sent.push({ message, options });
		},
	};
	createJouzuPresentationExtension(metadata, profile, {
		colorMode: "none",
		...(catalog ? { catalog } : {}),
	}).factory(pi);
	return { handlers, commands, tools, sent };
}

test("applies Jouzu guidance as Pi prompt sections and leaves other prompts alone", () => {
	const routing = buildCapabilityRoutingGuidance({ selectedTools: ["read", "bg_task", "web_fetch"], skills: [] });
	const options = { cwd: "/workspace", selectedTools: ["read", "bash", "edit"], sections: {}, toolGuidelines: {} };
	assert.equal(applyJouzuPromptSections(options, { capabilityRouting: routing, now: new Date(2026, 9, 24) }), true);
	assert.equal(options.sections.preamble, jouzuPreamble(routing));
	assert.match(options.sections.preamble, /^You are an expert coding assistant operating inside Jouzu/);
	assert.ok(options.sections.preamble.indexOf(JOUZU_DEFAULT_GUIDANCE) < options.sections.preamble.indexOf(routing));
	assert.match(options.sections.docs, /^For Pi extension, SDK, or TUI development, start with .*\/index.md\.$/);
	assert.equal(options.sections.date, "Today's date: Saturday, 2026-10-24");
	assert.deepEqual(options.toolGuidelines.edit, JOUZU_TOOL_GUIDELINES.edit);
	assert.deepEqual(options.toolGuidelines.bash, JOUZU_TOOL_GUIDELINES.bash);
	assert.equal(options.toolGuidelines.write, undefined);
	applyJouzuPromptSections(options, { capabilityRouting: routing, now: new Date(2026, 9, 24) });
	assert.deepEqual(options.toolGuidelines.edit, JOUZU_TOOL_GUIDELINES.edit);
	assert.deepEqual(options.toolGuidelines.bash, JOUZU_TOOL_GUIDELINES.bash);

	for (const owned of [{ customPrompt: "user-owned prompt" }, { forceSystemPrompt: "forced by another extension" }]) {
		const untouched = { cwd: "/workspace", selectedTools: ["edit"], sections: {}, toolGuidelines: {}, ...owned };
		assert.equal(applyJouzuPromptSections(untouched, { capabilityRouting: routing }), false);
		assert.deepEqual(untouched.sections, {});
		assert.deepEqual(untouched.toolGuidelines, {});
	}
});

test("default guidance states harness facts once and stays bounded", () => {
	assert.equal(
		JOUZU_DEFAULT_GUIDANCE,
		`${JOUZU_USER_COMMUNICATION_GUIDANCE}\n${JOUZU_HARNESS_GUIDANCE}\n${JOUZU_REPOSITORY_WORK_GUIDANCE}`,
	);
	assert.ok(JOUZU_DEFAULT_GUIDANCE.length <= 2000);
	for (const phrase of [
		"Do not invent acronyms or use unexplained jargon",
		"Responses render as Markdown",
		"Make independent tool calls in parallel",
		"steering the current task unless it cancels or replaces it",
		"Work directly by default",
		"Inspect relevant files before editing. Scope file searches to relevant project paths and widen only when needed; do not run filesystem-wide scans such as `find /` unless the user explicitly requests them.",
		"Distinguish evidence from assumptions",
		"make the smallest coherent change",
		"run the narrowest deterministic check",
		"Report untested limitations honestly",
		"Compute reported numbers with executed code",
	])
		assert.ok(JOUZU_DEFAULT_GUIDANCE.includes(phrase), phrase);
	assert.doesNotMatch(JOUZU_DEFAULT_GUIDANCE, /be concise|jouzu-core|jouzu-clear-writing|completion notifications/i);
	assert.match(JOUZU_ASYNC_WAIT_GUIDANCE, /Prefer completion notifications over sleeping or polling/);
	assert.match(JOUZU_ASYNC_WAIT_GUIDANCE, /Without completion notifications, poll on a bounded schedule/);
});

test("the extension sets sections on every run instead of forcing the prompt", () => {
	const options = { selectedTools: ["read", "bg_task", "web_fetch"], skills: [{ name: "jouzu-clear-writing" }] };
	const { handlers } = installExtension();
	const run = runPromptHook(handlers.get("before_agent_start"), { options });
	assert.equal(run.result, undefined);
	assert.equal(run.sections.preamble, jouzuPreamble(buildCapabilityRoutingGuidance(options)));
	assert.equal(run.sections.date, jouzuDateSection());
});

test("the installed Pi renders the Jouzu sections and sends a date change as a section update", async () => {
	const { buildSystemPrompt, buildSystemPromptSections, diffSystemPromptSections } = await import(
		pathToFileURL(join(getPackageDir(), "dist/core/system-prompt.js")).href
	);
	const sectionsFor = (now) => {
		const options = { selectedTools: ["read", "bash"], cwd: "/workspace", sections: {}, toolGuidelines: {} };
		applyJouzuPromptSections(options, { now });
		return options;
	};
	const first = sectionsFor(new Date(2026, 9, 24));
	const rendered = buildSystemPrompt(first);
	assert.match(rendered, /^You are an expert coding assistant operating inside Jouzu/);
	assert.doesNotMatch(rendered, /operating inside pi, a coding agent harness/);
	assert.equal(rendered.match(/<docs>/g)?.length, 1);
	assert.doesNotMatch(rendered, /docs\/keybindings\.md|docs\/models\.md|environment-variables/);
	assert.match(rendered, /<date>\nToday's date: Saturday, 2026-10-24\n<\/date>/);
	assert.match(rendered, /<cwd>\n\/workspace\n<\/cwd>/);
	const patch = diffSystemPromptSections(
		buildSystemPromptSections(first),
		buildSystemPromptSections(sectionsFor(new Date(2026, 9, 25))),
	);
	assert.deepEqual(Object.keys(patch), ["date"]);
});

test("a Pi session keeps its leading prompt and receives a changed section as an update", async (t) => {
	let now = new Date(2026, 9, 24);
	const { session } = await createFlowSession(t, {
		tools: ["read"],
		extensions: [
			(pi) => pi.on("before_agent_start", (event) => void applyJouzuPromptSections(event.systemPromptOptions, { now })),
		],
	});
	const requests = [];
	session.agent.streamFunction = async (_model, context) => {
		requests.push(context.messages.filter((message) => message.role === "system"));
		const reply = assistant();
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "done", partial: reply };
			},
			result: async () => reply,
		};
	};
	await session.prompt("first");
	now = new Date(2026, 9, 25);
	await session.prompt("second");
	const [first, second] = requests;
	assert.equal(first.length, 1);
	assert.match(first[0].sections.preamble, /^You are an expert coding assistant operating inside Jouzu/);
	assert.match(first[0].sections.date, /2026-10-24/);
	// The leading system message is unchanged; the new date arrives as a later section update.
	assert.deepEqual(second[0], first[0]);
	assert.equal(second.length, 2);
	assert.deepEqual(Object.keys(second[1].sections), ["date"]);
	assert.match(second[1].sections.date, /2026-10-25/);
});

test("generates stable capability routing from only active tools and skills", () => {
	const options = {
		selectedTools: ["read", "grep", "web_fetch", "TaskCreate", "bg_task"],
		skills: [{ name: "jouzu-clear-writing" }],
	};
	const guidance = buildCapabilityRoutingGuidance(options);
	assert.equal(buildCapabilityRoutingGuidance(options), guidance);
	assert.doesNotMatch(guidance, /\| Need \|/);
	assert.doesNotMatch(guidance, /`read`|`grep`/);
	assert.match(guidance, /`web_fetch`/);
	assert.match(guidance, /`TaskCreate`/);
	assert.match(guidance, /`bg_task`/);
	assert.match(guidance, /Load a skill only when the task needs it/);
	assert.doesNotMatch(guidance, /vcc_recall/);
	assert.doesNotMatch(guidance, /tff-/);
	assert.doesNotMatch(guidance, /schedule_prompt/);
	assert.doesNotMatch(guidance, /jouzu-source-check/);
	assert.doesNotMatch(guidance, /jouzu-anti-slop/);

	const changed = buildCapabilityRoutingGuidance({
		...options,
		selectedTools: [...options.selectedTools, "schedule_prompt"],
	});
	assert.match(changed, /`schedule_prompt`/);
	assert.notEqual(changed, guidance);
});

test("skill loading guidance is shared and never replaces a custom prompt", async () => {
	const upstream = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents`;
	const options = { customPrompt: undefined, selectedTools: ["read"], skills: [{ name: "jouzu-reference" }] };
	const routing = buildCapabilityRoutingGuidance(options);
	assert.match(routing, /Load a skill only when the task needs it/);
	assert.doesNotMatch(
		buildCapabilityRoutingGuidance({ ...options, skills: [{ name: "jouzu-clear-writing" }] }),
		/jouzu-reference/,
	);
	const { handlers } = installExtension();
	const branded = runPromptHook(handlers.get("before_agent_start"), { systemPrompt: upstream, options });
	assert.equal(branded.sections.preamble, jouzuPreamble(routing));
	assert.doesNotMatch(branded.systemPrompt, /Jouzu configuration, language, model catalogs/);

	// A user-owned prompt gets no Jouzu sections, so the route never reaches it.
	const custom = runPromptHook(handlers.get("before_agent_start"), {
		systemPrompt: upstream,
		options: { ...options, customPrompt: "user-owned prompt" },
	});
	assert.equal(custom.result, undefined);
	assert.deepEqual(custom.sections, {});
});

test("describes VCC session continuity without claiming infinite context", () => {
	const guidance = buildCapabilityRoutingGuidance({
		selectedTools: ["vcc_recall"],
		skills: [],
	});

	assert.match(guidance, /Session continuity across compaction/);
	assert.match(guidance, /compaction runs automatically/);
	assert.match(guidance, /Compaction is not context exhaustion/);
	assert.match(guidance, /workflow token totals are not active context occupancy/);
	assert.match(guidance, /cannot compact/);
	assert.match(guidance, /current session/);
	assert.doesNotMatch(guidance, /infinite context/i);
});

test("routes compaction requests to the tool when it is available", () => {
	const guidance = buildCapabilityRoutingGuidance({
		selectedTools: ["vcc_recall", "compact_context"],
		skills: [],
	});

	assert.match(guidance, /`compact_context` requests one/);
	assert.match(guidance, /runs after the current turn ends/);
	assert.doesNotMatch(guidance, /cannot compact/);
});

test("clears only real interactive TTY launches", () => {
	const tty = { stdinIsTTY: true, stdoutIsTTY: true, env: { TERM: "xterm-256color" } };
	assert.equal(shouldClearInteractiveStartup([], tty), true);
	assert.equal(shouldClearInteractiveStartup(["hello from Jouzu"], tty), true);
	assert.equal(shouldClearInteractiveStartup(["--mode", "interactive"], tty), true);

	for (const args of [
		["--version"],
		["--help"],
		["--list-models"],
		["--mode", "rpc"],
		["--mode=json"],
		["-p", "hello"],
		["install", "npm:example"],
		["update", "--extensions"],
	]) {
		assert.equal(shouldClearInteractiveStartup(args, tty), false, args.join(" "));
	}
	assert.equal(shouldClearInteractiveStartup([], { ...tty, stdinIsTTY: false }), false);
	assert.equal(shouldClearInteractiveStartup([], { ...tty, stdoutIsTTY: false }), false);
	assert.equal(shouldClearInteractiveStartup([], { ...tty, env: { TERM: "dumb" } }), false);
	assert.equal(shouldClearInteractiveStartup([], { ...tty, env: { TERM: "xterm", JOUZU_NO_CLEAR: "1" } }), false);
	assert.equal(isInteractivePiStartup([], { ...tty, env: { TERM: "xterm", JOUZU_NO_CLEAR: "1" } }), true);
});

test("startup notices are written, then erased in place", () => {
	const written = [];
	const original = process.stdout.write;
	process.stdout.write = (chunk) => {
		written.push(typeof chunk === "string" ? chunk : "");
		return true;
	};
	try {
		writeStartupNotice(catalogStartupNotice());
		clearStartupNotice();
	} finally {
		process.stdout.write = original;
	}
	assert.deepEqual(written, ["Fetching model catalog…", "\r\u001b[2K"]);
});

test("the startup notice and the erase do not change width", () => {
	// The write carries only the notice text and the erase only the clear
	// sequence, so the displayed width and the erase sequence are the same as
	// the pre-catalog build regardless of the catalog that renders the text.
	const en = catalogStartupNotice(resolveCatalog("en").bundle);
	const ja = catalogStartupNotice(resolveCatalog("ja").bundle);
	assert.equal(en, "Fetching model catalog…");
	assert.equal(ja, "モデルカタログを取得しています…");
	for (const notice of [en, ja]) assert.ok(!notice.includes("\u001b"));
	const written = [];
	const original = process.stdout.write;
	process.stdout.write = (chunk) => {
		written.push(typeof chunk === "string" ? chunk : "");
		return true;
	};
	try {
		writeStartupNotice(ja);
		clearStartupNotice();
	} finally {
		process.stdout.write = original;
	}
	assert.deepEqual(written, [ja, "\r\u001b[2K"]);
});

test("a damaged locale catalog falls back to the English startup notice", () => {
	// `resolveCatalog` never throws for a damaged catalog; it returns the English
	// bundle, so the model-catalog fetch failure path still shows the notice.
	const resolution = resolveCatalog("not a locale");
	assert.equal(resolution.bundle.locale, "en");
	assert.equal(catalogStartupNotice(resolution.bundle), "Fetching model catalog…");
});

test("installs a compact width-safe Jouzu header and working indicator", async () => {
	const { handlers } = installExtension();
	const { calls, ctx } = interactiveContext();
	await handlers.get("session_start")({}, ctx);

	assert.deepEqual(calls.title, ["Jouzu - 日本語 project"]);
	assert.equal(calls.indicator.length, 1);
	assert.equal(calls.indicator[0].frames.length, 4);
	assert.equal(calls.header.length, 1);
	const component = calls.header[0](undefined, identityTheme);
	const wide = component.render(80);
	assert.deepEqual(wide, [
		"⠈⢹ ⡎⢱ ⡇⢸ ⢉⠝ ⡇⢸",
		"⠣⠜ ⠣⠜ ⠣⠜ ⠮⠤ ⠣⠜",
		"jouzu 0.1.0  ·  pi 0.84.2",
		"/model choose  ·  /hotkeys shortcuts  ·  /status session",
	]);
	assert.equal(component.render(12)[0], "J O U Z U");
	for (const line of component.render(12)) assert.ok(line.length <= 12, line);
});

test("renders the banner labels from the catalog without changing the decoration", () => {
	// The braille mark and the version line are decoration and protected values;
	// only the hint labels are catalog text, and the separator stays in code.
	const ja = resolveCatalog("ja").bundle;
	const lines = renderBannerLines(identityTheme, metadata, 80, "none", undefined, ja);
	assert.deepEqual(lines, [
		"⠈⢹ ⡎⢱ ⡇⢸ ⢉⠝ ⡇⢸",
		"⠣⠜ ⠣⠜ ⠣⠜ ⠮⠤ ⠣⠜",
		"jouzu 0.1.0  ·  pi 0.84.2",
		"/model 選択  ·  /hotkeys キーバインド  ·  /status セッション",
	]);
});

test("shares the teal-purple-pink banner gradient with compact wordmarks", () => {
	assert.equal(renderBrandGradient("JOUZU", "none"), "JOUZU");
	assert.equal(
		renderBrandGradient("JOUZU", "truecolor"),
		"\u001b[38;2;34;211;238mJ\u001b[0m" +
			"\u001b[38;2;87;187;224mO\u001b[0m" +
			"\u001b[38;2;139;163;210mU\u001b[0m" +
			"\u001b[38;2;192;138;196mZ\u001b[0m" +
			"\u001b[38;2;244;114;182mU\u001b[0m",
	);
	assert.equal(
		renderBrandGradient("JOUZU", "256"),
		"\u001b[38;5;45mJ\u001b[0m" +
			"\u001b[38;5;81mO\u001b[0m" +
			"\u001b[38;5;141mU\u001b[0m" +
			"\u001b[38;5;177mZ\u001b[0m" +
			"\u001b[38;5;213mU\u001b[0m",
	);
});

test("darkens the banner gradient and versions for a light theme", () => {
	const lightTheme = { ...identityTheme, appearance: "light" };
	const truecolorLines = renderBannerLines(lightTheme, metadata, 80, "truecolor");
	assert.ok(truecolorLines[0].includes("\u001b[38;2;14;116;144m"));
	assert.ok(!truecolorLines[0].includes("\u001b[38;2;34;211;238m"));
	assert.ok(truecolorLines[2].includes("\u001b[38;2;14;116;144m0.1.0"));
	assert.ok(truecolorLines[2].includes("\u001b[38;2;157;23;77m0.84.2"));
	assert.ok(renderBannerLines(lightTheme, metadata, 80, "256")[0].includes("\u001b[38;5;30m"));
	assert.ok(renderBannerLines(lightTheme, metadata, 80, "16")[2].includes("\u001b[36m0.1.0"));
	assert.ok(renderBannerLines(identityTheme, metadata, 80, "truecolor")[0].includes("\u001b[38;2;34;211;238m"));
});

test("selects truecolor, indexed, basic, and NO_COLOR banner modes deterministically", () => {
	assert.equal(detectBannerColorMode({ colorDepth: 24, env: { TERM: "xterm" } }), "truecolor");
	assert.equal(detectBannerColorMode({ colorDepth: 8, env: { TERM: "xterm-256color" } }), "256");
	assert.equal(detectBannerColorMode({ colorDepth: 4, env: { TERM: "xterm" } }), "16");
	assert.equal(detectBannerColorMode({ colorDepth: 24, env: { TERM: "xterm", NO_COLOR: "1" } }), "none");
	assert.equal(detectBannerColorMode({ colorDepth: 24, env: { TERM: "dumb" } }), "none");

	const truecolorLines = renderBannerLines(identityTheme, metadata, 80, "truecolor");
	const indexedLines = renderBannerLines(identityTheme, metadata, 80, "256");
	const basicLines = renderBannerLines(identityTheme, metadata, 80, "16");
	const plain = renderBannerLines(identityTheme, metadata, 80, "none")[0];
	assert.ok(truecolorLines[0].includes("\u001b[38;2;34;211;238m"));
	assert.ok(truecolorLines[2].includes("\u001b[38;2;103;232;249m0.1.0"));
	assert.ok(truecolorLines[2].includes("\u001b[38;2;249;168;212m0.84.2"));
	assert.ok(indexedLines[0].includes("\u001b[38;5;45m"));
	assert.ok(indexedLines[2].includes("\u001b[38;5;117m0.1.0"));
	assert.ok(basicLines[0].includes("\u001b[96m"));
	assert.ok(basicLines[2].includes("\u001b[96m0.1.0"));
	assert.equal(plain, "⠈⢹ ⡎⢱ ⡇⢸ ⢉⠝ ⡇⢸");
	assert.equal(renderBannerLines(identityTheme, metadata, 15, "truecolor")[0], "J O U Z U");
});

test("re-asserts the Jouzu window title when Pi renames the session", async () => {
	const { handlers } = installExtension();
	const { calls, ctx } = interactiveContext();

	await handlers.get("session_info_changed")({ type: "session_info_changed", name: "fix login bug" }, ctx);
	assert.deepEqual(calls.title, ["Jouzu - fix login bug - 日本語 project"]);

	calls.title.length = 0;
	await handlers.get("session_info_changed")({ type: "session_info_changed", name: undefined }, ctx);
	assert.deepEqual(calls.title, ["Jouzu - 日本語 project"]);
});

test("does not install TUI presentation in RPC mode", async () => {
	const { handlers } = installExtension();
	const { calls, ctx } = interactiveContext();
	ctx.mode = "rpc";
	await handlers.get("session_start")({}, ctx);
	assert.deepEqual(calls.header, []);
	assert.deepEqual(calls.title, []);
});

test("registers a provider-neutral session status command without exposing paths", async () => {
	const { commands } = installExtension();
	const { calls, ctx } = interactiveContext();
	assert.equal(commands.has("jouzu"), false);
	await commands.get("status").handler("", ctx);
	assert.equal(calls.notifications.length, 1);
	const message = calls.notifications[0][0];
	assert.match(message, /session: session-test-123/);
	assert.match(message, /workspace: 日本語 project/);
	assert.match(message, /model: anthropic\/claude-test/);
	assert.match(message, /thinking: high/);
	assert.match(message, /context: 12345\/200000 tokens \(6\.2%\)/);
	assert.match(message, /scoped models: 2/);
	assert.match(message, /profile: core \(not applied\)/);
	assert.match(message, /runtime: Jouzu 0\.1\.0 · Pi 0\.84\.2/);
	assert.doesNotMatch(message, /\/work\//);
});

test("session status labels unavailable model and context facts honestly", async () => {
	const { commands } = installExtension();
	const { calls, ctx } = interactiveContext();
	ctx.model = undefined;
	ctx.thinkingLevel = undefined;
	ctx.scopedModels = [];
	ctx.getContextUsage = () => ({ tokens: null, contextWindow: 128_000, percent: null });
	await commands.get("status").handler("", ctx);
	const message = calls.notifications[0][0];
	assert.match(message, /model: not selected/);
	assert.match(message, /thinking: off/);
	assert.match(message, /context: unknown\/128000 tokens \(unknown%\)/);
	assert.match(message, /scoped models: all available/);
});

test("the session status block and its command description render from the ja catalog", async () => {
	const ja = resolveCatalog("ja").bundle;
	const { commands } = installExtension(ja);
	const { calls, ctx } = interactiveContext();
	await commands.get("status").handler("", ctx);
	const message = calls.notifications[0][0];
	const status = (key, args) => ja.format(`jouzu.cli.presentation.status.${key}`, args);
	assert.equal(
		message,
		[
			status("heading"),
			status("session", { id: "session-test-123" }),
			status("workspace", { name: "日本語 project" }),
			status("model", { model: "anthropic/claude-test" }),
			status("thinking", { level: "high" }),
			status("context", { context: status("contextUsage", { tokens: "12345", window: "200000", percent: "6.2" }) }),
			status("scopedModels", { models: "2" }),
			status("profile", { id: "core", state: status("profileNotApplied") }),
			status("runtime", { jouzu: "0.1.0", pi: "0.84.2" }),
		].join("\n"),
	);
	for (const label of [
		"Jouzu session status",
		"session:",
		"workspace:",
		"model:",
		"thinking:",
		"context:",
		"scoped models:",
		"profile:",
		"runtime:",
	])
		assert.equal(message.includes(label), false, `English label survives: ${label}`);
	assert.equal(commands.get("status").description, ja.format("jouzu.cli.presentation.command.statusDescription"));
});

test("the status command description keeps its English default", () => {
	const { commands } = installExtension();
	assert.equal(
		commands.get("status").description,
		"Show the current Jouzu session, model, context, and profile status",
	);
});
