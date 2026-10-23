import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const pi = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href;

/**
 * Run the built RPC runtime with one fixture extension and a flow ingress, so a prompt reaches the
 * command handler the way the product host dispatches it. `options.flowIngress` replaces the
 * pass-through factory with fixture source for admission, disposal, and parking behavior, and
 * `options.preMain` installs fixture hooks before the runtime starts. The child gets an IPC channel
 * so a fixture can report an event and the test can release it without timing guesses.
 */
async function rpcFixture(t, source = "export default function () {}", options = {}) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-rpc-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const outcome = join(root, "outcome.json");
	const settlement = join(root, "settlement.json");
	const extension = join(root, "fixture.mjs");
	await writeFile(extension, typeof source === "function" ? source({ root, outcome }) : source);
	const flowIngress =
		typeof options.flowIngress === "function"
			? options.flowIngress({ root, outcome, settlement })
			: (options.flowIngress ??
				`async () => ({
				version: 1,
				submit(input, dispatch) { return dispatch(); }
			})`);
	const probe = `
		const { main } = await import(${JSON.stringify(pi)});
		${options.preMain ?? ""}
		await main(["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", ${JSON.stringify(extension)}], {
			flowIngressFactory: ${options.flowOff ? "undefined" : flowIngress}
		});
	`;
	const child = spawn(process.execPath, ["--input-type=module", "--eval", probe], {
		cwd: root,
		env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1" },
		stdio: ["pipe", "pipe", "pipe", "ipc"],
	});
	const events = new EventEmitter();
	const frames = [];
	const messages = [];
	let stderr = "";
	let buffer = "";
	let exit;
	child.stdout.setEncoding("utf8").on("data", (data) => {
		buffer += data;
		while (buffer.includes("\n")) {
			const newline = buffer.indexOf("\n");
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line.trim()) continue;
			try {
				frames.push(JSON.parse(line));
			} catch {
				stderr += `\nUnexpected stdout: ${line.slice(0, 200)}`;
			}
		}
		events.emit("change");
	});
	child.stderr.setEncoding("utf8").on("data", (data) => {
		stderr += data;
		events.emit("change");
	});
	child.on("message", (message) => {
		messages.push(message);
		events.emit("change");
	});
	child.stdin.on("error", () => {});
	child.on("error", (error) => {
		stderr += `\nSpawn error: ${error.message}`;
		events.emit("change");
	});
	child.on("close", (code, signal) => {
		exit = { code, signal };
		events.emit("change");
	});
	t.after(() => {
		if (child.exitCode === null) child.kill("SIGKILL");
	});
	function waitFor(check, label, timeout = 15000) {
		return new Promise((resolve, reject) => {
			const finish = (error, value) => {
				clearTimeout(timer);
				events.off("change", inspect);
				if (error) reject(error);
				else resolve(value);
			};
			const inspect = () => {
				const value = check();
				if (value) finish(undefined, value);
				else if (exit) finish(new Error(`${label}: exited ${JSON.stringify(exit)}; ${stderr}`));
			};
			const timer = setTimeout(
				() => finish(new Error(`${label} deadline; ${stderr}; frames=${JSON.stringify(frames.slice(-3))}`)),
				timeout,
			);
			events.on("change", inspect);
			inspect();
		});
	}
	return {
		child,
		frames,
		messages,
		outcome,
		settlement,
		send: (message) => child.send(message),
		stderr: () => stderr,
		exit: () => exit,
		waitFor,
	};
}

