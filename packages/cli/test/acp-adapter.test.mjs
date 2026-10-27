import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { runAcpServer } from "../dist/acp.js";
import { AcpSession } from "../dist/acp-session.js";
import { resolveCatalog } from "../dist/locale-catalog.js";

const fakeChild = fileURLToPath(new URL("./fixtures/acp-fake-child.mjs", import.meta.url));

function readLog(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function textFrom(updates) {
	return updates
		.filter((update) => update.sessionUpdate === "agent_message_chunk")
		.map((update) => update.content.text)
		.join("");
}

async function waitFor(predicate, message = "condition") {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const value = predicate();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${message}`);
}

async function rejectsWithDetail(promise, pattern) {
	await assert.rejects(promise, (error) => {
		assert.equal(error.code, -32603);
		assert.match(error.data?.details ?? "", pattern);
		return true;
	});
}

async function harness(t, options = {}) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-acp-adapter-"));
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "workspace");
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const logPath = join(root, "fake.log");
	const diagnostics = [];
	const sessionId = `fake-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const env = {
		...process.env,
		ACP_FAKE_LOG: logPath,
		ACP_FAKE_SESSION_ID: sessionId,
		...(options.env ?? {}),
	};
	const input = new PassThrough();
	const output = new PassThrough();
	const serverOutput = options.notificationDelayMs
		? new WritableStream({
				write(chunk) {
					if (!new TextDecoder().decode(chunk).includes('"method":"session/update"')) {
						output.write(chunk);
						return;
					}
					return new Promise((resolve) => {
						setTimeout(() => {
							output.write(chunk);
							resolve();
						}, options.notificationDelayMs);
					});
				},
			})
		: output;
	const serverPromise = runAcpServer({
		executable: options.executable ?? process.execPath,
		args: [fakeChild],
		sessionDir,
		version: "test-version",
		...(options.catalog ? { catalog: options.catalog } : {}),
		env,
		input,
		output: serverOutput,
		onDiagnostic: (message) => diagnostics.push(message),
		...(options.controlTimeoutMs ? { controlTimeoutMs: options.controlTimeoutMs } : {}),
		...(options.teardownTimeoutMs ? { teardownTimeoutMs: options.teardownTimeoutMs } : {}),
	});
	const updates = [];
	const permissionRequests = [];
	const app = client();
	app.onNotification("session/update", ({ params }) => {
		updates.push(params.update);
	});
	app.onRequest("session/request_permission", async ({ params }) => {
		permissionRequests.push(params);
		if (options.permissionResponse) return options.permissionResponse(params);
		return { outcome: { outcome: "selected", optionId: params.options[0].optionId } };
	});
	app.onRequest("elicitation/create", ({ params }) =>
		options.elicitationResponse
			? options.elicitationResponse(params)
			: {
					action: "accept",
					content: { value: params.message === "Edit text" ? "Edited text" : "typed value" },
				},
	);
	const connection = app.connect(ndJsonStream(Writable.toWeb(input), Readable.toWeb(output)));
	const request = (method, params) =>
		connection.agent.request(method, params, { cancellationSignal: AbortSignal.timeout(10_000) });
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		input.end();
		await serverPromise;
		connection.close();
	};
	t.after(async () => {
		await close().catch(() => {});
		await rm(root, { recursive: true, force: true });
	});
	const initialized = await request("initialize", {
		protocolVersion: PROTOCOL_VERSION,
		clientCapabilities: options.clientCapabilities ?? {
			elicitation: { form: {} },
			session: { notices: {} },
		},
	});
	return {
		root,
		sessionDir,
		cwd,
		logPath,
		env,
		diagnostics,
		updates,
		permissionRequests,
		request,
		connection,
		initialized,
		close,
	};
}

function writeLoadSession(h, id, messageCount = 1, cwd = h.cwd) {
	const timestamp = new Date().toISOString();
	const path = join(h.sessionDir, `${id}.jsonl`);
	const messages = Array.from({ length: messageCount }, (_, index) =>
		JSON.stringify({
			type: "message",
			id: `user-${index}`,
			parentId: index === 0 ? null : `user-${index - 1}`,
			timestamp,
			message: { role: "user", content: `Earlier question ${index + 1}`, timestamp: Date.now() },
		}),
	);
	writeFileSync(
		path,
		[JSON.stringify({ type: "session", version: 3, id, timestamp, cwd }), ...messages, ""].join("\n"),
	);
	return path;
}

