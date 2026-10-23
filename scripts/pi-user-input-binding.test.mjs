import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowIngressBinding } from "../upstream/pi-content-policy/flow-ingress.js";

function fixture(onPrompt, { preflight = async () => false, deferred } = {}) {
	let leaf = null;
	const calls = [];
	const session = {
		isStreaming: false,
		sessionManager: { getSessionId: () => "session", getLeafId: () => leaf },
		agent: { inspectQueuedMessages: () => [], hasQueuedMessages: () => false },
		_pendingNextTurnMessages: [],
		_tryExecuteExtensionCommand: preflight,
		...(deferred ? { _deferredSettledActions: deferred, _isEmittingAgentSettled: true } : {}),
		prompt: async (...args) => {
			calls.push(args);
			await onPrompt?.();
		},
		steer: async () => {},
		followUp: async () => {},
		sendCustomMessage: async () => {},
		sendUserMessage: async () => {},
	};
	let host;
	const captured = [];
	const handler = {
		version: 1,
		submit: async (input) => {
			captured.push(input);
		},
		registerUserInputAdapter: async (value, options) => {
			host = value;
			return options;
		},
	};
	const binding = FlowIngressBinding.install(session, handler);
	return {
		binding,
		session,
		calls,
		captured,
		get host() {
			return host;
		},
		append: () => {
			leaf = "next";
		},
	};
}
function input(host) {
	return {
		version: 1,
		id: "message",
		api: "prompt",
		origin: { kind: "extension", id: "/extension.ts" },
		scope: host.scope(),
		externalUser: { version: 1, adapterId: "fixture", messageId: "external" },
		args: ["/flow reset confirm", { expandPromptTemplates: false, streamingBehavior: "followUp", source: "extension" }],
	};
}

test("adapter receives loader identity and dispatches literal prompt once without ordinary capture", async () => {
	const f = fixture();
	await f.binding.registerUserInputAdapter("/extension.ts", { id: "fixture", label: "Fixture" });
	assert.equal(f.host.extensionId, "/extension.ts");
	const submission = input(f.host);
	const dispatch = f.host.prepare(submission);
	submission.args[0] = "mutated";
	await dispatch();
	assert.deepEqual(f.calls, [
		["/flow reset confirm", { expandPromptTemplates: false, streamingBehavior: "followUp", source: "extension" }],
	]);
	assert.equal(f.captured.length, 0);
	await assert.rejects(dispatch(), /already dispatched/);
});

test("external dispatch retains its captured session scope", async () => {
	const f = fixture(async () => {
		f.binding.assertActive();
		f.session.sessionManager.getSessionId = () => "replaced-session";
		assert.throws(() => f.binding.assertActive(), /replaced attachment/);
	});
	await f.binding.registerUserInputAdapter("/extension.ts", { id: "fixture", label: "Fixture" });
	await f.host.prepare(input(f.host))();
	assert.equal(f.calls.length, 1);
});

test("ordinary send options cannot mint external provenance", async () => {
	const f = fixture();
	await f.session.prompt("ordinary", { externalUser: { version: 1, adapterId: "forged", messageId: "forged" } });
	assert.equal(f.captured[0].externalUser, undefined);
});

test("prepared callback survives leaf append but not branch navigation or disposal", async () => {
	const f = fixture();
	await f.binding.registerUserInputAdapter("/extension.ts", { id: "fixture", label: "Fixture" });
	const dispatch = f.host.prepare(input(f.host));
	f.append();
	await dispatch();
	const stale = f.host.prepare(input(f.host));
	await f.binding.beforeBranchChange();
	await f.binding.branchChanged();
	await assert.rejects(stale(), { code: "stale-target" });
	const closed = f.host.prepare(input(f.host));
	await f.binding.dispose();
	await assert.rejects(closed(), /closed/);
});

test("runtime replacement fences a previously prepared callback", async () => {
	const f = fixture();
	let alive = true;
	await f.binding.registerUserInputAdapter("/extension.ts", { id: "fixture", label: "Fixture" }, () => {
		if (!alive) throw new Error("Extension runtime ended");
	});
	const dispatch = f.host.prepare(input(f.host));
	alive = false;
	await assert.rejects(dispatch(), /runtime ended/);
	assert.equal(f.calls.length, 0);
});

test("preparation refuses another extension's identity", async () => {
	const f = fixture();
	await f.binding.registerUserInputAdapter("/extension.ts", { id: "fixture", label: "Fixture" });
	const submission = input(f.host);
	submission.origin.id = "/other.ts";
	assert.throws(() => f.host.prepare(submission), /identity/);
});

test("typed command preflight remains local while external slash text bypasses it", async () => {
	const commands = [],
		dispositions = [];
	const f = fixture(undefined, {
		preflight: async (text) => {
			commands.push(text);
			return true;
		},
	});
	await f.session.prompt("/flow reset confirm", { preflightResult: (value) => dispositions.push(value) });
	assert.deepEqual(commands, ["/flow reset confirm"]);
	assert.deepEqual(dispositions, ["handled"]);
	assert.equal(f.captured.length, 0);
	assert.equal(f.calls.length, 0);
	await f.binding.registerUserInputAdapter("/extension.ts", { id: "fixture", label: "Fixture" });
	await f.host.prepare(input(f.host))();
	assert.deepEqual(commands, ["/flow reset confirm"], "external text executed a local command");
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0][1].expandPromptTemplates, false);
	await f.session.prompt("/flow reset confirm", { expandPromptTemplates: false });
	assert.equal(commands.length, 1);
	assert.equal(f.captured.length, 1);
});

test("disposal abandons deferred external input without waiting for a held settled event", async () => {
	const actions = [];
	const queued = Promise.withResolvers();
	let nativeDeliveries = 0;
	const f = fixture(
		() => {
			if (f.session._isEmittingAgentSettled) {
				actions.push(async () => {
					nativeDeliveries++;
				});
				queued.resolve();
			} else nativeDeliveries++;
		},
		{ deferred: actions },
	);
	await f.binding.registerUserInputAdapter("/extension.ts", { id: "fixture", label: "Fixture" });
	const refused = assert.rejects(f.host.prepare(input(f.host))(), { code: "dispatch-abandoned" });
	await queued.promise;
	assert.equal(actions.length, 1);
	await f.binding.dispose();
	await refused;
	f.session._isEmittingAgentSettled = false;
	for (const action of actions.splice(0)) await action();
	assert.equal(nativeDeliveries, 0, "an abandoned action delivered after disposal");
	assert.equal(f.calls.length, 1, "the late drain called native prompt again");
});
