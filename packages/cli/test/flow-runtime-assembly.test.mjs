import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createFlowSession, createQualifiedFlowSession } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { createFlowControlRuntime, defaultFlowControlLimits } from "../dist/flow-control/flow-runtime.js";

async function runtime(t, overrides = {}) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-assembly-"));
	const errors = [];
	const flow = createFlowControlRuntime({ root, onError: (error) => errors.push(error), ...overrides });
	t.after(async () => {
		await flow.dispose();
		await rm(root, { recursive: true, force: true });
	});
	return { flow, root, errors };
}

test("the assembly registers the controller extensions the launcher passes to Pi", async (t) => {
	const { flow } = await runtime(t);
	assert.deepEqual(
		flow.extensions.map((extension) => extension.name),
		[
			"jouzu-task-controller",
			"jouzu-multiloop-controller",
			"jouzu-background-controller",
			"jouzu-subagent-waits",
			"jouzu-schedule-waits",
			"jouzu-subagent-observation",
			"jouzu-flow-waits",
			"jouzu-flow-no-reply",
			"jouzu-flow-status",
		],
	);
	for (const extension of flow.extensions) assert.equal(typeof extension.factory, "function");
});

test("the ingress is unavailable until the host creates a session", async (t) => {
	const { flow } = await runtime(t);
	assert.throws(() => flow.ingress(), { code: "stale" });
	assert.equal(await flow.dashboardStatus(), undefined);
});

test("one runtime serves one session at a time and releases it on dispose", async (t) => {
	const { flow, root } = await runtime(t);
	const sessionManager = SessionManager.inMemory(root);
	const ingress = await flow.flowIngressFactory({ cwd: root, sessionManager });
	assert.equal(flow.ingress(), ingress);
	await flow.dispose();
	assert.throws(() => flow.ingress(), { code: "stale" });
});

test("the runtime follows the host through a session replacement", async (t) => {
	// `/new`, resume, session switch, fork, and rewind all tear the current session down and build
	// a new runtime, which calls the factory again. Refusing that aborted every one of them: the
	// live symptom was `/new` ending the program. One ingress serves one session, so replace it.
	const { flow, root, errors } = await runtime(t);
	const first = await flow.flowIngressFactory({ cwd: root, sessionManager: SessionManager.inMemory(root) });
	const second = await flow.flowIngressFactory({ cwd: root, sessionManager: SessionManager.inMemory(root) });
	assert.notEqual(second, first);
	assert.equal(flow.ingress(), second, "the extensions' closure resolves to the session now in use");
	// The outgoing ingress is closed, so the replaced session holds no live admission or storage.
	assert.throws(() => first.releaseReady(), { code: "stale" });
	assert.deepEqual(errors, [], "an ordinary replacement reports nothing to the user");

	// A third replacement still works, and disposing the outgoing ingress twice is harmless: the
	// host may already have disposed it while tearing its session down.
	await second.dispose();
	const third = await flow.flowIngressFactory({ cwd: root, sessionManager: SessionManager.inMemory(root) });
	assert.notEqual(third, second);
	assert.equal(flow.ingress(), third);
	assert.deepEqual(errors, []);
});

test("a prompt through the assembled runtime is captured, admitted, and returned", async (t) => {
	const { flow, root, errors } = await runtime(t);
	const sessionManager = SessionManager.inMemory(root);
	const ingress = await flow.flowIngressFactory({ cwd: root, sessionManager });
	const { session } = await createFlowSession(t, {
		root,
		sessionManager,
		extensions: flow.extensions,
		ingress: {
			version: 1,
			attach: (target) => ingress.attach(target),
			submit: (...args) => ingress.submit(...args),
			beforeBranchChange: () => ingress.beforeBranchChange(),
			branchChanged: () => ingress.branchChanged(),
			dispose: () => ingress.dispose(),
		},
	});
	await session.prompt("first");
	// The task extension is absent in this fixture, so background waits report unavailable once.
	assert.deepEqual(
		errors.map((error) => error.code),
		["identity"],
	);
	const branch = ingress.branch();
	const submissions = await branch.attachment.submissions.snapshot();
	assert.equal(submissions.length, 1);
	assert.equal(submissions[0].status, "retained");
	assert.equal(submissions[0].dispatch.phase, "returned");
	assert.deepEqual(branch.attachment.waits.gate().waitingWorkIds, []);
	// The assembly enables qualifyProviderRoute, so the trusted stream captured at attach is used and
	// this fixture's substituted stream is correctly ignored. Proving a successful qualified provider
	// request end to end needs a builtin provider with mocked transport and remains an open gate.
	assert.deepEqual(await branch.attachment.nativeRequests.snapshot(), []);
});

