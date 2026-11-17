import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowIngressBinding } from "../upstream/pi-content-policy/flow-ingress.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/**
 * A controlled session whose five wrapped send APIs report dispositions the way Pi does: prompt
 * reports through its success-only preflightResult callback, and steer/followUp resolve with a
 * queue disposition. This pins the ingress contract without the installed host patch, so the
 * ported semantics are checkable before the host transform is applied.
 */
function controlledSession({ disposition = "started", queueDisposition = "queued", failure, gate } = {}) {
	const calls = [];
	const queued = [];
	const session = {
		isStreaming: false,
		_pendingNextTurnMessages: [],
		sessionManager: { getSessionId: () => "session-1", getLeafId: () => "leaf-1" },
		agent: {
			inspectQueuedMessages: () => queued,
			hasQueuedMessages: () => queued.length > 0,
			flowCheckpoints: undefined,
		},
	};
	Object.assign(session, {
		async prompt(text, options) {
			calls.push({ api: "prompt", text, options });
			if (gate) await gate.promise;
			if (failure) throw failure;
			options?.preflightResult?.(disposition);
		},
		async steer(text) {
			calls.push({ api: "steer", text });
			if (gate) await gate.promise;
			if (failure) throw failure;
			queued.push(text);
			return queueDisposition;
		},
		async followUp(text) {
			calls.push({ api: "followUp", text });
			if (gate) await gate.promise;
			if (failure) throw failure;
			queued.push(text);
			return queueDisposition;
		},
		async sendCustomMessage(message) {
			calls.push({ api: "sendCustomMessage", message });
		},
		async sendUserMessage(content, options) {
			calls.push({ api: "sendUserMessage", content, options });
			// Pi normalizes the parts and forwards to prompt synchronously inside this call.
			const text = typeof content === "string" ? content : content.map((part) => part.text).join("\n");
			await session.prompt(text, {
				expandPromptTemplates: false,
				streamingBehavior: options?.deliverAs,
				source: "extension",
			});
		},
	});
	return { session, calls, queued };
}

function capture() {
	const entries = [];
	return {
		entries,
		handler: {
			version: 1,
			submit: (input, dispatch) => {
				entries.push({ input, dispatch });
			},
		},
	};
}

for (const disposition of ["started", "queued", "handled", "aborted"])
	test(`a dispatched prompt reports the native ${disposition} disposition exactly once`, async () => {
		for (const awaitDispatch of [false, true]) {
			const harness = controlledSession({ disposition });
			FlowIngressBinding.install(harness.session, {
				version: 1,
				submit: async (_input, dispatch) => (awaitDispatch ? await dispatch() : dispatch()),
			});
			const reported = [];
			assert.equal(
				await harness.session.prompt("immediate", { preflightResult: (value) => reported.push(value) }),
				undefined,
			);
			assert.deepEqual(reported, [disposition]);
			assert.equal(harness.calls.length, 1);
		}
	});

for (const later of ["started", "queued", "handled"])
	test(`a retained prompt reports handled once and a later ${later} dispatch cannot revise it`, async () => {
		const harness = controlledSession({ disposition: later });
		const captured = capture();
		FlowIngressBinding.install(harness.session, captured.handler);
		const reported = [];
		await harness.session.prompt("held", { preflightResult: (value) => reported.push(value) });
		assert.deepEqual(reported, ["handled"]);
		assert.equal(harness.calls.length, 0);
		assert.equal(await captured.entries[0].dispatch(), undefined);
		assert.deepEqual(reported, ["handled"]);
		assert.equal(harness.calls.length, 1);
		await assert.rejects(captured.entries[0].dispatch(), /already dispatched/);
	});

test("a rejected prompt reports no disposition and revokes its permit", async () => {
	const harness = controlledSession();
	const captured = capture();
	FlowIngressBinding.install(harness.session, {
		version: 1,
		submit: (input, dispatch) => {
			captured.entries.push({ input, dispatch });
			throw new Error("Controller unavailable");
		},
	});
	const reported = [];
	await assert.rejects(
		harness.session.prompt("held", { preflightResult: (value) => reported.push(value) }),
		/Controller unavailable/,
	);
	// Pi's preflight callback is success-only, so rejection never reaches it.
	assert.deepEqual(reported, []);
	assert.equal(harness.calls.length, 0);
	await assert.rejects(captured.entries[0].dispatch(), /rejected/);
	assert.equal(harness.calls.length, 0);
});

test("a handler failure after dispatch keeps the native disposition and rejects the send", async () => {
	const harness = controlledSession({ disposition: "started" });
	FlowIngressBinding.install(harness.session, {
		version: 1,
		submit: (_input, dispatch) => {
			dispatch();
			throw new Error("Handler failed after dispatch");
		},
	});
	const reported = [];
	await assert.rejects(
		harness.session.prompt("joined", { preflightResult: (value) => reported.push(value) }),
		/Handler failed after dispatch/,
	);
	assert.deepEqual(reported, ["started"]);
	assert.equal(harness.calls.length, 1);
});