test("RPC reports retained input dispositions and one rejection without starting a model request", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-rpc-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const commands = [
		{ id: "held", type: "prompt", message: "retain" },
		{ id: "rejected", type: "prompt", message: "reject" },
		{ id: "steer", type: "steer", message: "retain" },
		{ id: "follow", type: "follow_up", message: "retain" },
		{ id: "history", type: "get_messages" },
	];
	const probe = `
		const { main } = await import(${JSON.stringify(pi)});
		await main(["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"], {
			flowIngressFactory: async () => ({
				version: 1,
				submit(input) { if (input.args[0] === "reject") throw new Error("fixture rejection"); }
			})
		});
	`;
	const child = spawn(process.execPath, ["--input-type=module", "--eval", probe], {
		cwd: root,
		env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	t.after(() => {
		if (child.exitCode === null) child.kill("SIGKILL");
	});
	const frames = [];
	let stderr = "";
	let buffer = "";
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	child.stdout.on("data", (data) => {
		buffer += data;
		while (buffer.includes("\n")) {
			const newline = buffer.indexOf("\n");
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (!line.trim()) continue;
			try {
				frames.push(JSON.parse(line));
			} catch {
				stderr += `\nUnexpected stdout: ${line}`;
				child.kill("SIGKILL");
			}
		}
		if (commands.every((command) => frames.some((frame) => frame.type === "response" && frame.id === command.id)))
			child.stdin.end();
	});
	const closed = new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`RPC deadline exceeded: ${stderr}`));
		}, 15000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
	child.stdin.on("error", () => {});
	child.stdin.write(`${commands.map((command) => JSON.stringify(command)).join("\n")}\n`);
	const status = await closed;
	assert.equal(status.signal, null, stderr);
	assert.equal(status.code, 0, stderr);
	for (const command of commands) {
		const replies = frames.filter((frame) => frame.type === "response" && frame.id === command.id);
		assert.equal(replies.length, 1, `${command.id}: ${JSON.stringify(frames)}`);
		if (command.id === "rejected") {
			assert.equal(replies[0].success, false);
			assert.match(replies[0].error, /fixture rejection/);
		} else if (command.id === "history") {
			assert.deepEqual(replies[0].data.messages, []);
		} else {
			assert.equal(replies[0].success, true);
			assert.equal(replies[0].data.disposition, "handled");
		}
	}
	assert.equal(
		frames.some((frame) => frame.type === "agent_start"),
		false,
	);
});

test("RPC end of input cancels an unanswered dialog and does not wait on later dialogs", async (t) => {
	const f = await rpcFixture(
		t,
		({ outcome }) => `
import { writeFileSync } from 'node:fs';
export default function (pi) {
	pi.registerCommand('fixture-dialog', {
		handler: async (args, ctx) => {
			// No timeout: only end-of-input can release these dialogs.
			const confirmed = await ctx.ui.confirm('fixture', 'proceed?');
			const selected = await ctx.ui.select('fixture', ['a', 'b']);
			const edited = await ctx.ui.editor('fixture', 'prefill');
			writeFileSync(${JSON.stringify(outcome)}, JSON.stringify({ confirmed, selected: selected ?? null, edited: edited ?? null, completed: true }));
		}
	});
}
`,
	);
	f.child.stdin.write(`${JSON.stringify({ id: "dialog", type: "prompt", message: "/fixture-dialog" })}\n`);
	await f.waitFor(
		() => f.frames.find((frame) => frame.type === "extension_ui_request" && frame.method === "confirm"),
		"confirm request",
		10000,
	);
	const answered = f.frames.length;
	const startedAt = Date.now();
	f.child.stdin.end();
	const exit = await f.waitFor(() => f.exit(), "EOF exit", 10000);
	const elapsed = Date.now() - startedAt;
	assert.deepEqual(exit, { code: 0, signal: null }, f.stderr());
	assert.ok(elapsed < 10000, `EOF exit took ${elapsed}ms`);
	assert.deepEqual(JSON.parse(await readFile(f.outcome, "utf8")), {
		confirmed: false,
		selected: null,
		edited: null,
		completed: true,
	});
	const responses = f.frames.filter((frame) => frame.type === "response" && frame.id === "dialog");
	assert.equal(responses.length, 1, JSON.stringify(f.frames));
	assert.equal(responses[0].success, true);
	assert.equal(responses[0].data.disposition, "handled");
	assert.deepEqual(
		f.frames.slice(answered).filter((frame) => ["select", "input", "editor", "confirm"].includes(frame.method)),
		[],
		"a closed input channel must not emit dialogs it can never receive an answer for",
	);
});

test("RPC end of input reports an accepted command that never settles and exits with failure", async (t) => {
	const f = await rpcFixture(
		t,
		`
export default function (pi) {
	pi.registerCommand('fixture-stall', {
		handler: async (args, ctx) => {
			ctx.ui.notify('fixture stall started');
			await new Promise(() => { });
		}
	});
}
`,
	);
	f.child.stdin.write(`${JSON.stringify({ id: "stall", type: "prompt", message: "/fixture-stall" })}\n`);
	await f.waitFor(
		() => f.frames.find((frame) => frame.type === "extension_ui_request" && frame.method === "notify"),
		"stall notify",
		10000,
	);
	const startedAt = Date.now();
	f.child.stdin.end();
	const exit = await f.waitFor(() => f.exit(), "bounded EOF exit", 15000);
	const elapsed = Date.now() - startedAt;
	assert.equal(exit.signal, null, f.stderr());
	assert.equal(exit.code, 1, f.stderr());
	assert.ok(elapsed >= 4000, `the drain bound applies before failure: ${elapsed}ms`);
	const responses = f.frames.filter((frame) => frame.type === "response" && frame.id === "stall");
	assert.equal(responses.length, 1, JSON.stringify(f.frames));
	assert.equal(responses[0].success, false);
	assert.match(responses[0].error, /accepted command did not settle within 5000ms/u);
	assert.equal(
		f.frames.some((frame) => frame.type === "agent_start"),
		false,
	);
});

