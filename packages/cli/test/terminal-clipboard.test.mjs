import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyTerminalClipboard } from "../../../scripts/apply-pi-terminal-clipboard.mjs";
import {
	copyToTmuxClipboard,
	emitTmuxOsc52Fallback,
	isTmuxClipboardEnabled,
	MAX_OSC52_ENCODED_LENGTH,
	runTmuxCommand,
	selectTmuxClient,
	TMUX_MAX_BUFFER_BYTES,
	tmuxOsc52Sequence,
	tmuxSessionTarget,
} from "../../../upstream/pi-terminal-clipboard/clipboard-tmux.js";
import { additionSource, additions, paths, transform } from "../../../upstream/pi-terminal-clipboard/patch.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestPath = join(repoRoot, "upstream/pi-terminal-clipboard/patch.lock.json");
const pinnedPiVersion = JSON.parse(await readFile(manifestPath, "utf8")).version;
const installedUtils = join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/utils");
const hash = (text) => createHash("sha256").update(text).digest("hex");
const sessionEnv = {
	TMUX: "/tmp/tmux-1000/default,123,7",
	TMUX_PANE: "%3",
};

async function withEnv(changes, callback) {
	const previous = new Map();
	for (const [key, value] of Object.entries(changes)) {
		previous.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await callback();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function readCalls(path) {
	const text = await readFile(path, "utf8").catch((error) => {
		if (error.code === "ENOENT") return "";
		throw error;
	});
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function writeExecutable(path, source) {
	await writeFile(path, source);
	await chmod(path, 0o755);
}

async function makePatchedPackage(t) {
	const temp = await mkdtemp(join(tmpdir(), "jouzu-terminal-clipboard-"));
	t.after(() => rm(temp, { recursive: true, force: true }));
	const packageRoot = join(temp, "package");
	const utils = join(packageRoot, "dist/utils");
	await mkdir(utils, { recursive: true });
	await mkdir(join(packageRoot, "node_modules/@earendil-works/pi-tui"), { recursive: true });
	await writeFile(
		join(packageRoot, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: pinnedPiVersion, type: "module" }),
	);
	await copyFile(join(installedUtils, "clipboard.js"), join(utils, "clipboard.js"));
	await copyFile(join(installedUtils, "clipboard-command.js"), join(utils, "clipboard-command.js"));
	await writeFile(join(utils, "wsl.js"), "export function isWSL() { return false; }\n");
	await writeFile(
		join(packageRoot, "node_modules/@earendil-works/pi-tui/package.json"),
		JSON.stringify({ name: "@earendil-works/pi-tui", version: pinnedPiVersion, type: "module", main: "index.js" }),
	);
	await writeFile(
		join(packageRoot, "node_modules/@earendil-works/pi-tui/index.js"),
		"export function getNativeClipboard() { return undefined; }\n",
	);
	await applyTerminalClipboard(packageRoot);
	return { temp, packageRoot, utils };
}

const FAKE_XCLIP = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
	appendFileSync(process.env.JOUZU_FAKE_LOG, JSON.stringify({ command: "xclip", args: process.argv.slice(2), input }) + "\\n");
});
`;

const FAKE_TMUX = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
	appendFileSync(process.env.JOUZU_FAKE_LOG, JSON.stringify({ command: "tmux", args, input }) + "\\n");
	if (args[0] === "display-message") process.stdout.write("%3|$7\\n");
	else if (args[0] === "list-clients") process.stdout.write("42|/dev/pts/9\\n");
	else if (args[0] === "show-options") process.stdout.write("on\\n");
	else if (args[0] !== "load-buffer") process.exitCode = 1;
});
`;

async function writeFakeCommands(directory) {
	const bin = join(directory, "bin");
	const withoutTmux = join(directory, "bin-no-tmux");
	await mkdir(bin, { recursive: true });
	await mkdir(withoutTmux, { recursive: true });
	await writeExecutable(join(bin, "xclip"), FAKE_XCLIP);
	await writeExecutable(join(bin, "tmux"), FAKE_TMUX);
	await copyFile(join(bin, "xclip"), join(withoutTmux, "xclip"));
	await chmod(join(withoutTmux, "xclip"), 0o755);
	return { bin, withoutTmux };
}

