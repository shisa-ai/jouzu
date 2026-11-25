import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InteractiveMode, initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { defaultCatalog } from "../dist/cli-messages.js";
import { PiFlowSessionRegistry } from "../dist/flow-control/pi-session-registry.js";
import { createSessionResume } from "../dist/flow-control/session-resume.js";
import { AgentSessionRuntime } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js";
import { SessionSelectorComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/session-selector.js";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "jouzu-resume-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const flow = join(root, "flow");
	const hooks = createSessionResume(flow, defaultCatalog());
	const sessions = join(root, "sessions");
	const target = SessionManager.create(root, sessions);
	target.appendMessage({ role: "user", content: [{ type: "text", text: "Saved prompt" }], timestamp: Date.now() });
	target.flush();
	const runtimeSession = (manager) => ({
		sessionFile: manager.getSessionFile(),
		sessionId: manager.getSessionId(),
		sessionManager: manager,
	});
	const current = runtimeSession(SessionManager.create(root, sessions));
	const services = { cwd: root, agentDir: root };
	const attempts = [];
	const registry = { current: undefined };
	t.after(async () => registry.current?.close());
	const runtime = new AgentSessionRuntime(current, services, async ({ sessionManager }) => {
		const id = sessionManager.getSessionId();
		attempts.push("create");
		assert.equal(hooks.inUseLabel(id), "In use", "ownership spans teardown and creation");
		registry.current = await PiFlowSessionRegistry.open(flow, id, sessionManager.getLeafId(), undefined, () =>
			hooks.take(id),
		);
		return { session: runtimeSession(sessionManager), services };
	});
	runtime.sessionResume = hooks;
	runtime.emitBeforeSwitch = async () => ({ cancelled: false });
	runtime.teardownCurrent = async () => attempts.push("teardown");
	return { flow, hooks, sessions, target, current, runtime, attempts };
}

for (const choice of ["Cancel", "Fork into a new session"]) {
	test(`/resume offers ${choice} before tearing down the current session`, async (t) => {
		const { flow, hooks, sessions, target, current, runtime, attempts } = fixture(t);
		const id = target.getSessionId();
		const path = target.getSessionFile();
		assert.equal(hooks.inUseLabel(id), undefined, "initial picker state can be stale at selection");
		const holder = await PiFlowSessionRegistry.open(flow, id, target.getLeafId());
		try {
			// Pi's normal read repairs an unterminated tail. A fork must never repair the active original.
			appendFileSync(path, '{"partial":');
			const original = readFileSync(path);
			const host = Object.create(InteractiveMode.prototype);
			host.runtimeHost = runtime;
			host.clearStatusIndicator = () => {};
			host.createProjectTrustContext = () => {};
			host.showStatus = () => {};
			host.handleFatalRuntimeError = (_prefix, error) => {
				throw error;
			};
			host.showExtensionSelector = async (title, options) => {
				assert.equal(title, "This session is in use");
				assert.deepEqual(options, ["Cancel", "Fork into a new session"]);
				assert.deepEqual(attempts, []);
				assert.equal(runtime.session, current);
				return choice;
			};
			assert.equal(hooks.inUseLabel(id), "In use");
			const result = await host.handleResumeSession(path);
			assert.deepEqual(readFileSync(path), original);
			assert.equal(hooks.inUseLabel(id), "In use", "the original owner is unaffected");
			if (choice === "Cancel") {
				assert.equal(result.cancelled, true);
				assert.equal(runtime.session, current);
				assert.deepEqual(attempts, []);
				assert.deepEqual(readdirSync(sessions), [target.getSessionFile().split(/[/\\]/u).at(-1)]);
			} else {
				assert.equal(result.cancelled, false);
				assert.deepEqual(attempts, ["teardown", "create"]);
				assert.notEqual(runtime.session.sessionId, id);
				assert.equal(hooks.inUseLabel(runtime.session.sessionId), "In use", "handoff keeps the lock");
				const [header, entry] = readFileSync(runtime.session.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
				assert.equal(header.parentSession, path);
				assert.equal(entry.message.content[0].text, "Saved prompt");
			}
		} finally {
			await holder.close();
		}
		assert.equal(hooks.inUseLabel(id), undefined, "a leftover lock file is not a live owner");
	});
}

test("a normal resume reserves ownership and releases it if setup fails before attachment", async (t) => {
	const { hooks, target, runtime, attempts } = fixture(t);
	const id = target.getSessionId();
	runtime.teardownCurrent = async () => {
		assert.equal(hooks.inUseLabel(id), "In use");
		throw new Error("test teardown failure");
	};
	await assert.rejects(runtime.switchSession(target.getSessionFile()), /test teardown failure/u);
	assert.equal(hooks.inUseLabel(id), undefined);
	runtime.teardownCurrent = async () => attempts.push("teardown");
	assert.deepEqual(await runtime.switchSession(target.getSessionFile()), { cancelled: false });
	assert.deepEqual(attempts, ["teardown", "create"]);
	assert.equal(runtime.session.sessionId, id);
	assert.equal(hooks.inUseLabel(id), "In use");
});

test("the picker only probes visible rows and leaves the in-use label readable at 48 columns", async (t) => {
	initTheme("dark");
	const { target } = fixture(t);
	const [session] = await SessionManager.list(target.getCwd(), target.getSessionDir());
	const sessions = Array.from({ length: 40 }, (_, index) => ({
		...session,
		id: String(index),
		path: join(target.getSessionDir(), `${index}.jsonl`),
		name: "日本語の題名".repeat(20),
	}));
	const checked = [];
	const load = async () => sessions;
	const selector = new SessionSelectorComponent(
		load,
		load,
		() => {},
		() => {},
		() => {},
		() => {},
		{
			inUseLabel(id) {
				checked.push(id);
				return id === "0" ? "使用中" : undefined;
			},
		},
	);
	const list = selector.getSessionList();
	list.setSessions(sessions, true);
	const lines = list.render(48);
	assert.ok(lines.every((line) => visibleWidth(line) <= 48));
	assert.match(stripTerminalSequences(lines.join("\n")), /\[使用中\]/u);
	assert.equal(checked.length, 10);
});