async function directSession(t, options = {}) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-acp-session-"));
	const sessionDir = join(root, "sessions");
	const cwd = join(root, "workspace");
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const logPath = join(root, "fake.log");
	const diagnostics = [];
	const stopped = [];
	const sessionId = options.sessionId ?? `direct-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	let loadPath;
	if (options.load) {
		const timestamp = new Date().toISOString();
		loadPath = join(sessionDir, `${sessionId}.jsonl`);
		writeFileSync(
			loadPath,
			[
				JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd }),
				JSON.stringify({
					type: "message",
					id: "user-1",
					parentId: null,
					timestamp,
					message: { role: "user", content: "Earlier question", timestamp: Date.now() },
				}),
				"",
			].join("\n"),
		);
	}
	const session = await AcpSession.open({
		executable: process.execPath,
		baseArgs: [fakeChild],
		sessionDir,
		cwd,
		...(loadPath ? { loadPath, expectedId: sessionId } : {}),
		client: options.client ?? {
			notify: async () => {},
			request: async () => {
				throw new Error("Unexpected client request");
			},
		},
		clientCapabilities: {},
		env: {
			...process.env,
			ACP_FAKE_LOG: logPath,
			ACP_FAKE_SESSION_ID: sessionId,
			...(options.env ?? {}),
		},
		startupTimeoutMs: 5_000,
		controlTimeoutMs: 5_000,
		teardownTimeoutMs: 1_000,
		onDiagnostic: (message) => diagnostics.push(message),
		onChild: () => {},
		onChildStopped: (child) => stopped.push(child),
	});
	t.after(async () => {
		await session.close().catch(() => {});
		await rm(root, { recursive: true, force: true });
	});
	return { root, sessionDir, cwd, logPath, session, diagnostics, stopped };
}

test("ACP initializes and streams a fake RPC turn", async (t) => {
	const h = await harness(t);
	assert.equal(h.initialized.agentInfo.name, "jouzu");
	assert.equal(h.initialized.agentCapabilities.loadSession, true);
	assert.deepEqual(h.initialized.agentCapabilities.promptCapabilities, {
		image: true,
		embeddedContext: true,
	});
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	assert.ok(session.sessionId.startsWith("fake-"));
	const model = session.configOptions.find((option) => option.id === "model");
	assert.equal(model.currentValue, "fake/model-a");
	assert.deepEqual(
		model.options.map((option) => option.value),
		["fake/model-a", "fake/model-b"],
	);
	const result = await h.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "hello" }],
	});
	assert.equal(result.stopReason, "end_turn");
	assert.ok(
		h.updates.some((update) => update.sessionUpdate === "agent_thought_chunk" && update.content.text === "Thinking..."),
	);
	assert.equal(textFrom(h.updates), "Hello from fake");
	const log = readLog(h.logPath);
	assert.ok(log.some((entry) => entry.type === "start" && entry.sessionId === session.sessionId));
	assert.ok(log.some((entry) => entry.type === "command" && entry.command === "prompt"));
	await h.close();
	assert.ok(readLog(h.logPath).some((entry) => entry.type === "exit"));
});

test("ACP streams tool calls and tool results", async (t) => {
	const h = await harness(t);
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	await h.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "tool" }],
	});
	const call = h.updates.find((update) => update.sessionUpdate === "tool_call");
	assert.equal(call.toolCallId, "call-1");
	assert.equal(call.kind, "execute");
	assert.equal(call.status, "in_progress");
	const running = h.updates.find(
		(update) => update.sessionUpdate === "tool_call_update" && update.status === "in_progress",
	);
	assert.equal(running.content[0].content.text, "partial output");
	const done = h.updates.find((update) => update.sessionUpdate === "tool_call_update" && update.status === "completed");
	assert.equal(done.content[0].content.text, "tool output");
	assert.deepEqual(done.rawOutput, { exitCode: 0 });
});

test("ACP maps select, confirm, input, and editor interactions", async (t) => {
	const h = await harness(t);
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	async function prompt(text) {
		h.updates.length = 0;
		const result = await h.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text }],
		});
		assert.equal(result.stopReason, "end_turn");
		return textFrom(h.updates);
	}
	assert.equal(await prompt("permission-select"), "selected:Allow");
	assert.equal(await prompt("permission-confirm"), "confirmed:true");
	assert.equal(await prompt("permission-input"), "input:typed value");
	assert.equal(await prompt("permission-editor"), "editor:Edited text");
});

test("ACP renders Japanese model, reject, and form labels from the resolved catalog", async (t) => {
	const h = await harness(t, {
		catalog: resolveCatalog("ja").bundle,
		clientCapabilities: { session: { notices: {} } },
	});
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	const model = session.configOptions.find((option) => option.id === "model");
	assert.equal(model.name, "モデル");
	const confirmed = await h.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "permission-confirm" }],
	});
	assert.equal(confirmed.stopReason, "end_turn");
	assert.deepEqual(
		h.permissionRequests[0].options.map((option) => option.name),
		["Clear session?", "拒否"],
	);
	await h.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "unsupported-input" }],
	});
	const notice = await waitFor(
		() => h.updates.find((update) => update.sessionUpdate === "notice"),
		"the Japanese form notice",
	);
	assert.equal(
		notice.description,
		"この ACP ホストはフォーム入力に対応していないため、ダイアログをキャンセルしました。",
	);
});

test("ACP declines input when the client does not advertise elicitation", async (t) => {
	const h = await harness(t, { clientCapabilities: { session: { notices: {} } } });
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	const result = await h.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "unsupported-input" }],
	});
	assert.equal(result.stopReason, "end_turn");
	assert.equal(textFrom(h.updates), "input:cancelled");
	const notice = await waitFor(
		() => h.updates.find((update) => update.sessionUpdate === "notice"),
		"the elicitation notice",
	);
	assert.equal(notice.title, "Enter a value");
});

test("ACP cancels an active turn without waiting for agent_end", async (t) => {
	const h = await harness(t);
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	const prompt = h.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "hang" }],
	});
	await waitFor(() => h.updates.some((update) => update.content?.text === "waiting"), "the hang turn");
	await h.connection.agent.notify("session/cancel", { sessionId: session.sessionId });
	const result = await prompt;
	assert.equal(result.stopReason, "cancelled");
	assert.ok(readLog(h.logPath).some((entry) => entry.type === "abort"));
});

test("ACP reports a model error and remains usable", async (t) => {
	const h = await harness(t);
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	await assert.rejects(
		h.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "error" }],
		}),
		/provider failed/u,
	);
	const result = await h.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "hello" }],
	});
	assert.equal(result.stopReason, "end_turn");
});

test("ACP resolves a successful retry and rejects a failed retry", async (t) => {
	const h = await harness(t);
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	const recovered = await h.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "retry-success" }],
	});
	assert.equal(recovered.stopReason, "end_turn");
	assert.match(textFrom(h.updates), /recovered/u);
	h.updates.length = 0;
	await assert.rejects(
		h.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "retry-failed" }],
		}),
		/retry failed/u,
	);
	h.updates.length = 0;
	const afterFailure = await h.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "hello" }],
	});
	assert.equal(afterFailure.stopReason, "end_turn");
	assert.equal(textFrom(h.updates), "Hello from fake");
});

test("ACP reports a crashed child as a failed prompt", async (t) => {
	const h = await harness(t);
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	await assert.rejects(
		h.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "crash" }],
		}),
		/Pi RPC child exited/u,
	);
	assert.ok(readLog(h.logPath).some((entry) => entry.type === "crash"));
});

test("ACP refuses a new session when the child exits during model discovery", async (t) => {
	const h = await harness(t);
	h.env.ACP_FAKE_EXIT_ON_MODEL_LIST = "1";
	await rejectsWithDetail(h.request("session/new", { cwd: h.cwd, mcpServers: [] }), /exited/u);
	assert.ok(h.diagnostics.some((message) => message.includes("ACP model listing failed")));
	h.env.ACP_FAKE_EXIT_ON_MODEL_LIST = "0";
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	assert.ok(session.sessionId.startsWith("fake-"));
});

test("ACP changes the model through a config option", async (t) => {
	const h = await harness(t);
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	const updated = await h.request("session/set_config_option", {
		sessionId: session.sessionId,
		configId: "model",
		value: "fake/model-b",
	});
	const model = updated.configOptions.find((option) => option.id === "model");
	assert.equal(model.currentValue, "fake/model-b");
	h.updates.length = 0;
	await h.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "model" }],
	});
	assert.equal(textFrom(h.updates), "model:fake/model-b");
	await assert.rejects(
		h.request("session/set_config_option", {
			sessionId: session.sessionId,
			configId: "model",
			value: "fake/missing",
		}),
		/Unknown model/u,
	);
});

test("ACP lists and reloads a persisted session", async (t) => {
	const h = await harness(t);
	const timestamp = new Date().toISOString();
	const path = join(h.sessionDir, "load-session.jsonl");
	const messageTimestamp = Date.now();
	writeFileSync(
		path,
		[
			JSON.stringify({ type: "session", version: 3, id: "load-session", timestamp, cwd: h.cwd }),
			JSON.stringify({
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "Earlier question", timestamp: messageTimestamp },
			}),
			JSON.stringify({
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Previous answer" }],
					api: "fake",
					provider: "fake",
					model: "model-a",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: messageTimestamp + 1,
				},
			}),
			"",
		].join("\n"),
	);
	const listed = await h.request("session/list", { cwd: h.cwd });
	assert.equal(listed.sessions.length, 1);
	assert.equal(listed.sessions[0].sessionId, "load-session");
	assert.equal(listed.sessions[0].cwd, h.cwd);
	const loaded = await h.request("session/load", {
		sessionId: "load-session",
		cwd: h.cwd,
		mcpServers: [],
	});
	assert.equal(loaded.configOptions.find((option) => option.id === "model").currentValue, "fake/model-a");
	assert.match(JSON.stringify(h.updates), /Previous answer/u);
	const result = await h.request("session/prompt", {
		sessionId: "load-session",
		prompt: [{ type: "text", text: "hello" }],
	});
	assert.equal(result.stopReason, "end_turn");
	await h.request("session/close", { sessionId: "load-session" });
	await h.close();
	assert.ok(readLog(h.logPath).some((entry) => entry.type === "exit"));
});

test("ACP lists and loads a persisted session through a symlinked working directory", async (t) => {
	const h = await harness(t);
	const privateRoot = join(h.root, "private", "var");
	const varRoot = join(h.root, "var");
	const realCwd = join(privateRoot, "workspace");
	const aliasCwd = join(varRoot, "workspace");
	const otherCwd = join(privateRoot, "other");
	mkdirSync(realCwd, { recursive: true });
	mkdirSync(otherCwd, { recursive: true });
	// Reproduce the macOS /var -> /private/var symlink with an explicit alias.
	symlinkSync(privateRoot, varRoot, process.platform === "win32" ? "junction" : "dir");
	writeLoadSession(h, "load-symlink", 1, aliasCwd);
	writeLoadSession(h, "load-other", 1, otherCwd);

	const fromAlias = await h.request("session/list", { cwd: aliasCwd });
	assert.equal(fromAlias.sessions.length, 1);
	assert.equal(fromAlias.sessions[0].sessionId, "load-symlink");
	assert.equal(fromAlias.sessions[0].cwd, aliasCwd);

	const fromReal = await h.request("session/list", { cwd: realCwd });
	assert.equal(fromReal.sessions.length, 1);
	assert.equal(fromReal.sessions[0].sessionId, "load-symlink");
	assert.equal(fromReal.sessions[0].cwd, aliasCwd);

	const fromOther = await h.request("session/list", { cwd: otherCwd });
	assert.equal(fromOther.sessions.length, 1);
	assert.equal(fromOther.sessions[0].sessionId, "load-other");
	assert.equal(fromOther.sessions[0].cwd, otherCwd);

	const all = await h.request("session/list", {});
	assert.deepEqual(all.sessions.map((session) => session.sessionId).sort(), ["load-other", "load-symlink"]);

	const loaded = await h.request("session/load", {
		sessionId: "load-symlink",
		cwd: realCwd,
		mcpServers: [],
	});
	assert.equal(loaded.configOptions.find((option) => option.id === "model").currentValue, "fake/model-a");
	assert.match(JSON.stringify(h.updates), /Earlier question 1/u);
	await h.request("session/close", { sessionId: "load-symlink" });
});

test("ACP rejects a concurrent load of the same session", async (t) => {
	const h = await harness(t);
	writeLoadSession(h, "load-race");
	h.env.ACP_FAKE_GET_STATE_DELAY_MS = "150";
	const first = h.request("session/load", {
		sessionId: "load-race",
		cwd: h.cwd,
		mcpServers: [],
	});
	await waitFor(() => readLog(h.logPath).some((entry) => entry.type === "start"), "the first load child");
	await assert.rejects(
		h.request("session/load", {
			sessionId: "load-race",
			cwd: h.cwd,
			mcpServers: [],
		}),
		/already active or loading/u,
	);
	const loaded = await first;
	assert.equal(loaded.configOptions.find((option) => option.id === "model").currentValue, "fake/model-a");
	await h.request("session/close", { sessionId: "load-race" });
});

test("ACP retries a load after the child fails during the first attempt", async (t) => {
	const h = await harness(t);
	writeLoadSession(h, "load-retry");
	h.env.ACP_FAKE_FAIL_LOAD_ONCE = join(h.root, "fail-load-once");
	await rejectsWithDetail(
		h.request("session/load", {
			sessionId: "load-retry",
			cwd: h.cwd,
			mcpServers: [],
		}),
		/exited/u,
	);
	const loaded = await h.request("session/load", {
		sessionId: "load-retry",
		cwd: h.cwd,
		mcpServers: [],
	});
	assert.equal(loaded.configOptions.find((option) => option.id === "model").currentValue, "fake/model-a");
	await h.request("session/close", { sessionId: "load-retry" });
});

test("ACP drains handled prompt updates before reporting success", async (t) => {
	let notifications = 0;
	const h = await directSession(t, {
		client: {
			notify: async () => {
				notifications += 1;
				if (notifications === 1) return;
				await new Promise((resolve) => setTimeout(resolve, 80));
				throw new Error("handled notification failed");
			},
			request: async () => {
				throw new Error("Unexpected client request");
			},
		},
	});
	await assert.rejects(
		h.session.prompt({ prompt: [{ type: "text", text: "handled-delayed" }] }),
		/handled notification failed/u,
	);
	assert.ok(h.diagnostics.some((message) => message.includes("ACP session update failed")));
	await waitFor(() => readLog(h.logPath).some((entry) => entry.type === "exit"), "the stopped handled child");
});

test("ACP refuses a load whose child crashes during replay", async (t) => {
	const h = await harness(t, { notificationDelayMs: 60 });
	writeLoadSession(h, "load-crash");
	h.env.ACP_FAKE_EXIT_AFTER_GET_MESSAGES = "1";
	await assert.rejects(
		h.request("session/load", {
			sessionId: "load-crash",
			cwd: h.cwd,
			mcpServers: [],
		}),
		/exited/u,
	);
	assert.ok(readLog(h.logPath).some((entry) => entry.type === "crash" && entry.stage === "after-get-messages"));
	h.env.ACP_FAKE_EXIT_AFTER_GET_MESSAGES = "0";
	const loaded = await h.request("session/load", {
		sessionId: "load-crash",
		cwd: h.cwd,
		mcpServers: [],
	});
	assert.equal(loaded.configOptions.find((option) => option.id === "model").currentValue, "fake/model-a");
	await h.request("session/close", { sessionId: "load-crash" });
});

test("ACP refuses a load cancelled during replay", async (t) => {
	const h = await harness(t, { notificationDelayMs: 80 });
	writeLoadSession(h, "load-cancel", 3);
	const controller = new AbortController();
	const load = h.connection.agent.request(
		"session/load",
		{ sessionId: "load-cancel", cwd: h.cwd, mcpServers: [] },
		{ cancellationSignal: controller.signal },
	);
	await waitFor(
		() => h.updates.some((update) => update.sessionUpdate === "user_message_chunk"),
		"the first replay update",
	);
	controller.abort();
	await assert.rejects(load, /Request cancelled/u);
	const loaded = await h.request("session/load", {
		sessionId: "load-cancel",
		cwd: h.cwd,
		mcpServers: [],
	});
	assert.equal(loaded.configOptions.find((option) => option.id === "model").currentValue, "fake/model-a");
	await h.request("session/close", { sessionId: "load-cancel" });
});

test("ACP fails a streamed prompt when a notification write rejects", async (t) => {
	let notifications = 0;
	const h = await directSession(t, {
		client: {
			notify: async () => {
				notifications += 1;
				if (notifications >= 2) throw new Error("stream notification failed");
			},
			request: async () => {
				throw new Error("Unexpected client request");
			},
		},
	});
	await assert.rejects(h.session.prompt({ prompt: [{ type: "text", text: "hello" }] }), /stream notification failed/u);
	await assert.rejects(h.session.prompt({ prompt: [{ type: "text", text: "hello" }] }), /stream notification failed/u);
	assert.ok(h.diagnostics.some((message) => message.includes("ACP session update failed")));
	assert.ok(readLog(h.logPath).some((entry) => entry.type === "exit"));
});

test("ACP fails a replay when a notification write rejects", async (t) => {
	const h = await directSession(t, {
		load: true,
		client: {
			notify: async () => {
				throw new Error("replay notification failed");
			},
			request: async () => {
				throw new Error("Unexpected client request");
			},
		},
	});
	await assert.rejects(h.session.replay(), /replay notification failed/u);
	await assert.rejects(h.session.prompt({ prompt: [{ type: "text", text: "hello" }] }), /replay notification failed/u);
	assert.ok(h.diagnostics.some((message) => message.includes("ACP session update failed")));
	await waitFor(() => readLog(h.logPath).some((entry) => entry.type === "exit"), "the stopped replay child");
});

test("ACP EOF closes the server and all children", async (t) => {
	const h = await harness(t);
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	await h.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "hello" }],
	});
	await h.close();
	assert.ok(readLog(h.logPath).some((entry) => entry.type === "exit"));
});

test("ACP honors protocol cancellation of a prompt request", async (t) => {
	const h = await harness(t);
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	const controller = new AbortController();
	const prompt = h.connection.agent.request(
		"session/prompt",
		{ sessionId: session.sessionId, prompt: [{ type: "text", text: "hang" }] },
		{ cancellationSignal: controller.signal },
	);
	await waitFor(() => h.updates.some((update) => update.content?.text === "waiting"), "the hang turn");
	controller.abort();
	const result = await prompt;
	assert.equal(result.stopReason, "cancelled");
	assert.ok(readLog(h.logPath).some((entry) => entry.type === "abort"));
});

test("ACP quarantines a child after a prompt acknowledgment timeout", async (t) => {
	const h = await harness(t, { controlTimeoutMs: 50, teardownTimeoutMs: 100 });
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	await assert.rejects(
		h.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "slow-ack" }],
		}),
		/timed out/u,
	);
	await assert.rejects(
		h.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "hello" }],
		}),
		/timed out/u,
	);
});

test("ACP suspends the prompt acknowledgment timeout during a human dialog", async (t) => {
	const h = await harness(t, {
		controlTimeoutMs: 50,
		teardownTimeoutMs: 100,
		permissionResponse: async (params) => {
			await new Promise((resolve) => setTimeout(resolve, 150));
			return { outcome: { outcome: "selected", optionId: params.options[0].optionId } };
		},
		elicitationResponse: async () => {
			await new Promise((resolve) => setTimeout(resolve, 150));
			return { action: "accept", content: { value: "late value" } };
		},
	});
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	async function prompt(text) {
		h.updates.length = 0;
		const result = await h.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text }],
		});
		assert.equal(result.stopReason, "end_turn");
		return textFrom(h.updates);
	}
	assert.equal(await prompt("slow-dialog"), "dialog:Allow");
	assert.equal(await prompt("slow-dialog-input"), "dialog-input:late value");
});

test("ACP resumes a finite prompt acknowledgment timeout after a dialog", async (t) => {
	const h = await harness(t, { controlTimeoutMs: 50, teardownTimeoutMs: 100 });
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	await assert.rejects(
		h.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "dialog-then-hang" }],
		}),
		/timed out/u,
	);
});

test("ACP cancels a malformed elicitation acceptance", async (t) => {
	const h = await harness(t, {
		elicitationResponse: () => ({ action: "accept", content: {} }),
	});
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	const result = await h.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "permission-input" }],
	});
	assert.equal(result.stopReason, "end_turn");
	assert.equal(textFrom(h.updates), "input:cancelled");
	assert.ok(
		h.diagnostics.some((message) => message.includes("did not contain a string value")),
		JSON.stringify(h.diagnostics),
	);
});

test("ACP diagnoses unsupported elicitation when notices are unavailable", async (t) => {
	const h = await harness(t, { clientCapabilities: {} });
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	const result = await h.request("session/prompt", {
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "unsupported-input" }],
	});
	assert.equal(result.stopReason, "end_turn");
	assert.equal(textFrom(h.updates), "input:cancelled");
	assert.ok(h.diagnostics.some((message) => message.includes("does not support form input")));
});

test("ACP reports a crash before prompt acknowledgment", async (t) => {
	const h = await harness(t);
	const session = await h.request("session/new", { cwd: h.cwd, mcpServers: [] });
	await assert.rejects(
		h.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "crash-before-ack" }],
		}),
		/Pi RPC child exited/u,
	);
});

test("ACP reports a child spawn failure without waiting for teardown", { timeout: 5_000 }, async (t) => {
	const h = await harness(t, { executable: join(tmpdir(), "missing-jouzu-acp-child") });
	await assert.rejects(
		h.request("session/new", { cwd: h.cwd, mcpServers: [] }),
		/Internal error|ENOENT|spawn|child process error/u,
	);
});