test("manifest locks the transform and the installed tmux module", async () => {
	const manifest = await readFile(manifestPath, "utf8");
	const lock = JSON.parse(manifest);
	assert.equal(lock.schemaVersion, 1);
	assert.equal(lock.package, "@earendil-works/pi-coding-agent");
	assert.equal(lock.version, pinnedPiVersion);
	assert.deepEqual(Object.keys(lock.files).sort(), [...paths].sort());
	assert.deepEqual(Object.keys(lock.additions).sort(), Object.keys(additions).sort());
	for (const path of paths) {
		const installed = await readFile(join(installedUtils, "clipboard.js"), "utf8");
		const installedHash = hash(installed);
		assert.ok(
			installedHash === lock.files[path].before || installedHash === lock.files[path].after,
			`unexpected installed clipboard hash: ${installedHash}`,
		);
		if (installedHash === lock.files[path].before)
			assert.equal(hash(transform(path, installed)), lock.files[path].after, path);
	}
	for (const [path, source] of Object.entries(additions)) {
		assert.equal(lock.additions[path].source, source);
		assert.equal(lock.additions[path].sha256, hash(additionSource(source)));
	}
	const pin = JSON.parse(await readFile(join(repoRoot, "upstream/pi.lock.json"), "utf8"));
	const records =
		pin.deviations?.filter((record) => record.path === "upstream/pi-terminal-clipboard/patch.lock.json") ?? [];
	assert.deepEqual(records, [{ path: "upstream/pi-terminal-clipboard/patch.lock.json", sha256: hash(manifest) }]);
});

test("apply writes the transform and addition once, then verifies idempotently", async (t) => {
	const { packageRoot, utils } = await makePatchedPackage(t);
	const patched = await readFile(join(utils, "clipboard.js"), "utf8");
	assert.match(patched, /import \{ copyToTmuxClipboard, isTmuxClipboardEnabled \} from "\.\/clipboard-tmux\.js";/);
	assert.match(patched, /const tmuxEnabled = isTmuxClipboardEnabled\(env\);/);
	assert.match(patched, /if \(env\.WT_SESSION && !tmuxEnabled\)/);
	assert.match(patched, /if \(tmuxEnabled\) \{/);
	assert.match(patched, /const tmux = await copyToTmuxClipboard\(text, \{ env \}\);/);
	assert.doesNotMatch(patched, /sourceMappingURL/);
	assert.equal(await readFile(join(utils, "clipboard-tmux.js"), "utf8"), additionSource("clipboard-tmux.js"));
	assert.equal(await applyTerminalClipboard(packageRoot), 0);
	assert.equal(await applyTerminalClipboard(packageRoot, { checkOnly: true }), 0);
});

test("apply refuses unrecognized clipboard bytes and conflicting additions", async (t) => {
	const temp = await mkdtemp(join(tmpdir(), "jouzu-terminal-clipboard-refuse-"));
	t.after(() => rm(temp, { recursive: true, force: true }));
	const packageRoot = join(temp, "package");
	const utils = join(packageRoot, "dist/utils");
	await mkdir(utils, { recursive: true });
	await writeFile(
		join(packageRoot, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: pinnedPiVersion, type: "module" }),
	);
	await writeFile(join(utils, "clipboard.js"), "unrecognized");
	await assert.rejects(applyTerminalClipboard(packageRoot), /hash mismatch/);
	assert.equal(await readFile(join(utils, "clipboard.js"), "utf8"), "unrecognized");

	const fixture = await makePatchedPackage(t);
	await writeFile(join(fixture.utils, "clipboard-tmux.js"), "different");
	await assert.rejects(applyTerminalClipboard(fixture.packageRoot), /installed hash mismatch/);
	await assert.rejects(applyTerminalClipboard(fixture.packageRoot, { checkOnly: true }), /installed hash mismatch/);
});

test("apply rejects missing or mismatched deviation pins", async (t) => {
	const temp = await mkdtemp(join(tmpdir(), "jouzu-clipboard-pin-"));
	t.after(() => rm(temp, { recursive: true, force: true }));
	await writeFile(join(temp, "package.json"), '{"type":"module"}');
	for (const path of [
		"scripts/apply-pi-terminal-clipboard.mjs",
		"upstream/pi-terminal-clipboard/patch.mjs",
		"upstream/pi-terminal-clipboard/patch.lock.json",
		"upstream/pi-terminal-clipboard/clipboard-tmux.js",
	]) {
		await mkdir(dirname(join(temp, path)), { recursive: true });
		await copyFile(join(repoRoot, path), join(temp, path));
	}
	const { applyTerminalClipboard: apply } = await import(
		pathToFileURL(join(temp, "scripts/apply-pi-terminal-clipboard.mjs"))
	);
	for (const deviations of [[], [{ path: "upstream/pi-terminal-clipboard/patch.lock.json", sha256: "wrong" }]]) {
		await writeFile(join(temp, "upstream/pi.lock.json"), JSON.stringify({ deviations }));
		await assert.rejects(apply(join(temp, "nonexistent-package")), /manifest does not match the pinned deviation/);
	}
});