test("limits use documented defaults and accept overrides", async (t) => {
	assert.deepEqual(defaultFlowControlLimits, {
		maxInputBytes: 32 * 1024,
		maxResultBytes: 16 * 1024,
		maxPayloadBytes: Number.MAX_SAFE_INTEGER,
		maxWaitDurationMs: 8 * 60 * 60 * 1000,
	});
	const { flow, root } = await runtime(t, { limits: { maxWaitDurationMs: 60_000 } });
	const ingress = await flow.flowIngressFactory({ cwd: root, sessionManager: SessionManager.inMemory(root) });
	assert.equal(ingress.version, 1);
	// Overrides must not mutate the shared default table.
	assert.equal(defaultFlowControlLimits.maxWaitDurationMs, 8 * 60 * 60 * 1000);
});

test("the default runtime admits image history above 8 MiB on repeated turns", async (t) => {
	const { flow, root } = await runtime(t);
	const sessionManager = SessionManager.inMemory(root);
	// Model transport is mocked; this tests encoded image bytes, not image decoding.
	const data = Buffer.alloc(7 * 1024 * 1024).toString("base64");
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "image", mimeType: "image/png", data }],
		timestamp: 1,
	});
	const ingress = await flow.flowIngressFactory({ cwd: root, sessionManager });
	const { session, bodies } = await createQualifiedFlowSession(t, {
		root,
		sessionManager,
		extensions: flow.extensions,
		ingress: {
			version: 1,
			attach: (target) => ingress.attach(target),
			submit: (...args) => ingress.submit(...args),
			beforeBranchChange: () => ingress.beforeBranchChange(),
			branchChanged: () => ingress.branchChanged(),
			dispose: () => ingress.dispose(),
		},
	});
	await session.prompt("Describe the image in history");
	await session.prompt("Continue with the same image");
	assert.equal(bodies.length, 2);
	for (const body of bodies) {
		assert.ok(Buffer.byteLength(JSON.stringify(body)) > 8 * 1024 * 1024);
		assert.ok(JSON.stringify(body).includes(`data:image/png;base64,${data}`));
	}
	const requests = await ingress.branch().attachment.nativeRequests.snapshot();
	assert.equal(requests.length, 2);
	for (const request of requests) {
		assert.equal(request.outcome, "success");
		assert.ok(request.payload.bytes > 8 * 1024 * 1024);
	}
});

test("a qualified provider route records an exact final-input receipt through the assembly", async (t) => {
	const { flow, root, errors } = await runtime(t);
	const sessionManager = SessionManager.inMemory(root);
	const ingress = await flow.flowIngressFactory({ cwd: root, sessionManager });
	const { session, bodies } = await createQualifiedFlowSession(t, {
		root,
		sessionManager,
		extensions: flow.extensions,
		ingress: {
			version: 1,
			attach: (target) => ingress.attach(target),
			submit: (...args) => ingress.submit(...args),
			beforeBranchChange: () => ingress.beforeBranchChange(),
			branchChanged: () => ingress.branchChanged(),
			dispose: () => ingress.dispose(),
		},
	});
	await session.prompt("qualified hello");
	assert.equal(bodies.length, 1);
	assert.ok(
		bodies[0].messages.some(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("qualified hello"),
		),
		"the transmitted payload carries the user instruction",
	);
	const branch = ingress.branch();
	const requests = await branch.attachment.nativeRequests.snapshot();
	assert.equal(requests.length, 1);
	assert.equal(requests[0].outcome, "success");
	const dashboard = await flow.dashboardStatus();
	assert.deepEqual(dashboard.scope, branch.scope);
	assert.deepEqual(dashboard.retryable, []);
	assert.deepEqual(dashboard.uncertain, []);
	assert.deepEqual(await branch.attachment.nativeRequests.snapshot(), requests, "dashboard reads create no receipt");
	assert.equal(requests[0].payload.api, "openai-completions");
	// The route guard accepted the builtin provider, so the source reached the adapter as composed.
	assert.ok(requests[0].sourceCapture.model.members.some((member) => ["intact", "converted"].includes(member.status)));
	assert.deepEqual(
		errors.map((error) => error.code),
		["identity"],
	);
});

