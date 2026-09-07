import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { resolveJouzuPaths } from "../dist/paths.js";
import { captureEnvironment } from "../dist/voice/capture.js";
import { createVoiceExtension, renderVoiceWidget } from "../dist/voice/integration.js";
import { VoiceReviewRequired, VoiceTranscript } from "../dist/voice/transcript.js";

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((a, b) => {
		resolve = a;
		reject = b;
	});
	return { promise, resolve, reject };
}

async function harness(t, overrides = {}) {
	const home = mkdtempSync(join(tmpdir(), "jouzu-voice-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const commands = new Map();
	const handlers = new Map();
	const calls = [];
	let draft = "existing draft";
	let connectionOptions;
	let captureOptions;
	const connection = {
		sendAudio(pcm) {
			calls.push(["audio", pcm]);
		},
		async finish() {
			calls.push(["finish"]);
			return "こんにちは";
		},
		cancel() {
			calls.push(["connection.cancel"]);
		},
	};
	const capture = {
		async stop() {
			calls.push(["capture.stop"]);
		},
		cancel() {
			calls.push(["capture.cancel"]);
		},
	};
	const ctx = {
		mode: "tui",
		ui: {
			notify(...args) {
				calls.push(["notify", ...args]);
			},
			setWidget(...args) {
				calls.push(["widget", ...args]);
			},
			setStatus(...args) {
				calls.push(["status", ...args]);
			},
			getEditorText() {
				return draft;
			},
			pasteToEditor(text) {
				calls.push(["paste", text]);
				draft += text;
			},
			async select() {
				return undefined;
			},
		},
	};
	await createVoiceExtension(resolveJouzuPaths({ homeOverride: home }), {
		env: { SHISA_API_KEY: "test-key" },
		async connect(options) {
			connectionOptions = options;
			return connection;
		},
		async capture(options) {
			captureOptions = options;
			return capture;
		},
		async devices() {
			return ["Microphone"];
		},
		...overrides,
	}).factory({
		registerCommand(name, command) {
			commands.set(name, command);
		},
		registerShortcut(...args) {
			calls.push(["shortcut", ...args]);
		},
		on(event, handler) {
			handlers.set(event, handler);
		},
		sendUserMessage() {
			assert.fail("must never send transcription to the model");
		},
	});
	t.after(() => handlers.get("session_shutdown")());
	return {
		calls,
		connection,
		capture,
		ctx,
		command: (args) => commands.get("voice").handler(args, ctx),
		shutdown: () => handlers.get("session_shutdown")(),
		get connectionOptions() {
			return connectionOptions;
		},
		get captureOptions() {
			return captureOptions;
		},
		get draft() {
			return draft;
		},
		set draft(text) {
			draft = text;
		},
	};
}

test("voice loads without capture or network access and registers the default shortcut", async (t) => {
	const h = await harness(t);
	assert.equal(h.connectionOptions, undefined);
	assert.equal(h.captureOptions, undefined);
	const shortcuts = h.calls.filter((call) => call[0] === "shortcut");
	assert.deepEqual(
		shortcuts.map((call) => call[1]),
		["ctrl+\\"],
	);
	assert.equal(h.calls.length, shortcuts.length, "nothing beyond the shortcut registration");
});

test("voice registers a configured modified shortcut but leaves bare keys for typing", (t) => {
	const home = mkdtempSync(join(tmpdir(), "jouzu-voice-keys-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const paths = resolveJouzuPaths({ homeOverride: home });
	mkdirSync(paths.agentDir, { recursive: true });
	writeFileSync(join(paths.agentDir, "keybindings.json"), JSON.stringify({ "jouzu.voice.toggle": ["alt+r", "r"] }));
	const keys = [];
	createVoiceExtension(paths).factory({
		registerCommand() {},
		on() {},
		registerShortcut(key) {
			keys.push(key);
		},
	});
	assert.deepEqual(keys, ["alt+r"]);
});

test("voice registers no shortcut when the default is unbound", (t) => {
	const home = mkdtempSync(join(tmpdir(), "jouzu-voice-keys-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const paths = resolveJouzuPaths({ homeOverride: home });
	mkdirSync(paths.agentDir, { recursive: true });
	writeFileSync(join(paths.agentDir, "keybindings.json"), JSON.stringify({ "jouzu.voice.toggle": [] }));
	const keys = [];
	createVoiceExtension(paths).factory({
		registerCommand() {},
		on() {},
		registerShortcut(key) {
			keys.push(key);
		},
	});
	assert.deepEqual(keys, []);
});

test("voice finalizes after capture stops and inserts into the live draft only", async (t) => {
	const h = await harness(t);
	await h.command("start");
	h.connectionOptions.onPreview("provisional");
	assert.equal(h.draft, "existing draft");
	h.draft = "edited while recording";
	h.captureOptions.onAudio(Buffer.alloc(3200));
	await h.command("stop");
	assert.equal(h.draft, "edited while recording\nこんにちは");
	assert.ok(h.calls.findIndex(([name]) => name === "capture.stop") < h.calls.findIndex(([name]) => name === "finish"));
	assert.equal(h.calls.filter(([name]) => name === "paste").length, 1);
});

test("cancel during connection releases a late connection without opening the mic", async (t) => {
	const pending = deferred();
	const h = await harness(t, { connect: () => pending.promise });
	const start = h.command("start");
	await h.command("cancel");
	pending.resolve(h.connection);
	await start;
	assert.equal(h.captureOptions, undefined);
	assert.ok(h.calls.some(([name]) => name === "connection.cancel"));
	assert.equal(h.draft, "existing draft");
});

test("shutdown during finalization discards late text", async (t) => {
	const pending = deferred();
	const h = await harness(t);
	h.connection.finish = () => pending.promise;
	await h.command("start");
	const stop = h.command("stop");
	await Promise.resolve();
	h.shutdown();
	pending.resolve("late transcription");
	await stop;
	assert.equal(h.draft, "existing draft");
	assert.equal(h.captureOptions.signal.aborted, true);
});

test("repeated start/stop cannot create duplicate capture or insert twice", async (t) => {
	const h = await harness(t);
	await h.command("start");
	const firstOptions = h.captureOptions;
	await h.command("start");
	assert.equal(h.captureOptions, firstOptions);
	await Promise.all([h.command("stop"), h.command("stop")]);
	assert.equal(h.calls.filter(([name]) => name === "paste").length, 1);
});

test("cancelled recordings can restart without stale preview or final insertion", async (t) => {
	const h = await harness(t);
	await h.command("start");
	const old = h.connectionOptions;
	await h.command("cancel");
	await h.command("start");
	const count = h.calls.length;
	old.onPreview("stale");
	assert.equal(h.calls.length, count);
	await h.command("stop");
	assert.equal(h.calls.filter(([name]) => name === "paste").length, 1);
});

test("missing credentials and noninteractive modes never start capture", async (t) => {
	const h = await harness(t, { env: {} });
	await h.command("start");
	assert.equal(h.connectionOptions, undefined);
	for (const mode of ["print", "json", "rpc"]) {
		h.ctx.mode = mode;
		await h.command("start");
	}
	assert.equal(h.captureOptions, undefined);
});

test("voice device selection is explicit and language is validated", async (t) => {
	const h = await harness(t);
	h.ctx.ui.select = async (_title, labels) => labels[1];
	await h.command("devices");
	await h.command("language ja");
	await h.command("start");
	assert.equal(h.captureOptions.device, 0);
	assert.equal(h.connectionOptions.language, "ja");
});

test("voice widget fits narrow terminals and strips remote escape sequences", () => {
	for (const width of [1, 10, 12, 24, 48, 80]) {
		for (const state of ["starting", "recording", "finishing"]) {
			const lines = renderVoiceWidget(state, "日本語 👩🏽‍💻 \x1b[31mremote\x1b[0m\x1b]52;c;secret\x07", width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.ok(lines.every((line) => !line.includes("\x1b")));
		}
	}
});

test("transcript commits finals, deduplicates IDs, and ignores partials", () => {
	const transcript = new VoiceTranscript();
	transcript.accept({ type: "asr.partial_result", result_id: "p1", utterance_id: "u1", text: "partial" });
	assert.equal(transcript.text, "");
	transcript.accept({ type: "asr.final_result", result_id: "f1", utterance_id: "u1", text: "final" });
	transcript.accept({ type: "asr.final_result", result_id: "f1", utterance_id: "u1", text: "final" });
	assert.equal(transcript.text, "final");
	transcript.accept({ type: "asr.final_result", result_id: "f2", replaces: ["f1"], text: "corrected" });
	assert.equal(transcript.text, "corrected");
	assert.throws(() => transcript.accept({ type: "asr.final_result", result_id: "f3", text: "x".repeat(64_001) }));
});

test("a capture startup failure cannot leak an untrusted error or change the draft", async (t) => {
	const h = await harness(t, {
		capture: async () => {
			throw new Error("test-key secret native error");
		},
	});
	await h.command("start");
	assert.equal(h.draft, "existing draft");
	assert.ok(h.calls.some(([name]) => name === "connection.cancel"));
	assert.ok(!JSON.stringify(h.calls.filter(([name]) => name === "notify")).includes("test-key"));
});

test("cancel during microphone startup releases late capture without inserting", async (t) => {
	const pending = deferred();
	const h = await harness(t, { capture: () => pending.promise });
	const start = h.command("start");
	await Promise.resolve();
	await h.command("cancel");
	pending.resolve(h.capture);
	await start;
	assert.equal(h.draft, "existing draft");
	assert.ok(h.calls.some(([name]) => name === "capture.cancel"));
});

test("an empty final transcript leaves the current draft untouched", async (t) => {
	const h = await harness(t);
	h.connection.finish = async () => "";
	await h.command("start");
	await h.command("stop");
	assert.equal(h.draft, "existing draft");
	assert.ok(!h.calls.some(([name]) => name === "paste"));
});

test("the recording deadline stops capture and finalizes once", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = await harness(t, { maxRecordingMs: 100 });
	await h.command("start");
	t.mock.timers.tick(100);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(h.draft, "existing draft\nこんにちは");
	assert.equal(h.calls.filter(([name]) => name === "capture.stop").length, 1);
});

test("failed finalization inserts finals and markers into the live draft without a dialog", async (t) => {
	const h = await harness(t);
	h.connection.finish = async () => {
		throw new VoiceReviewRequired({
			segments: [
				{ id: "a", state: "final", text: "good" },
				{ id: "b", state: "failed", text: "rough" },
				{ id: "c", state: "pending", text: "guess" },
				{ id: "d", state: "final", text: "日本語" },
			],
		});
	};
	await h.command("start");
	h.draft = "edited while recording";
	await h.command("stop");
	assert.equal(h.draft, "edited while recording\ngood\n[garbled]\n[garbled]\n日本語");
	assert.equal(h.calls.filter(([name]) => name === "paste").length, 1);
	await h.command("start");
	await h.command("cancel");
});

test("an entirely failed recording inserts a marker into an empty prompt", async (t) => {
	const h = await harness(t);
	h.connection.finish = async () => {
		throw new VoiceReviewRequired({ segments: [{ id: "a", state: "failed", text: "rough" }] });
	};
	h.draft = "";
	await h.command("start");
	await h.command("stop");
	assert.equal(h.draft, "[garbled]");
});

test("transport failure inserts good chunks with an unknown tail and ignores stale callbacks", async (t) => {
	const h = await harness(t);
	await h.command("start");
	const options = h.connectionOptions;
	options.onSnapshot({ segments: [{ id: "a", state: "final", text: "good" }] });
	options.onError(new Error("lost network"));
	const callCount = h.calls.length;
	options.onSnapshot({ segments: [] });
	assert.equal(h.calls.length, callCount);
	assert.equal(h.draft, "existing draft\ngood\n[garbled]");
	assert.equal(h.calls.filter(([name]) => name === "paste").length, 1);
	assert.equal(h.captureOptions.signal.aborted, true);
});

for (const action of ["cancel", "shutdown"]) {
	test(`${action} discards a late incomplete finalization`, async (t) => {
		const h = await harness(t);
		const pending = deferred();
		h.connection.finish = () => pending.promise;
		await h.command("start");
		const stop = h.command("stop");
		await Promise.resolve();
		if (action === "shutdown") h.shutdown();
		else await h.command("cancel");
		pending.reject(new VoiceReviewRequired({ segments: [{ id: "a", state: "failed", text: "rough" }] }));
		await stop;
		assert.equal(h.draft, "existing draft");
	});
}

test("microphone helper environment excludes service credentials and Node injection", () => {
	assert.deepEqual(
		captureEnvironment({
			HOME: "/home/test",
			SHISA_API_KEY: "secret",
			NODE_OPTIONS: "--require evil.js",
			PATH: "/bin",
			XDG_RUNTIME_DIR: "/run/user/test",
		}),
		{
			HOME: "/home/test",
			PATH: "/bin",
			XDG_RUNTIME_DIR: "/run/user/test",
		},
	);
});