test("RPC end of input resolves a pending editor and does not wait on later dialogs", async (t) => {
	const f = await rpcFixture(
		t,
		({ outcome }) => `
import { writeFileSync } from 'node:fs';
export default function (pi) {
	pi.registerCommand('fixture-editor', {
		handler: async (args, ctx) => {
			// No timeout: only end-of-input can release the first editor, and the second must not
			// wait on a channel that is already closed.
			const edited = await ctx.ui.editor('fixture', 'prefill');
			const again = await ctx.ui.editor('fixture', 'later');
			writeFileSync(${JSON.stringify(outcome)}, JSON.stringify({ edited: edited ?? null, again: again ?? null, completed: true }));
		}
	});
}
`,
	);
	f.child.stdin.write(`${JSON.stringify({ id: "editor", type: "prompt", message: "/fixture-editor" })}\n`);
	await f.waitFor(
		() => f.frames.find((frame) => frame.type === "extension_ui_request" && frame.method === "editor"),
		"editor request",
		10000,
	);
	const answered = f.frames.length;
	f.child.stdin.end();
	const exit = await f.waitFor(() => f.exit(), "EOF exit", 10000);
	assert.deepEqual(exit, { code: 0, signal: null }, f.stderr());
	assert.deepEqual(JSON.parse(await readFile(f.outcome, "utf8")), { edited: null, again: null, completed: true });
	const responses = f.frames.filter((frame) => frame.type === "response" && frame.id === "editor");
	assert.equal(responses.length, 1, JSON.stringify(f.frames));
	assert.equal(responses[0].success, true);
	assert.equal(responses[0].data.disposition, "handled");
	assert.deepEqual(
		f.frames.slice(answered).filter((frame) => ["select", "input", "editor", "confirm"].includes(frame.method)),
		[],
		"a closed input channel must not emit dialogs it can never receive an answer for",
	);
});

test("RPC end of input suppresses a command response that settles during shutdown", async (t) => {
	const f = await rpcFixture(t, "export default function () {}", {
		// Admission parks the steer until shutdown disposes the attachment. Disposal then waits for
		// that admission to settle, so the late response cannot depend on a scheduling guess.
		flowIngress: ({ settlement }) => `async () => {
			const { writeFileSync } = await import("node:fs");
			let release;
			let settled;
			const settledLater = new Promise((resolve) => { settled = resolve; });
			const parked = new Promise((resolve) => { release = resolve; });
			return {
				version: 1,
				submit(input, dispatch) {
					if (input.args[0] !== "parked") return dispatch();
					process.send({ type: "parked" });
					return parked.then(() => dispatch()).then(
						(value) => { settled(); return value; },
						(error) => {
							const message = error instanceof Error ? error.message : String(error);
							writeFileSync(${JSON.stringify(settlement)}, JSON.stringify({ message }));
							settled();
							throw error;
						}
					);
				},
				async dispose() {
					release();
					await settledLater;
					// One event-loop turn after the settlement lets its response continuation run
					// before disposal returns, so the late output races nothing.
					await new Promise((resolve) => setImmediate(resolve));
				}
			};
		}`,
	});
	f.child.stdin.write(`${JSON.stringify({ id: "parked", type: "steer", message: "parked" })}\n`);
	await f.waitFor(() => f.messages.find((message) => message.type === "parked"), "parked admission", 10000);
	f.child.stdin.end();
	const exit = await f.waitFor(() => f.exit(), "bounded EOF exit", 15000);
	assert.equal(exit.signal, null, f.stderr());
	assert.equal(exit.code, 1, f.stderr());
	const settled = JSON.parse(await readFile(f.settlement, "utf8"));
	assert.match(settled.message, /Flow attachment is closed/u);
	const responses = f.frames.filter((frame) => frame.type === "response" && frame.id === "parked");
	assert.equal(responses.length, 1, JSON.stringify(f.frames));
	assert.equal(responses[0].success, false);
	assert.match(responses[0].error, /accepted command did not settle within 5000ms/u);
});