test("reversed extension load order reaches the same assembled controller", async (t) => {
	const { flow, root } = await runtime(t);
	const sessionManager = SessionManager.inMemory(root);
	const ingress = await flow.flowIngressFactory({ cwd: root, sessionManager });
	const { session, bodies } = await createQualifiedFlowSession(t, {
		root,
		sessionManager,
		extensions: [...flow.extensions].reverse(),
		ingress: {
			version: 1,
			attach: (target) => ingress.attach(target),
			submit: (...args) => ingress.submit(...args),
			beforeBranchChange: () => ingress.beforeBranchChange(),
			branchChanged: () => ingress.branchChanged(),
			dispose: () => ingress.dispose(),
		},
	});
	await session.prompt("reversed order");
	assert.equal(bodies.length, 1);
	const requests = await ingress.branch().attachment.nativeRequests.snapshot();
	assert.equal(requests.length, 1);
	assert.equal(requests[0].outcome, "success");
});

test("two concurrent assemblies keep separate scopes and receipts", async (t) => {
	const first = await runtime(t);
	const second = await runtime(t);
	assert.notEqual(first.root, second.root);
	const sessions = [];
	for (const { flow, root } of [first, second]) {
		const sessionManager = SessionManager.inMemory(root);
		const ingress = await flow.flowIngressFactory({ cwd: root, sessionManager });
		const { session, bodies } = await createQualifiedFlowSession(t, {
			root,
			sessionManager,
			extensions: flow.extensions,
			ingress: {
				version: 1,
				attach: (target) => ingress.attach(target),
				submit: (...args) => ingress.submit(...args),
				beforeBranchChange: () => ingress.beforeBranchChange(),
				branchChanged: () => ingress.branchChanged(),
				dispose: () => ingress.dispose(),
			},
		});
		sessions.push({ session, ingress, bodies });
	}
	const [a, b] = sessions;
	assert.notEqual(a.session.sessionId, b.session.sessionId);
	await Promise.all([a.session.prompt("first session"), b.session.prompt("second session")]);
	for (const entry of sessions) {
		const branch = entry.ingress.branch();
		const requests = await branch.attachment.nativeRequests.snapshot();
		assert.equal(requests.length, 1);
		assert.equal(requests[0].outcome, "success");
		assert.equal(entry.bodies.length, 1);
		assert.equal(branch.scope.sessionId, entry.session.sessionId);
	}
	// Neither assembly observes the other's transmitted payload.
	assert.ok(JSON.stringify(a.bodies).includes("first session"));
	assert.ok(!JSON.stringify(a.bodies).includes("second session"));
	assert.ok(JSON.stringify(b.bodies).includes("second session"));
	assert.ok(!JSON.stringify(b.bodies).includes("first session"));
});

test("interactive startup pauses existing history before attachment and leaves fresh sessions ready", async (t) => {
	const { flow, root } = await runtime(t, { interactive: true });
	const fresh = SessionManager.inMemory(root);
	assert.equal((await flow.flowIngressFactory({ cwd: root, sessionManager: fresh })).automatedPause(), undefined);
	const restored = SessionManager.inMemory(root);
	restored.appendMessage({ role: "user", content: "Earlier request", timestamp: Date.now() });
	const ingress = await flow.flowIngressFactory({ cwd: root, sessionManager: restored });
	assert.equal(ingress.automatedPause(), "the session was reopened");
	const { session, bodies } = await createQualifiedFlowSession(t, {
		root,
		sessionManager: restored,
		extensions: flow.extensions,
		ingress: {
			version: 1,
			attach: (target) => ingress.attach(target),
			submit: (...args) => ingress.submit(...args),
			beforeBranchChange: () => ingress.beforeBranchChange(),
			branchChanged: () => ingress.branchChanged(),
			dispose: () => ingress.dispose(),
		},
	});
	assert.equal(bodies.length, 0);
	await session.prompt("Continue with my new instruction");
	assert.equal(ingress.automatedPause(), undefined);
	assert.equal(bodies.length, 1);
});

test("interactive resume explains the pause and its release controls", async (t) => {
	const { flow, root } = await runtime(t, { interactive: true });
	const manager = SessionManager.inMemory(root);
	manager.appendMessage({ role: "user", content: "Earlier request", timestamp: Date.now() });
	await flow.flowIngressFactory({ cwd: root, sessionManager: manager });
	const events = new Map();
	flow.extensions
		.find((extension) => extension.name === "jouzu-flow-status")
		.factory({
			registerMessageRenderer() {},
			registerCommand() {},
			on: (name, handler) => events.set(name, handler),
		});
	const notices = [];
	events.get("session_start")({}, { hasUI: true, ui: { notify: (text) => notices.push(text) } });
	assert.equal(notices.length, 1);
	assert.match(notices[0], /paused after reopening/);
	assert.match(notices[0], /\/flow resume or your next message/);
});