test("selects only the pane session's client deterministically", async () => {
	const calls = [];
	const run = async (args, options = {}) => {
		calls.push({ args, input: options.input });
		if (args[0] === "display-message") return { ok: true, stdout: "%3|$7\n" };
		if (args[0] === "list-clients") return { ok: true, stdout: "10|/dev/pts/1\n20|/dev/pts/3\n20|/dev/pts/2\n" };
		if (args[0] === "load-buffer") return { ok: true, stdout: "" };
		throw new Error(`unexpected tmux command ${args[0]}`);
	};
	const result = await copyToTmuxClipboard("hello", { env: sessionEnv, run });
	assert.equal(result.status, "forwarded");
	assert.equal(result.accepted, true);
	assert.equal(result.confirmed, false);
	assert.equal(result.client, "/dev/pts/2");
	assert.deepEqual(calls[0].args, ["display-message", "-p", "-t", "%3", "#{pane_id}|#{session_id}"]);
	assert.deepEqual(calls[1].args, ["list-clients", "-t", "$7", "-F", "#{client_activity}|#{client_tty}"]);
	assert.deepEqual(calls[2].args, ["load-buffer", "-w", "-t", "/dev/pts/2", "-"]);
	assert.equal(calls[2].input, "hello");
	assert.ok(!calls[2].args.includes("%3"), "load-buffer must target a client, not the pane");
});

test("tmux context and client parsing stay deterministic across linked sockets", () => {
	assert.equal(tmuxSessionTarget("/tmp/tmux-1000/default,123,7"), "$7");
	assert.equal(tmuxSessionTarget("/tmp/a,b/default,123,4"), "$4");
	assert.equal(tmuxSessionTarget("bad"), undefined);
	assert.equal(tmuxSessionTarget("/tmp/tmux-1000/default,not-a-pid,7"), undefined);
	assert.equal(selectTmuxClient("20|/dev/pts/b\n20|/dev/pts/a\n30|/dev/pts/c\n"), "/dev/pts/c");
	assert.equal(selectTmuxClient("20|/dev/pts/b\n20|/dev/pts/a\n"), "/dev/pts/a");
	assert.equal(selectTmuxClient(""), undefined);
	assert.equal(selectTmuxClient("not-a-client\n"), undefined);
	assert.equal(isTmuxClipboardEnabled(sessionEnv), true);
	assert.equal(isTmuxClipboardEnabled({ ...sessionEnv, PI_CLIPBOARD_TMUX: "0" }), false);
	assert.equal(isTmuxClipboardEnabled({ ...sessionEnv, PI_CLIPBOARD_TMUX: "off" }), false);
	assert.equal(isTmuxClipboardEnabled({ TMUX: sessionEnv.TMUX }), false);
});

test("resolves the pane session and uses the env session only when membership is verified", async () => {
	const makeRun = (paneSession, membership) => {
		const calls = [];
		const run = async (args) => {
			calls.push(args);
			if (args[0] === "display-message") return { ok: true, stdout: `%3|${paneSession}\n` };
			if (args[0] === "list-panes") return membership;
			if (args[0] === "list-clients") return { ok: true, stdout: "1|/dev/pts/2\n" };
			if (args[0] === "load-buffer") return { ok: true, stdout: "" };
			throw new Error(`unexpected tmux command ${args[0]}`);
		};
		return { calls, run };
	};

	const verified = makeRun("$1", { ok: true, stdout: "%3\n" });
	const envSession = await copyToTmuxClipboard("text", { env: sessionEnv, run: verified.run });
	assert.equal(envSession.status, "forwarded");
	assert.deepEqual(
		verified.calls.find((args) => args[0] === "list-panes"),
		["list-panes", "-s", "-t", "$7", "-F", "#{pane_id}"],
	);
	assert.deepEqual(
		verified.calls.find((args) => args[0] === "list-clients"),
		["list-clients", "-t", "$7", "-F", "#{client_activity}|#{client_tty}"],
	);

	const moved = makeRun("$1", { ok: true, stdout: "%4\n" });
	const paneSession = await copyToTmuxClipboard("text", { env: sessionEnv, run: moved.run });
	assert.equal(paneSession.status, "forwarded");
	assert.deepEqual(
		moved.calls.find((args) => args[0] === "list-clients"),
		["list-clients", "-t", "$1", "-F", "#{client_activity}|#{client_tty}"],
	);

	const mismatch = makeRun("$7", { ok: true, stdout: "%3\n" });
	mismatch.run = async (args) => {
		mismatch.calls.push(args);
		if (args[0] === "display-message") return { ok: true, stdout: "%4|$7\n" };
		throw new Error(`unexpected tmux command ${args[0]}`);
	};
	const stalePane = await copyToTmuxClipboard("text", { env: sessionEnv, run: mismatch.run });
	assert.equal(stalePane.status, "pane-mismatch");
	assert.equal(stalePane.accepted, false);
});