test("RPC end of input does not fail a command whose response is waiting on stdout backpressure", async (t) => {
	// Installed before the runtime takes over stdout, so the guard's raw write is the one held. The
	// held callback is the real flush of one response frame: it is released over IPC only after the
	// production five-second allowance has elapsed, and stdin end is observed while it is still held.
	const holdResponseWrite = `
		const writeStdout = process.stdout.write.bind(process.stdout);
		let armed = true;
		let heldWrite;
		process.stdout.write = (chunk, encodingOrCallback, callback) => {
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			const text = String(chunk);
			if (armed && text.includes('"id":"held-response"')) {
				armed = false;
				heldWrite = () => writeStdout(text, (error) => done(error));
				process.send({ type: "blocked" });
				return true;
			}
			return writeStdout(chunk, encodingOrCallback, callback);
		};
		process.stdin.once("end", () => process.send({ type: "stdin-end" }));
		process.on("message", (message) => {
			if (message?.type !== "release" || heldWrite === undefined) return;
			const write = heldWrite;
			heldWrite = undefined;
			write();
		});
	`;
	const f = await rpcFixture(t, "export default function () {}", { preMain: holdResponseWrite });
	f.child.stdin.write(`${JSON.stringify({ id: "held-response", type: "get_messages" })}\n`);
	await f.waitFor(() => f.messages.find((message) => message.type === "blocked"), "blocked response write", 10000);
	f.child.stdin.end();
	await f.waitFor(() => f.messages.find((message) => message.type === "stdin-end"), "stdin end", 10000);
	const endedAt = Date.now();
	// This wait spans the contractual allowance only; the response is already written and held.
	await new Promise((resolve) => setTimeout(resolve, 5500));
	assert.ok(Date.now() - endedAt >= 5000, "the release follows the five-second allowance");
	f.send({ type: "release" });
	const exit = await f.waitFor(() => f.exit(), "bounded EOF exit", 15000);
	assert.deepEqual(exit, { code: 0, signal: null }, f.stderr());
	const responses = f.frames.filter((frame) => frame.type === "response" && frame.id === "held-response");
	assert.equal(responses.length, 1, JSON.stringify(f.frames.map((frame) => [frame.type, frame.id, frame.success])));
	assert.equal(responses[0].success, true);
	assert.deepEqual(responses[0].data.messages, []);
});

test("RPC shutdown failures are reported once without an unhandled rejection", async (t) => {
	const f = await rpcFixture(t, "export default function () {}", {
		flowIngress: `async () => ({
			version: 1,
			submit(input, dispatch) { return dispatch(); },
			async dispose() { throw new Error("fixture dispose failure"); }
		})`,
	});
	f.child.stdin.write(`${JSON.stringify({ id: "history", type: "get_messages" })}\n`);
	await f.waitFor(
		() => f.frames.find((frame) => frame.type === "response" && frame.id === "history"),
		"history response",
		10000,
	);
	f.child.stdin.end();
	const exit = await f.waitFor(() => f.exit(), "EOF exit", 10000);
	assert.equal(exit.signal, null, f.stderr());
	assert.equal(exit.code, 1, f.stderr());
	const diagnostics = f.frames.filter((frame) => frame.type === "response" && frame.command === "shutdown");
	assert.equal(diagnostics.length, 1, JSON.stringify(f.frames));
	assert.equal(diagnostics[0].success, false);
	assert.match(diagnostics[0].error, /fixture dispose failure/u);
	const history = f.frames.filter((frame) => frame.type === "response" && frame.id === "history");
	assert.equal(history.length, 1, JSON.stringify(f.frames));
	assert.equal(history[0].success, true);
});

test("RPC end of input drains a final command that has no trailing newline", async (t) => {
	const f = await rpcFixture(
		t,
		({ outcome }) => `
import { writeFileSync } from "node:fs";
export default function (pi) {
	pi.registerCommand("fixture-late", {
		handler: async (args, ctx) => {
			process.send({ type: "command-entered" });
			await new Promise((resolve) => {
				const onMessage = (message) => {
					if (message?.type !== "release-command") return;
					process.off("message", onMessage);
					resolve();
				};
				process.on("message", onMessage);
			});
			writeFileSync(${JSON.stringify(outcome)}, JSON.stringify({ completed: true }));
		}
	});
}
`,
		{
			// The reader's end flush is what delivers a final line without a trailing newline.
			preMain: `process.stdin.once("end", () => process.send({ type: "stdin-end" }));`,
		},
	);
	f.child.stdin.write(JSON.stringify({ id: "late", type: "prompt", message: "/fixture-late" }));
	f.child.stdin.end();
	await f.waitFor(() => f.messages.find((message) => message.type === "stdin-end"), "stdin end", 10000);
	// Whichever comes first: the command entered from the reader's final flush, or an early exit.
	await f.waitFor(
		() => f.exit() ?? f.messages.find((message) => message.type === "command-entered"),
		"command entered",
		10000,
	);
	if (f.child.connected) f.send({ type: "release-command" });
	const exit = await f.waitFor(() => f.exit(), "EOF exit", 15000);
	assert.deepEqual(exit, { code: 0, signal: null }, f.stderr());
	assert.deepEqual(JSON.parse(await readFile(f.outcome, "utf8")), { completed: true });
	const responses = f.frames.filter((frame) => frame.type === "response" && frame.id === "late");
	assert.equal(responses.length, 1, JSON.stringify(f.frames));
	assert.equal(responses[0].success, true);
	assert.equal(responses[0].data.disposition, "handled");
});

