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
		["jouzu-multiloop-controller", "jouzu-background-controller", "jouzu-flow-waits", "jouzu-flow-status"],
	);
	for (const extension of flow.extensions) assert.equal(typeof extension.factory, "function");
});

test("the ingress is unavailable until the host creates a session", async (t) => {
	const { flow } = await runtime(t);
	assert.throws(() => flow.ingress(), { code: "stale" });
});

test("one runtime serves one session and releases it on dispose", async (t) => {
	const { flow, root } = await runtime(t);
	const sessionManager = SessionManager.inMemory(root);
	const ingress = await flow.flowIngressFactory({ cwd: root, sessionManager });
	assert.equal(flow.ingress(), ingress);
	await assert.rejects(flow.flowIngressFactory({ cwd: root, sessionManager }), { code: "identity" });
	await flow.dispose();
	assert.throws(() => flow.ingress(), { code: "stale" });
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
		maxPayloadBytes: 8 * 1024 * 1024,
		maxWaitDurationMs: 8 * 60 * 60 * 1000,
	});
	const { flow, root } = await runtime(t, { limits: { maxWaitDurationMs: 60_000 } });
	const ingress = await flow.flowIngressFactory({ cwd: root, sessionManager: SessionManager.inMemory(root) });
	assert.equal(ingress.version, 1);
	// Overrides must not mutate the shared default table.
	assert.equal(defaultFlowControlLimits.maxWaitDurationMs, 8 * 60 * 60 * 1000);
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
	assert.equal(requests[0].payload.api, "openai-completions");
	// The route guard accepted the builtin provider, so the source is observed in the final request.
	assert.ok(requests[0].payload.sources.some((source) => source.disposition === "included"));
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