test("text reaches tmux through stdin without shell interpolation", async () => {
	const text = "quote ' \" $HOME `id` ; rm -rf /\nline2 🦁 日本語 \u001b]52;c;evil\u0007";
	let loadCall;
	const run = async (args, options = {}) => {
		if (args[0] === "display-message") return { ok: true, stdout: "%3|$7\n" };
		if (args[0] === "list-clients") return { ok: true, stdout: "1|/dev/pts/2\n" };
		if (args[0] === "load-buffer") {
			loadCall = { args, input: options.input };
			return { ok: true, stdout: "" };
		}
		throw new Error(`unexpected tmux command ${args[0]}`);
	};
	const result = await copyToTmuxClipboard(text, { env: sessionEnv, run });
	assert.equal(result.accepted, true);
	assert.deepEqual(loadCall.args, ["load-buffer", "-w", "-t", "/dev/pts/2", "-"]);
	assert.equal(loadCall.input, text);
	assert.ok(!loadCall.args.includes(text), "text must not be interpolated into argv");
	assert.equal(
		tmuxOsc52Sequence(text),
		`\u001bPtmux;\u001b\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007\u001b\\`,
	);
});

test("wrapped OSC52 fallback is gated by tmux passthrough and the existing size cap", async () => {
	const text = "日本語 🦁";
	const fallback = async ({
		option,
		load = { ok: false, reason: "exit", code: 1 },
		payload = text,
		visibility = "1|0|1",
	}) => {
		const calls = [];
		const writes = [];
		const run = async (args) => {
			calls.push(args);
			if (args[0] === "display-message") {
				return { ok: true, stdout: args.at(-1).includes("window_active_clients") ? visibility : "%3|$7\n" };
			}
			if (args[0] === "list-clients") return { ok: true, stdout: "1|/dev/pts/2\n" };
			if (args[0] === "load-buffer") return load;
			if (args[0] === "show-options") return option;
			throw new Error(`unexpected tmux command ${args[0]}`);
		};
		const result = await copyToTmuxClipboard(payload, { env: sessionEnv, run, write: (value) => writes.push(value) });
		return { calls, writes, result };
	};

	const enabled = await fallback({ option: { ok: true, stdout: "on\n" } });
	assert.equal(enabled.result.status, "osc52");
	assert.equal(enabled.result.accepted, true);
	assert.equal(enabled.result.confirmed, false);
	assert.equal(enabled.result.fallback, "emitted");
	assert.deepEqual(enabled.writes, [tmuxOsc52Sequence(text)]);
	assert.ok(
		enabled.calls.every((args) => args[0] !== "set-option"),
		"must not change tmux configuration",
	);
	const optionCall = enabled.calls.find((args) => args[0] === "show-options");
	assert.deepEqual(optionCall, ["show-options", "-A", "-pv", "-t", "%3", "allow-passthrough"]);

	for (const visibility of ["0|0|1", "1|1|0", "invalid"]) {
		const hidden = await fallback({ option: { ok: true, stdout: "on\n" }, visibility });
		assert.equal(hidden.result.accepted, false);
		assert.equal(hidden.result.fallback, "pane-not-visible");
		assert.deepEqual(hidden.writes, []);
	}
	const all = await fallback({ option: { ok: true, stdout: "all\n" }, visibility: "0|0|1" });
	assert.equal(all.result.accepted, true);
	assert.equal(all.writes.length, 1);

	const disabled = await fallback({ option: { ok: true, stdout: "off\n" } });
	assert.equal(disabled.result.status, "load-failed");
	assert.equal(disabled.result.accepted, false);
	assert.equal(disabled.result.confirmed, false);
	assert.equal(disabled.result.fallback, "passthrough-off");
	assert.deepEqual(disabled.writes, []);

	const inherited = await fallback({ option: { ok: true, stdout: "*on\n" } });
	assert.equal(inherited.result.accepted, true);
	assert.equal(inherited.writes.length, 1);

	const unavailable = await fallback({ option: { ok: false, reason: "unavailable" } });
	assert.equal(unavailable.result.status, "load-failed");
	assert.equal(unavailable.result.accepted, false);
	assert.equal(unavailable.result.fallback, "passthrough-unavailable");
	assert.deepEqual(unavailable.writes, []);

	const oversizedText = "x".repeat(Math.floor((MAX_OSC52_ENCODED_LENGTH * 3) / 4) + 1);
	assert.equal(tmuxOsc52Sequence(oversizedText), undefined);
	const oversized = await fallback({ option: { ok: true, stdout: "on\n" }, payload: oversizedText });
	assert.equal(oversized.result.status, "load-failed");
	assert.equal(oversized.result.accepted, false);
	assert.equal(oversized.result.fallback, "oversized");
	assert.deepEqual(oversized.writes, []);

	const directWrites = [];
	const direct = await emitTmuxOsc52Fallback(text, {
		run: async () => ({ ok: true, stdout: "off\n" }),
		write: (value) => directWrites.push(value),
		pane: "%3",
	});
	assert.equal(direct.status, "passthrough-off");
	assert.deepEqual(directWrites, []);
});