test("a native dispatch failure rejects the send and fences the permit", async () => {
	const harness = controlledSession({ failure: new Error("native failed") });
	const captured = capture();
	FlowIngressBinding.install(harness.session, {
		version: 1,
		submit: (input, dispatch) => {
			captured.entries.push({ input, dispatch });
			dispatch();
		},
	});
	const reported = [];
	await assert.rejects(
		harness.session.prompt("failed", { preflightResult: (value) => reported.push(value) }),
		/native failed/,
	);
	assert.deepEqual(reported, []);
	await assert.rejects(captured.entries[0].dispatch(), /rejected/);
});

test("a prompt with an invalid preflight callback is refused before submission", async () => {
	const harness = controlledSession();
	const captured = capture();
	FlowIngressBinding.install(harness.session, captured.handler);
	await assert.rejects(harness.session.prompt("invalid", { preflightResult: true }), /must be a function/);
	assert.deepEqual(captured.entries, []);
	assert.equal(harness.calls.length, 0);
});

for (const api of ["steer", "followUp"])
	for (const disposition of ["queued", "handled"])
		test(`${api} returns the native ${disposition} disposition when dispatched`, async () => {
			for (const awaitDispatch of [false, true]) {
				const harness = controlledSession({ queueDisposition: disposition });
				FlowIngressBinding.install(harness.session, {
					version: 1,
					submit: async (_input, dispatch) => (awaitDispatch ? await dispatch() : dispatch()),
				});
				assert.equal(await harness.session[api]("text"), disposition);
				assert.equal(harness.calls.length, 1);
			}
		});

for (const api of ["steer", "followUp"])
	test(`${api} reports handled while retained and its dispatch keeps the native result`, async () => {
		const harness = controlledSession({ queueDisposition: "queued" });
		const captured = capture();
		FlowIngressBinding.install(harness.session, captured.handler);
		assert.equal(await harness.session[api]("held"), "handled");
		assert.equal(harness.calls.length, 0);
		assert.equal(harness.queued.length, 0);
		assert.equal(await captured.entries[0].dispatch(), "queued");
		assert.equal(harness.calls.length, 1);
		assert.equal(harness.queued.length, 1);
	});

test("a submission joins an unawaited dispatch and propagates its native result", async () => {
	const gate = deferred();
	const harness = controlledSession({ queueDisposition: "queued", gate });
	FlowIngressBinding.install(harness.session, { version: 1, submit: (_input, dispatch) => dispatch() });
	let settled = false;
	const sending = harness.session.steer("gated").then((value) => {
		settled = true;
		return value;
	});
	await tick();
	assert.equal(settled, false);
	gate.resolve();
	assert.equal(await sending, "queued");
});

test("sendUserMessage forwarding is captured once and returns the native result", async () => {
	const harness = controlledSession();
	const captured = capture();
	FlowIngressBinding.install(harness.session, {
		version: 1,
		submit: (input, dispatch) => {
			captured.entries.push({ input, dispatch });
			dispatch();
		},
	});
	assert.equal(await harness.session.sendUserMessage([{ type: "text", text: "extension" }]), undefined);
	assert.deepEqual(
		captured.entries.map(({ input }) => input.api),
		["sendUserMessage"],
	);
	assert.deepEqual(
		harness.calls.map(({ api }) => api),
		["sendUserMessage", "prompt"],
	);
	assert.equal(harness.calls[1].text, "extension");
	assert.equal(harness.calls[1].options.source, "extension");
});

test("disposal fences a retained permit and later sends", async () => {
	const harness = controlledSession();
	const captured = capture();
	const binding = FlowIngressBinding.install(harness.session, captured.handler);
	await harness.session.sendCustomMessage({ customType: "note", content: "held", display: false });
	const reported = [];
	await binding.dispose();
	await assert.rejects(
		harness.session.prompt("after disposal", { preflightResult: (value) => reported.push(value) }),
		/closed/,
	);
	assert.deepEqual(reported, []);
	await assert.rejects(captured.entries[0].dispatch(), /closed/);
	assert.equal(harness.calls.length, 0);
});

test("branch replacement fences the permit captured before it", async () => {
	const harness = controlledSession();
	const captured = capture();
	const binding = FlowIngressBinding.install(harness.session, captured.handler);
	await harness.session.followUp("old branch");
	await binding.beforeBranchChange();
	await assert.rejects(harness.session.followUp("during transition"), /transition/);
	await assert.rejects(captured.entries[0].dispatch(), /transition/);
	await binding.branchChanged();
	await assert.rejects(captured.entries[0].dispatch(), /replaced attachment/);
	assert.equal(await harness.session.followUp("new branch"), "handled");
	assert.notEqual(captured.entries[0].input.scope.attachmentId, captured.entries[1].input.scope.attachmentId);
	assert.deepEqual(
		captured.entries.map(({ input }) => input.args[0]),
		["old branch", "new branch"],
	);
	assert.equal(harness.calls.length, 0);
});

test("unsupported submission bytes reject without reporting a disposition", async () => {
	const harness = controlledSession();
	const captured = capture();
	FlowIngressBinding.install(harness.session, captured.handler);
	const reported = [];
	await assert.rejects(
		harness.session.prompt("unsupported", { preflightResult: (value) => reported.push(value), callback: () => {} }),
		/unsupported data/,
	);
	assert.deepEqual(reported, []);
	assert.deepEqual(captured.entries, []);
	assert.equal(harness.calls.length, 0);
});