test("RPC reports one shutdown diagnostic when extension shutdown fails after a command response", async (t) => {
	const f = await rpcFixture(
		t,
		`
export default function (pi) {
	pi.registerCommand("fixture-quit", {
		handler: async (args, ctx) => {
			ctx.shutdown();
		}
	});
}
`,
		{
			flowIngress: `async () => ({
				version: 1,
				submit(input, dispatch) { return dispatch(); },
				async dispose() { throw new Error("fixture shutdown failure"); }
			})`,
		},
	);
	f.child.stdin.write(`${JSON.stringify({ id: "quit", type: "prompt", message: "/fixture-quit" })}\n`);
	await f.waitFor(
		() => f.frames.find((frame) => frame.type === "response" && frame.id === "quit"),
		"command response",
		10000,
	);
	f.child.stdin.end();
	const exit = await f.waitFor(() => f.exit(), "bounded shutdown exit", 15000);
	assert.equal(exit.signal, null, f.stderr());
	assert.equal(exit.code, 1, f.stderr());
	const responses = f.frames.filter((frame) => frame.type === "response" && frame.id === "quit");
	assert.equal(responses.length, 1, JSON.stringify(f.frames));
	assert.equal(responses[0].success, true);
	const diagnostics = f.frames.filter((frame) => frame.type === "response" && frame.command === "shutdown");
	assert.equal(diagnostics.length, 1, JSON.stringify(f.frames));
	assert.match(diagnostics[0].error, /fixture shutdown failure/u);
});

test("RPC keeps a failing end-of-input status when a late continuation requests shutdown", async (t) => {
	// A reported command's continuation stays held on a real stdout write, so it reaches the
	// shutdown check only after end-of-input has already failed another command.
	const holdResponseWrite = `
		const writeStdout = process.stdout.write.bind(process.stdout);
		let armed = true;
		let heldWrite;
		process.stdout.write = (chunk, encodingOrCallback, callback) => {
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			const text = String(chunk);
			if (armed && text.includes('"id":"held-response"')) {
				armed = false;
				heldWrite = () => writeStdout(text, (error) => {
					done(error);
					process.send({ type: "write-released" });
				});
				process.send({ type: "blocked" });
				return true;
			}
			return writeStdout(chunk, encodingOrCallback, callback);
		};
		process.on("message", (message) => {
			if (message?.type !== "release-write" || heldWrite === undefined) return;
			const write = heldWrite;
			heldWrite = undefined;
			write();
		});
	`;
	const f = await rpcFixture(
		t,
		`
export default function (pi) {
	// The extension records a shutdown request while end-of-input is disposing, so the held
	// continuation finds a request it did not make and must not downgrade the failing status.
	pi.on("session_shutdown", (event, ctx) => {
		ctx.shutdown();
	});
}
`,
		{
			preMain: holdResponseWrite,
			flowIngress: `async () => ({
				version: 1,
				submit(input, dispatch) {
					if (input.args[0] !== "parked") return dispatch();
					process.send({ type: "parked" });
					return new Promise(() => { });
				},
				async dispose() {
					process.send({ type: "disposing" });
					await new Promise((resolve) => {
						const onMessage = (message) => {
							if (message?.type !== "release-dispose") return;
							process.off("message", onMessage);
							resolve();
						};
						process.on("message", onMessage);
					});
					process.send({ type: "disposed" });
				}
			})`,
		},
	);
	f.child.stdin.write(`${JSON.stringify({ id: "held-response", type: "get_messages" })}\n`);
	await f.waitFor(() => f.messages.find((message) => message.type === "blocked"), "blocked response write", 10000);
	f.child.stdin.write(`${JSON.stringify({ id: "parked", type: "steer", message: "parked" })}\n`);
	await f.waitFor(() => f.messages.find((message) => message.type === "parked"), "parked admission", 10000);
	f.child.stdin.end();
	// End-of-input fails the unreported steer and enters shutdown with a failing status.
	await f.waitFor(() => f.messages.find((message) => message.type === "disposing"), "held disposal", 15000);
	f.send({ type: "release-write" });
	// Whichever comes first: the continuation resumes, or the process already exited early.
	await f.waitFor(
		() => f.exit() ?? f.messages.find((message) => message.type === "write-released"),
		"held continuation",
		10000,
	);
	if (f.child.connected) f.send({ type: "release-dispose" });
	const exit = await f.waitFor(() => f.exit(), "bounded EOF exit", 15000);
	assert.equal(exit.signal, null, f.stderr());
	assert.equal(exit.code, 1, f.stderr());
	const parked = f.frames.filter((frame) => frame.type === "response" && frame.id === "parked");
	assert.equal(parked.length, 1, JSON.stringify(f.frames));
	assert.equal(parked[0].success, false);
	assert.match(parked[0].error, /accepted command did not settle within 5000ms/u);
	const held = f.frames.filter((frame) => frame.type === "response" && frame.id === "held-response");
	assert.equal(held.length, 1, JSON.stringify(f.frames));
	assert.equal(held[0].success, true);
	// Disposal must release on the matching message, not on the cleanup allowance.
	assert.ok(
		f.messages.some((message) => message.type === "disposed"),
		`disposal releases: ${JSON.stringify(f.messages)}`,
	);
	assert.equal(
		f.frames.filter((frame) => frame.type === "response" && frame.command === "shutdown").length,
		0,
		JSON.stringify(f.frames),
	);
});

