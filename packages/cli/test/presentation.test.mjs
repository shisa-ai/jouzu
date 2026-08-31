import assert from "node:assert/strict";
import { test } from "node:test";
import {
	brandDefaultSystemPrompt,
	buildCapabilityRoutingGuidance,
	createJouzuPresentationExtension,
	detectBannerColorMode,
	isInteractivePiStartup,
	JOUZU_CORE_CAPABILITY_GUIDANCE,
	JOUZU_DEFAULT_GUIDANCE,
	JOUZU_USER_COMMUNICATION_GUIDANCE,
	renderBannerLines,
	renderBrandGradient,
	shouldClearInteractiveStartup,
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

function installExtension() {
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, command) => commands.set(name, command),
	};
	createJouzuPresentationExtension(metadata, profile, { colorMode: "none" }).factory(pi);
	return { handlers, commands };
}

test("brands only Pi's default prompt, adds bounded guidance, and preserves dynamic tool bullets", async () => {
	const upstream = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents
- bg_task: Spawn, inspect, and stop non-blocking shell tasks

Guidelines:
- Be concise in your responses`;
	const expected = upstream
		.replace(
			"operating inside pi, a coding agent harness",
			"operating inside Jouzu, a coding-agent environment built on the Pi harness",
		)
		.replace("\n\nAvailable tools:", `\n\n${JOUZU_DEFAULT_GUIDANCE}\n\nAvailable tools:`);
	assert.equal(brandDefaultSystemPrompt(upstream), expected);
	assert.equal(brandDefaultSystemPrompt(upstream, "user-owned prompt"), upstream);
	assert.equal(brandDefaultSystemPrompt("You are a reviewer."), "You are a reviewer.");
	assert.match(expected, /Available tools:\n- read: Read file contents\n- bg_task:/);
	assert.match(expected, /Do not invent acronyms or use unexplained jargon/);
	assert.match(expected, /Load the `jouzu-clear-writing` skill for documentation/);
	assert.doesNotMatch(JOUZU_DEFAULT_GUIDANCE, /be concise/i);
	assert.match(expected, /Load the `jouzu-core` skill for repository work/);
	assert.match(expected, /do not combine workflow mechanisms/);
	assert.equal(JOUZU_DEFAULT_GUIDANCE, `${JOUZU_USER_COMMUNICATION_GUIDANCE}\n${JOUZU_CORE_CAPABILITY_GUIDANCE}`);
	assert.ok(JOUZU_DEFAULT_GUIDANCE.length <= 600);

	const routingOptions = {
		customPrompt: undefined,
		selectedTools: ["read", "bg_task", "web_fetch"],
		skills: [{ name: "jouzu-core" }, { name: "jouzu-clear-writing" }],
	};
	const routing = buildCapabilityRoutingGuidance(routingOptions);
	const { handlers } = installExtension();
	const result = await handlers.get("before_agent_start")({
		systemPrompt: upstream,
		systemPromptOptions: routingOptions,
	});
	assert.deepEqual(result, { systemPrompt: brandDefaultSystemPrompt(upstream, undefined, routing) });
});

test("generates stable capability routing from only active tools and skills", () => {
	const options = {
		selectedTools: ["read", "grep", "web_fetch", "TaskCreate", "bg_task"],
		skills: [{ name: "jouzu-core" }, { name: "jouzu-clear-writing" }],
	};
	const guidance = buildCapabilityRoutingGuidance(options);
	assert.equal(buildCapabilityRoutingGuidance(options), guidance);
	assert.match(guidance, /generated from this session's active tools and skills/);
	assert.match(guidance, /`read`, `grep`/);
	assert.match(guidance, /`web_fetch`/);
	assert.match(guidance, /`TaskCreate`/);
	assert.match(guidance, /`bg_task`/);
	assert.match(guidance, /load `jouzu-clear-writing`/);
	assert.doesNotMatch(guidance, /vcc_recall/);
	assert.doesNotMatch(guidance, /tff-/);
	assert.doesNotMatch(guidance, /schedule_prompt/);
	assert.doesNotMatch(guidance, /jouzu-source-check/);

	const changed = buildCapabilityRoutingGuidance({
		...options,
		selectedTools: [...options.selectedTools, "schedule_prompt"],
	});
	assert.match(changed, /`schedule_prompt`/);
	assert.notEqual(changed, guidance);
});

test("describes VCC session continuity without claiming infinite context", () => {
	const guidance = buildCapabilityRoutingGuidance({
		selectedTools: ["vcc_recall"],
		skills: [],
	});

	assert.match(guidance, /Session continuity across compaction/);
	assert.match(guidance, /pi-vcc compacts automatically/);
	assert.match(guidance, /Compaction is not context exhaustion/);
	assert.match(guidance, /workflow token totals are not active context occupancy/);
	assert.match(guidance, /cannot compact/);
	assert.match(guidance, /current session/);
	assert.doesNotMatch(guidance, /infinite context/i);
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