test("absent, detached, failed, and timed-out tmux never report confirmed success", async () => {
	const cases = [
		{
			name: "absent",
			resolve: { ok: false, reason: "unavailable" },
			list: { ok: false, reason: "unavailable" },
			status: "unavailable",
			accepted: false,
			calls: 1,
		},
		{
			name: "no client",
			list: { ok: true, stdout: "" },
			status: "no-client",
			accepted: false,
			calls: 2,
		},
		{
			name: "list failed",
			list: { ok: false, reason: "exit", code: 1 },
			status: "list-failed",
			accepted: false,
			calls: 3,
		},
		{
			name: "list timed out",
			list: { ok: false, reason: "timeout" },
			status: "list-timed-out",
			accepted: false,
			calls: 3,
		},
		{
			name: "list failed with passthrough",
			list: { ok: false, reason: "exit", code: 1 },
			option: { ok: true, stdout: "on\n" },
			status: "osc52",
			accepted: true,
			calls: 4,
		},
		{
			name: "load failed",
			list: { ok: true, stdout: "1|/dev/pts/2\n" },
			load: { ok: false, reason: "exit", code: 1 },
			option: { ok: true, stdout: "off\n" },
			status: "load-failed",
			accepted: false,
			calls: 4,
		},
		{
			name: "load timed out",
			list: { ok: true, stdout: "1|/dev/pts/2\n" },
			load: { ok: false, reason: "timeout" },
			option: { ok: true, stdout: "off\n" },
			status: "load-timed-out",
			accepted: false,
			calls: 4,
		},
	];
	for (const item of cases) {
		const calls = [];
		const run = async (args) => {
			calls.push(args);
			if (args[0] === "display-message") {
				if (args.at(-1).includes("window_active_clients")) return { ok: true, stdout: "1|0|1" };
				return item.resolve ?? { ok: true, stdout: "%3|$7\n" };
			}
			if (args[0] === "list-panes") return item.membership ?? { ok: true, stdout: "%3\n" };
			if (args[0] === "list-clients") return item.list;
			if (args[0] === "load-buffer") return item.load ?? { ok: true, stdout: "" };
			if (args[0] === "show-options") return item.option ?? { ok: true, stdout: "off\n" };
			throw new Error(`unexpected tmux command ${args[0]}`);
		};
		const result = await copyToTmuxClipboard("text", { env: sessionEnv, run, write: () => {} });
		assert.equal(result.status, item.status, item.name);
		assert.equal(result.accepted, item.accepted, item.name);
		assert.equal(result.confirmed, false, item.name);
		assert.equal(calls.length, item.calls, item.name);
	}
});

test("default runner bounds a hung tmux and tolerates EPIPE", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX executable fixture");
	const temp = await mkdtemp(join(tmpdir(), "jouzu-terminal-clipboard-runner-"));
	t.after(() => rm(temp, { recursive: true, force: true }));
	const bin = join(temp, "bin");
	await mkdir(bin, { recursive: true });
	await writeExecutable(join(bin, "tmux-hang"), "#!/usr/bin/env node\nsetTimeout(() => {}, 5000);\n");
	await writeExecutable(join(bin, "tmux-exit"), "#!/usr/bin/env node\nprocess.exit(0);\n");
	const path = `${bin}:${dirname(process.execPath)}`;
	await withEnv({ PATH: path }, async () => {
		await copyFile(join(bin, "tmux-hang"), join(bin, "tmux"));
		await chmod(join(bin, "tmux"), 0o755);
		const started = Date.now();
		const timedOut = await runTmuxCommand(["list-clients"], { timeoutMs: 100 });
		assert.equal(timedOut.ok, false);
		assert.equal(timedOut.reason, "timeout");
		assert.ok(Date.now() - started < 3000, "hung tmux must be killed within the bound");

		await copyFile(join(bin, "tmux-exit"), join(bin, "tmux"));
		await chmod(join(bin, "tmux"), 0o755);
		const earlyExit = await runTmuxCommand(["load-buffer", "-w", "-t", "/dev/pts/1", "-"], {
			input: "x".repeat(256 * 1024),
			timeoutMs: 1000,
		});
		assert.deepEqual(earlyExit, { ok: false, reason: "input-failed" });

		await writeExecutable(join(bin, "tmux"), '#!/usr/bin/env node\nprocess.stdout.write("x".repeat(100000));\n');
		assert.deepEqual(await runTmuxCommand(["list-clients"], { maxOutputBytes: 100, timeoutMs: 1000 }), {
			ok: false,
			reason: "output-too-large",
		});
	});
	await withEnv({ PATH: dirname(process.execPath) }, async () => {
		const missing = await runTmuxCommand(["list-clients"], { timeoutMs: 100 });
		assert.equal(missing.ok, false);
		assert.equal(missing.reason, "unavailable");
	});
});