test("RPC flushes one shutdown diagnostic when disposal rejects while it is held", async (t) => {
	// The cleanup allowance expires and its diagnostic write is held while flushing, then the
	// pending disposal rejects. A second failure report must join the first flush, not exit early.
	const holdDiagnosticWrite = `
		const writeStdout = process.stdout.write.bind(process.stdout);
		let armed = true;
		let heldWrite;
		process.stdout.write = (chunk, encodingOrCallback, callback) => {
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			const text = String(chunk);
			if (armed && text.includes('"command":"shutdown"')) {
				armed = false;
				heldWrite = () => writeStdout(text, (error) => done(error));
				process.send({ type: "diagnostic-blocked" });
				return true;
			}
			return writeStdout(chunk, encodingOrCallback, callback);
		};
		process.on("message", (message) => {
			if (message?.type !== "release-diagnostic" || heldWrite === undefined) return;
			const write = heldWrite;
			heldWrite = undefined;
			write();
		});
	`;
	const f = await rpcFixture(t, "export default function () {}", {
		preMain: holdDiagnosticWrite,
		flowIngress: `async () => ({
			version: 1,
			submit(input, dispatch) {
				if (input.args[0] !== "parked") return dispatch();
				process.send({ type: "parked" });
				return new Promise(() => { });
			},
			async dispose() {
				process.send({ type: "disposing" });
				await new Promise((resolve) => {
					const onMessage = (message) => {
						if (message?.type !== "release-dispose") return;
						process.off("message", onMessage);
						resolve();
					};
					process.on("message", onMessage);
				});
				process.send({ type: "disposal-rejected" });
				throw new Error("late disposal failure");
			}
		})`,
	});
	f.child.stdin.write(`${JSON.stringify({ id: "parked", type: "steer", message: "parked" })}\n`);
	await f.waitFor(() => f.messages.find((message) => message.type === "parked"), "parked admission", 10000);
	f.child.stdin.end();
	await f.waitFor(() => f.messages.find((message) => message.type === "disposing"), "held disposal", 15000);
	await f.waitFor(() => f.messages.find((message) => message.type === "diagnostic-blocked"), "held diagnostic", 15000);
	f.send({ type: "release-dispose" });
	// Whichever comes first: the late disposal rejection, or the early exit it used to cause.
	await f.waitFor(
		() => f.exit() ?? f.messages.find((message) => message.type === "disposal-rejected"),
		"late disposal rejection",
		10000,
	);
	if (f.child.connected) f.send({ type: "release-diagnostic" });
	const exit = await f.waitFor(() => f.exit(), "bounded cleanup exit", 15000);
	assert.equal(exit.signal, null, f.stderr());
	assert.equal(exit.code, 1, f.stderr());
	const parked = f.frames.filter((frame) => frame.type === "response" && frame.id === "parked");
	assert.equal(parked.length, 1, JSON.stringify(f.frames));
	assert.match(parked[0].error, /accepted command did not settle within 5000ms/u);
	const diagnostics = f.frames.filter((frame) => frame.type === "response" && frame.command === "shutdown");
	assert.equal(diagnostics.length, 1, JSON.stringify(f.frames));
	assert.match(diagnostics[0].error, /end-of-input cleanup did not complete within 5000ms/u);
});

