import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createJouzuPresentationExtension,
	detectBannerColorMode,
	renderBannerLines,
	shouldClearInteractiveStartup,
} from "../dist/presentation.js";

const metadata = {
	jouzuVersion: "0.1.0",
	piVersion: "0.84.2",
	profileSchemaVersion: 1,
	lock: { tag: "v0.84.2", commit: "commit", compatibilityStatus: "qualified", deviations: [] },
};
const profile = { id: "ja", source: "default" };
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
		"Japanese-first Pi environment",
		"jouzu 0.1.0  ·  pi 0.84.2",
		"/model choose  ·  /hotkeys shortcuts  ·  /jouzu status",
	]);
	assert.equal(component.render(12)[0], "J O U Z U");
	for (const line of component.render(12)) assert.ok(line.length <= 12, line);
});

test("selects truecolor, indexed, basic, and NO_COLOR banner modes deterministically", () => {
	assert.equal(detectBannerColorMode({ colorDepth: 24, env: { TERM: "xterm" } }), "truecolor");
	assert.equal(detectBannerColorMode({ colorDepth: 8, env: { TERM: "xterm-256color" } }), "256");
	assert.equal(detectBannerColorMode({ colorDepth: 4, env: { TERM: "xterm" } }), "16");
	assert.equal(detectBannerColorMode({ colorDepth: 24, env: { TERM: "xterm", NO_COLOR: "1" } }), "none");
	assert.equal(detectBannerColorMode({ colorDepth: 24, env: { TERM: "dumb" } }), "none");

	const truecolor = renderBannerLines(identityTheme, metadata, 80, "truecolor")[0];
	const indexed = renderBannerLines(identityTheme, metadata, 80, "256")[0];
	const basic = renderBannerLines(identityTheme, metadata, 80, "16")[0];
	const plain = renderBannerLines(identityTheme, metadata, 80, "none")[0];
	assert.ok(truecolor.includes("\u001b[38;2;34;211;238m"));
	assert.ok(indexed.includes("\u001b[38;5;45m"));
	assert.ok(basic.includes("\u001b[96m"));
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

test("registers a Jouzu status command without exposing paths", async () => {
	const { commands } = installExtension();
	const { calls, ctx } = interactiveContext();
	await commands.get("jouzu").handler("", ctx);
	assert.equal(calls.notifications.length, 1);
	assert.match(calls.notifications[0][0], /Jouzu 0\.1\.0 · Pi 0\.84\.2/);
	assert.match(calls.notifications[0][0], /profile ja \(not applied\)/);
	assert.match(calls.notifications[0][0], /anthropic\/claude-test/);
	assert.doesNotMatch(calls.notifications[0][0], /\/work\//);
});