test("patched Pi keeps the native clipboard path and still forwards through tmux", async (t) => {
	if (process.platform !== "linux") return t.skip("Linux native clipboard fixture");
	const { temp, utils } = await makePatchedPackage(t);
	const { bin, withoutTmux } = await writeFakeCommands(temp);
	const log = join(temp, "calls.jsonl");
	const text = "native first 🦁\nquote ' \" $HOME `id` ;";
	const env = {
		PATH: `${bin}:${process.env.PATH}`,
		JOUZU_FAKE_LOG: log,
		DISPLAY: ":99",
		TMUX: sessionEnv.TMUX,
		TMUX_PANE: sessionEnv.TMUX_PANE,
		WAYLAND_DISPLAY: undefined,
		TERMUX_VERSION: undefined,
		SSH_CONNECTION: undefined,
		SSH_CLIENT: undefined,
		MOSH_CONNECTION: undefined,
		PI_CLIPBOARD_OSC52: undefined,
		PI_CLIPBOARD_TMUX: undefined,
		WSL_DISTRO_NAME: undefined,
		WSLENV: undefined,
	};
	await withEnv(env, async () => {
		const { copyToClipboard } = await import(pathToFileURL(join(utils, "clipboard.js")).href);
		await copyToClipboard(text);
		const calls = await readCalls(log);
		assert.deepEqual(calls[0], { command: "xclip", args: ["-selection", "clipboard"], input: text });
		assert.deepEqual(calls[1].args, ["display-message", "-p", "-t", "%3", "#{pane_id}|#{session_id}"]);
		assert.deepEqual(calls[2].args, ["list-clients", "-t", "$7", "-F", "#{client_activity}|#{client_tty}"]);
		assert.deepEqual(calls[3].args, ["load-buffer", "-w", "-t", "/dev/pts/9", "-"]);
		assert.equal(calls[3].input, text);
		assert.equal(calls.length, 4);

		await writeFile(log, "");
		await withEnv({ PI_CLIPBOARD_TMUX: "0" }, () => copyToClipboard(text));
		const optedOut = await readCalls(log);
		assert.deepEqual(optedOut, [{ command: "xclip", args: ["-selection", "clipboard"], input: text }]);

		await writeFile(log, "");
		await withEnv({ PATH: `${withoutTmux}:${dirname(process.execPath)}` }, () => copyToClipboard(text));
		const absent = await readCalls(log);
		assert.deepEqual(absent, [{ command: "xclip", args: ["-selection", "clipboard"], input: text }]);

		await withEnv({ PATH: `${withoutTmux}:${dirname(process.execPath)}`, DISPLAY: undefined }, async () => {
			const writes = [];
			const originalWrite = process.stdout.write;
			process.stdout.write = (chunk) => {
				writes.push(String(chunk));
				return true;
			};
			try {
				await assert.rejects(copyToClipboard("headless"), /tmux forwarding failed \(unavailable\)/);
			} finally {
				process.stdout.write = originalWrite;
			}
			assert.ok(!writes.some((value) => value.includes("]52;")), "plain OSC52 must be suppressed in tmux");

			const optedOutWrites = [];
			process.stdout.write = (chunk) => {
				optedOutWrites.push(String(chunk));
				return true;
			};
			try {
				await withEnv({ PI_CLIPBOARD_TMUX: "0" }, () => copyToClipboard("headless"));
			} finally {
				process.stdout.write = originalWrite;
			}
			assert.ok(
				optedOutWrites.some((value) => value.includes("]52;c;")),
				"explicit tmux opt-out must keep ordinary OSC52 behavior",
			);
		});
	});
});

test("tmux buffer payload stays bounded before spawning a client", async () => {
	const calls = [];
	const run = async (args) => {
		calls.push(args);
		if (args[0] === "display-message") return { ok: true, stdout: "%3|$7\n" };
		return { ok: true, stdout: "" };
	};
	const result = await copyToTmuxClipboard("x".repeat(TMUX_MAX_BUFFER_BYTES + 1), { env: sessionEnv, run });
	assert.equal(result.status, "too-large");
	assert.equal(result.accepted, false);
	assert.equal(result.confirmed, false);
	assert.deepEqual(calls, []);
});