test("RPC reports one shutdown diagnostic when a signal shutdown fails", {
	skip: process.platform === "win32" && "POSIX signal delivery",
}, async (t) => {
	const f = await rpcFixture(t, "export default function () {}", {
		flowIngress: `async () => ({
				version: 1,
				submit(input, dispatch) { return dispatch(); },
				async dispose() { throw new Error("fixture signal shutdown failure"); }
			})`,
	});
	f.child.stdin.write(`${JSON.stringify({ id: "history", type: "get_messages" })}\n`);
	await f.waitFor(
		() => f.frames.find((frame) => frame.type === "response" && frame.id === "history"),
		"history response",
		10000,
	);
	f.child.kill("SIGTERM");
	const exit = await f.waitFor(() => f.exit(), "bounded signal exit", 15000);
	assert.equal(exit.signal, null, f.stderr());
	assert.equal(exit.code, 1, f.stderr());
	const diagnostics = f.frames.filter((frame) => frame.type === "response" && frame.command === "shutdown");
	assert.equal(diagnostics.length, 1, JSON.stringify(f.frames));
	assert.match(diagnostics[0].error, /fixture signal shutdown failure/u);
});

test("RPC reports a parse failure for JSON lines that are not command objects", async (t) => {
	const f = await rpcFixture(t);
	// Valid JSON that is not a command object must still get one terminal frame.
	f.child.stdin.write(`null\n5\n"x"\ntrue\n[]\n`);
	f.child.stdin.end();
	const exit = await f.waitFor(() => f.exit(), "EOF exit", 15000);
	assert.deepEqual(exit, { code: 0, signal: null }, f.stderr());
	const responses = f.frames.filter((frame) => frame.type === "response");
	assert.equal(responses.length, 5, JSON.stringify(f.frames));
	for (const frame of responses) {
		assert.equal(frame.command, "parse", JSON.stringify(frame));
		assert.equal(frame.success, false);
		assert.match(frame.error, /Command must be a JSON object/u);
	}
});

test("RPC keeps a prompt deferred during agent_settled in the end-of-input drain", async (t) => {
	const eventStream = import.meta.resolve("@earendil-works/pi-ai/utils/event-stream");
	const source = `
import { createAssistantMessageEventStream } from ${JSON.stringify(eventStream)};
export default function (pi) {
	pi.registerProvider("fixture", {
		baseUrl: "http://127.0.0.1:1",
		apiKey: "fixture-key",
		api: "openai-completions",
		models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
		streamSimple(model) {
			const message = { role: "assistant", content: [{ type: "text", text: "Done." }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
			});
			return stream;
		}
	});
	pi.on("agent_settled", async () => {
		process.send({ type: "agent-settled" });
		await new Promise((resolve) => {
			const onMessage = (message) => {
				if (message?.type !== "release-agent-settled") return;
				process.off("message", onMessage);
				resolve();
			};
			process.on("message", onMessage);
		});
	});
}
`;
	// Both the pass-through ingress and a session without flow control defer the same way.
	for (const flowOff of [false, true]) {
		const f = await rpcFixture(t, source, flowOff ? { flowOff: true } : {});
		f.child.stdin.write(
			`${JSON.stringify({ id: "model", type: "set_model", provider: "fixture", modelId: "fixture" })}\n`,
		);
		const model = await f.waitFor(() => f.frames.find((frame) => frame.id === "model"), "set model", 10000);
		assert.equal(model.success, true, JSON.stringify(model));
		f.child.stdin.write(`${JSON.stringify({ id: "first", type: "prompt", message: "hello" })}\n`);
		await f.waitFor(() => f.frames.find((frame) => frame.id === "first"), "first response", 10000);
		await f.waitFor(() => f.messages.find((message) => message.type === "agent-settled"), "held agent settled", 15000);
		// Native prompt defers a prompt received during agent_settled and returns before preflight,
		// so this command has no response yet when input ends.
		f.child.stdin.write(`${JSON.stringify({ id: "deferred", type: "prompt", message: "deferred" })}\n`);
		f.child.stdin.end();
		const exit = await f.waitFor(() => f.exit(), "bounded EOF exit", 20000);
		const deferred = f.frames.filter((frame) => frame.type === "response" && frame.id === "deferred");
		assert.equal(deferred.length, 1, `${flowOff ? "flow off" : "pass-through"}: ${JSON.stringify(f.frames)}`);
		assert.equal(deferred[0].success, false);
		assert.match(deferred[0].error, /accepted command did not settle within 5000ms/u);
		const first = f.frames.filter((frame) => frame.type === "response" && frame.id === "first");
		assert.equal(first.length, 1, JSON.stringify(f.frames));
		assert.equal(first[0].success, true);
		assert.equal(exit.signal, null, f.stderr());
		assert.equal(exit.code, 1, f.stderr());
	}
});