const TMUX_PYTHON = `
import base64
import json
import os
import pty
import select
import signal
import subprocess
import sys
import time

sock = os.environ["SOCK"]
ready = os.environ["READY"]
result_path = os.environ["RESULT"]
script = os.environ["SCRIPT"]
env = dict(os.environ)
env["TERM"] = "xterm-256color"
env.pop("TMUX", None)
env.pop("TMUX_PANE", None)

def tmux(*args, **kwargs):
    return subprocess.run(["tmux", "-L", sock, *args], env=env, capture_output=True, text=True, **kwargs)

def drain(fd, seconds):
    data = b""
    end = time.time() + seconds
    while time.time() < end:
        ready_fds, _, _ = select.select([fd], [], [], 0.1)
        if not ready_fds:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        data += chunk
    return data

client_pid = None
try:
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "clip", "bash", "-c",
         'while [ ! -f "$READY" ]; do sleep 0.05; done; node "$SCRIPT"; sleep 1')
    client_pid, fd = pty.fork()
    if client_pid == 0:
        os.execvpe("tmux", ["tmux", "-L", sock, "attach-session", "-t", "clip"], env)
    output = b""
    for _ in range(30):
        output += drain(fd, 0.1)
        if tmux("list-clients", "-F", "#{client_tty}").stdout.strip():
            break
    with open(ready, "w", encoding="utf-8"):
        pass
    deadline = time.time() + 8
    while time.time() < deadline and not os.path.exists(result_path):
        output += drain(fd, 0.1)
    output += drain(fd, 0.5)
    buffer = tmux("show-buffer").stdout
    clients = tmux("list-clients", "-F", "#{client_tty}").stdout
    options = {
        "set-clipboard": tmux("show-options", "-gv", "set-clipboard").stdout.strip(),
        "allow-passthrough": tmux("show-options", "-gv", "allow-passthrough").stdout.strip(),
    }
    result = json.loads(open(result_path, encoding="utf-8").read()) if os.path.exists(result_path) else None
    print(json.dumps({
        "output": base64.b64encode(output).decode(),
        "buffer": base64.b64encode(buffer.encode()).decode(),
        "clients": clients,
        "options": options,
        "result": result,
    }))
finally:
    if client_pid is not None:
        try:
            os.kill(client_pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(client_pid, 0)
        except ChildProcessError:
            pass
    tmux("kill-server")
`;

test("isolated tmux delivers UTF-8 to the paste buffer with set-clipboard external", async (t) => {
	if (process.platform === "win32") return t.skip("tmux is not available on Windows");
	const tmuxVersion = spawnSync("tmux", ["-V"], { encoding: "utf8" });
	const pythonVersion = spawnSync("python3", ["--version"], { encoding: "utf8" });
	if (tmuxVersion.status !== 0 || pythonVersion.status !== 0) return t.skip("tmux or python3 is unavailable");
	const temp = await mkdtemp(join(tmpdir(), "jouzu-terminal-clipboard-tmux-"));
	t.after(() => rm(temp, { recursive: true, force: true }));
	const text = '日本語 🦁 line1\nquote " $HOME `id` ; \\ backslash\n';
	const textFile = join(temp, "text.txt");
	const resultFile = join(temp, "result.json");
	const readyFile = join(temp, "ready");
	const scriptFile = join(temp, "clip.mjs");
	await writeFile(textFile, text);
	const moduleUrl = pathToFileURL(join(repoRoot, "upstream/pi-terminal-clipboard/clipboard-tmux.js")).href;
	await writeFile(
		scriptFile,
		`import { readFileSync, writeFileSync } from "node:fs";
import { copyToTmuxClipboard } from ${JSON.stringify(moduleUrl)};
const text = readFileSync(process.env.TEXT_FILE, "utf8");
const result = await copyToTmuxClipboard(text);
writeFileSync(process.env.RESULT, JSON.stringify(result));
`,
	);
	const pythonEnv = {
		...process.env,
		SOCK: `jouzu-clipboard-${process.pid}-${Date.now()}`,
		READY: readyFile,
		RESULT: resultFile,
		SCRIPT: scriptFile,
		TEXT_FILE: textFile,
	};
	delete pythonEnv.TMUX;
	delete pythonEnv.TMUX_PANE;
	const run = spawnSync("python3", ["-c", TMUX_PYTHON], {
		env: pythonEnv,
		encoding: "utf8",
		timeout: 20_000,
	});
	assert.equal(run.status, 0, run.stderr || run.error?.message);
	const observed = JSON.parse(run.stdout);
	assert.deepEqual(observed.options, { "set-clipboard": "external", "allow-passthrough": "off" });
	assert.equal(observed.result.status, "forwarded");
	assert.equal(observed.result.accepted, true);
	assert.equal(observed.result.confirmed, false);
	assert.match(observed.clients, /^\/dev\//);
	assert.ok(observed.clients.split("\n").filter(Boolean).includes(observed.result.client));
	assert.equal(Buffer.from(observed.buffer, "base64").toString("utf8"), text);
	const output = Buffer.from(observed.output, "base64").toString("utf8");
	assert.match(output, /\]52;/);
	assert.ok(output.includes(Buffer.from(text).toString("base64")), "client did not receive the OSC 52 payload");
});

test("real tmux fallback honors pane overrides and visibility", async (t) => {
	if (process.platform === "win32") return t.skip("tmux is unavailable on Windows");
	if (spawnSync("tmux", ["-V"]).status !== 0 || spawnSync("python3", ["--version"]).status !== 0)
		return t.skip("tmux or python3 is unavailable");
	const temp = await mkdtemp(join(tmpdir(), "jouzu-clipboard-fallback-"));
	t.after(() => rm(temp, { recursive: true, force: true }));
	const scriptFile = join(temp, "fallback.mjs");
	const moduleUrl = pathToFileURL(join(repoRoot, "upstream/pi-terminal-clipboard/clipboard-tmux.js")).href;
	await writeFile(
		scriptFile,
		`
import { writeFileSync } from "node:fs";
import { emitTmuxOsc52Fallback, runTmuxCommand } from ${JSON.stringify(moduleUrl)};
const pane = process.env.TMUX_PANE;
async function command(args) {
 const result = await runTmuxCommand(args);
 if (!result.ok) throw Error(JSON.stringify({ args, result }));
}
await command(["set-option", "-w", "-t", pane, "allow-passthrough", "off"]);
await command(["set-option", "-p", "-t", pane, "allow-passthrough", "on"]);
const visible = await emitTmuxOsc52Fallback("visible-pane-override", { pane });
await command(["set-option", "-w", "-t", pane, "allow-passthrough", "on"]);
await command(["set-option", "-p", "-t", pane, "allow-passthrough", "off"]);
const blocked = await emitTmuxOsc52Fallback("blocked-pane-override", { pane });
await command(["set-option", "-p", "-t", pane, "allow-passthrough", "on"]);
await command(["new-window", "-t", "clip", "-n", "other"]);
const hidden = await emitTmuxOsc52Fallback("hidden-pane-on", { pane });
await command(["set-option", "-p", "-t", pane, "allow-passthrough", "all"]);
const all = await emitTmuxOsc52Fallback("hidden-pane-all", { pane });
writeFileSync(process.env.RESULT, JSON.stringify({ visible, blocked, hidden, all }));
`,
	);
	const run = spawnSync("python3", ["-c", TMUX_PYTHON], {
		env: {
			...process.env,
			SOCK: `jouzu-fallback-${process.pid}-${Date.now()}`,
			READY: join(temp, "ready"),
			RESULT: join(temp, "result.json"),
			SCRIPT: scriptFile,
		},
		encoding: "utf8",
		timeout: 20_000,
	});
	assert.equal(run.status, 0, run.stderr || run.error?.message);
	const observed = JSON.parse(run.stdout);
	assert.deepEqual(observed.result, {
		visible: { status: "emitted" },
		blocked: { status: "passthrough-off" },
		hidden: { status: "pane-not-visible" },
		all: { status: "emitted" },
	});
	const output = Buffer.from(observed.output, "base64").toString("utf8");
	for (const text of ["visible-pane-override", "hidden-pane-all"])
		assert.ok(output.includes(Buffer.from(text).toString("base64")), `${text} reached the terminal`);
	for (const text of ["blocked-pane-override", "hidden-pane-on"])
		assert.ok(!output.includes(Buffer.from(text).toString("base64")), `${text} was not emitted`);
});

test("copy notifications describe a request rather than confirmed delivery", async () => {
	const interactive = await readFile(join(installedUtils, "../modes/interactive/interactive-mode.js"), "utf8");
	assert.ok(interactive.includes('this.ui.flash("Copy requested")'));
	assert.ok(interactive.includes('this.showStatus("Clipboard copy requested for selected message")'));
	assert.ok(interactive.includes('this.showStatus("Clipboard copy requested for last agent message")'));
	assert.doesNotMatch(
		interactive,
		/Copied selected message to clipboard|Copied last agent message to clipboard|Copied!/,
	);
});