test("RPC keeps an ordinary shutdown from exiting before the end-of-input drain", async (t) => {
	const f = await rpcFixture(
		t,
		`
export default function (pi) {
	pi.registerCommand("fixture-quit", {
		handler: async (args, ctx) => {
			ctx.shutdown();
		}
	});
	pi.on("session_before_switch", async () => {
		process.send({ type: "before-switch-held" });
		await new Promise((resolve) => {
			const onMessage = (message) => {
				if (message?.type !== "release-before-switch") return;
				process.off("message", onMessage);
				resolve();
			};
			process.on("message", onMessage);
		});
	});
}
`,
	);
	// The accepted switch is held in session_before_switch, so it has no response yet.
	f.child.stdin.write(`${JSON.stringify({ id: "switch", type: "new_session" })}\n`);
	await f.waitFor(() => f.messages.find((message) => message.type === "before-switch-held"), "held switch", 10000);
	// The final line without a trailing newline asks for shutdown from its own continuation.
	f.child.stdin.write(JSON.stringify({ id: "quit", type: "prompt", message: "/fixture-quit" }));
	f.child.stdin.end();
	const exit = await f.waitFor(() => f.exit(), "bounded EOF exit", 20000);
	const switched = f.frames.filter((frame) => frame.type === "response" && frame.id === "switch");
	assert.equal(switched.length, 1, JSON.stringify(f.frames));
	assert.equal(switched[0].success, false);
	assert.match(switched[0].error, /accepted command did not settle within 5000ms/u);
	const quit = f.frames.filter((frame) => frame.type === "response" && frame.id === "quit");
	assert.equal(quit.length, 1, JSON.stringify(f.frames));
	assert.equal(quit[0].success, true);
	assert.equal(exit.signal, null, f.stderr());
	assert.equal(exit.code, 1, f.stderr());
});

test("RPC reports an accepted command before a disposal failure ends an end-of-input shutdown", async (t) => {
	const f = await rpcFixture(
		t,
		`
export default function (pi) {
	pi.registerCommand("fixture-quit", {
		handler: async (args, ctx) => {
			ctx.shutdown();
		}
	});
	pi.on("session_before_switch", async () => {
		process.send({ type: "before-switch-held" });
		await new Promise((resolve) => {
			const onMessage = (message) => {
				if (message?.type !== "release-before-switch") return;
				process.off("message", onMessage);
				resolve();
			};
			process.on("message", onMessage);
		});
	});
}
`,
		{
			flowIngress: `async () => ({
				version: 1,
				submit(input, dispatch) { return dispatch(); },
				dispose() { throw new Error("fixture dispose failure"); }
			})`,
		},
	);
	// The accepted switch is held in session_before_switch, so it has no response yet.
	f.child.stdin.write(`${JSON.stringify({ id: "switch", type: "new_session" })}\n`);
	await f.waitFor(() => f.messages.find((message) => message.type === "before-switch-held"), "held switch", 10000);
	// The final line without a trailing newline asks for shutdown, whose disposal then fails.
	f.child.stdin.write(JSON.stringify({ id: "quit", type: "prompt", message: "/fixture-quit" }));
	f.child.stdin.end();
	const exit = await f.waitFor(() => f.exit(), "bounded EOF exit", 20000);
	const switched = f.frames.filter((frame) => frame.type === "response" && frame.id === "switch");
	assert.equal(switched.length, 1, JSON.stringify(f.frames));
	assert.equal(switched[0].success, false);
	assert.match(switched[0].error, /accepted command did not settle within 5000ms/u);
	const quit = f.frames.filter((frame) => frame.type === "response" && frame.id === "quit");
	assert.equal(quit.length, 1, JSON.stringify(f.frames));
	assert.equal(quit[0].success, true);
	const diagnostics = f.frames.filter((frame) => frame.type === "response" && frame.command === "shutdown");
	assert.equal(diagnostics.length, 1, JSON.stringify(f.frames));
	assert.match(diagnostics[0].error, /fixture dispose failure/u);
	// The failure report waits for the drain, so the diagnostic follows the command failure it flushes.
	assert.ok(f.frames.indexOf(switched[0]) < f.frames.indexOf(diagnostics[0]), JSON.stringify(f.frames));
	assert.equal(exit.signal, null, f.stderr());
	assert.equal(exit.code, 1, f.stderr());
});
