import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { createJouzuModelPicker } from "../dist/model-picker.js";
import { resolveJouzuPaths } from "../dist/paths.js";
import {
	assembledSession,
	capturedNotices,
	installedProducerExtensions,
	replacedSession,
} from "./fixtures/flow-assembly.mjs";
import { waitForFlow } from "./fixtures/flow-session-ingress.mjs";
import { nativeRequests } from "./fixtures/native-requests.mjs";

async function withheldSession(t, extraExtensions = []) {
	let filter = true;
	const producers = await installedProducerExtensions();
	const f = await assembledSession(t, {
		persist: true,
		producerExtensions: [
			...producers,
			...extraExtensions,
			{
				name: "withhold-required-input",
				factory(pi) {
					pi.on("context", (event) => {
						if (filter)
							return {
								messages: event.messages.filter(
									(message) => !JSON.stringify(message).includes("Required continuation"),
								),
							};
					});
				},
			},
		],
	});
	await f.session.prompt("Required continuation");
	assert.equal(f.bodies.length, 0);
	assert.equal(f.ingress.branch().attachment.nativeRequests.recoveryBlocked, true);
	return {
		...f,
		producers,
		restore: () => {
			filter = false;
		},
	};
}

test("payload admission retains its original failure instead of replacing it with a missing-payload error", async (t) => {
	const f = await withheldSession(t);
	assert.match(f.session.agent.state.errorMessage, /required input was changed or unresolved/);
	assert.doesNotMatch(f.session.agent.state.errorMessage, /returned without payload admission/);
});

test("/about remains local during a hold and does not retain input or resume automation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-about-held-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const integration = createJouzuModelPicker(resolveJouzuPaths({ homeOverride: root }), {
		runtime: { about: () => "Running Jouzu fixture-build\nPi fixture" },
	});
	const f = await withheldSession(t, [integration.extension]);
	const notices = capturedNotices(f.session);
	const store = f.ingress.branch().attachment.submissions;
	const before = await store.snapshot();
	const pause = f.ingress.automatedPause();
	assert.ok(pause);
	t.mock.method(store, "retain", async () => {
		throw new Error("Diagnostic commands must not need submission capacity");
	});
	for (const command of ["/about", "/about extra"]) {
		const count = notices.length;
		await f.session.prompt(command);
		assert.ok(notices.slice(count).some((notice) => notice.text.includes("fixture-build")));
	}
	assert.equal(f.ingress.automatedPause(), pause);
	assert.equal(f.bodies.length, 0);
	assert.deepEqual(await store.snapshot(), before);
});

test("/flow reports a withheld request through the recovery gate without retaining a command", async (t) => {
	const f = await withheldSession(t);
	const notices = capturedNotices(f.session);
	const before = await f.ingress.branch().attachment.submissions.snapshot();
	const pause = f.ingress.automatedPause();
	await f.session.prompt("/flow");
	assert.ok(notices.length, "inspection must reach the local command handler");
	const output = notices.map((notice) => notice.text).join("\n");
	assert.match(output, /Required input was removed or changed/);
	assert.match(output, /\/flow clear/);
	const withheld = (await f.ingress.branch().attachment.nativeRequests.snapshot()).find(
		(record) => record.outcome === "withheld",
	);
	assert.ok(output.includes(withheld.id));
	await f.session.prompt("/flow runtime");
	await f.session.prompt("/flow details 2");
	assert.ok(notices.length >= 2);
	assert.equal(f.bodies.length, 0);
	assert.equal(f.ingress.automatedPause(), pause);
	assert.deepEqual(await f.ingress.branch().attachment.submissions.snapshot(), before);
});

// `/flow clear` preserves flow evidence while repairing a reservation; `/flow reset` is the destructive fallback.
test("/flow clear recovers a required-input hold and preserves its receipt across reopen", async (t) => {
	const f = await withheldSession(t);
	f.restore();
	const notices = capturedNotices(f.session);
	const store = f.ingress.branch().attachment.nativeRequests;
	const before = await store.snapshot();
	await f.session.prompt("/flow clear");
	assert.equal(store.recoveryBlocked, false, JSON.stringify(notices));
	assert.equal(f.ingress.automatedPause(), undefined);
	assert.equal(f.bodies.length, 0, "clear does not send work");
	assert.ok(notices.some((notice) => /released 1 request hold/.test(notice.text)));
	const recovered = (await store.snapshot()).find((record) => record.id === before[0].id);
	assert.equal(recovered.reset, true);
	assert.equal(recovered.outcome, "withheld");
	assert.deepEqual(recovered.withheldPayload, before[0].withheldPayload);
	await f.session.prompt("Continue after repair");
	await f.session.prompt("Continue again");
	assert.equal(f.bodies.length, 2, f.session.agent.state.errorMessage);
	assert.ok(JSON.stringify(f.bodies[0]).includes("Required continuation"));
	const next = await replacedSession(t, f, {
		reason: "resume",
		persist: true,
		sessionManager: SessionManager.open(f.sessionManager.getSessionFile()),
		producerExtensions: f.producers,
	});
	await next.session.prompt("Continue after reopening");
	assert.equal(next.bodies.length, 1, next.session.agent.state.errorMessage);
	assert.deepEqual(f.errors, []);
	assert.deepEqual(next.errors, []);
});

test("clear preserves partially cancelled source evidence", async (t) => {
	const f = await nativeRequests(t, {
		retainInputs: true,
		enforceRequiredSources: true,
		contextHandler: ({ messages }) => ({ messages: structuredClone(messages) }),
	});
	await f.session.followUp("First source");
	await f.session.followUp("Second source");
	f.session.agent.followUpMode = "all";
	await f.session.continueQueued();
	const [held] = await f.store.snapshot();
	assert.equal(held.requiredSources.length, 2);
	await f.store.cancelSources(held.id, held.withheldPayload.hash, [0]);
	assert.equal(await f.store.reset(), 1);
	const [reset] = await f.store.snapshot();
	assert.equal(reset.reset, true);
	assert.deepEqual(reset.cancelledSources, [0]);
	assert.deepEqual(reset.withheldPayload, held.withheldPayload);
	assert.equal(f.store.recoveryBlocked, false);
	assert.equal(await f.store.reset(), 0, "reset is idempotent");
});

for (const failsAgain of [false, true])
	test(`reset preserves linked retry evidence: second request withheld=${failsAgain}`, async (t) => {
		let reject = true;
		const f = await nativeRequests(t, {
			retainInputs: true,
			enforceRequiredSources: true,
			contextHandler: ({ messages }) => ({ messages: reject ? structuredClone(messages) : messages }),
		});
		await f.session.prompt("Initial source");
		const [held] = await f.store.snapshot();
		await f.store.authorizeRetry(held.id, held.withheldPayload.hash);
		reject = failsAgain;
		await f.session.prompt("Retry source");
		const before = await f.store.snapshot();
		assert.equal(before[1].outcome, failsAgain ? "withheld" : "success");
		await f.store.reset();
		const after = await f.store.snapshot();
		assert.equal(after[0].retryAuthorization.requestId, after[1].id);
		assert.equal(after[1].retryOf, after[0].id);
		assert.deepEqual(after[0].withheldPayload, before[0].withheldPayload);
		assert.equal(after[1].outcome, before[1].outcome);
		assert.equal(f.store.recoveryBlocked, false);
		assert.equal(await f.store.reset(), 0);
	});

test("a registered local command during recovery keeps the automation pause", async (t) => {
	let calls = 0;
	const f = await withheldSession(t, [
		{
			name: "local-control",
			factory: (pi) =>
				pi.registerCommand("fixture-status", {
					description: "Inspect local fixture state",
					handler: () => {
						calls++;
					},
				}),
		},
	]);
	const store = f.ingress.branch().attachment.submissions;
	const before = await store.snapshot();
	const pause = f.ingress.automatedPause();
	assert.ok(pause);
	t.mock.method(store, "retain", async () => {
		throw new Error("Local commands must not need submission capacity");
	});
	await f.session.prompt("/fixture-status details");
	assert.equal(calls, 1, "the registered command still runs");
	assert.equal(f.bodies.length, 0, "a local command sends no model input");
	assert.equal(f.ingress.automatedPause(), pause, "recovery still holds automated work");
	assert.deepEqual(await store.snapshot(), before);
	assert.equal(f.ingress.branch().attachment.nativeRequests.recoveryBlocked, true);
});

test("a local command still ends an ordinary pause when recovery holds nothing", async (t) => {
	let calls = 0;
	const f = await assembledSession(t, {
		producerExtensions: [
			{
				name: "local-control",
				factory: (pi) =>
					pi.registerCommand("fixture-status", {
						handler: () => {
							calls++;
						},
					}),
			},
		],
	});
	const store = f.ingress.branch().attachment.submissions;
	assert.equal(f.ingress.pauseAutomated("held for a fixture"), true);
	await f.session.prompt("/fixture-status");
	assert.equal(calls, 1);
	assert.equal(f.ingress.automatedPause(), undefined, "speaking to a local command ends the pause");
	assert.equal(f.bodies.length, 0);
	assert.deepEqual(await store.snapshot(), []);
});

test("a registered local command stays reachable during a busy turn and keeps the pause", async (t) => {
	const entered = deferred();
	const release = deferred();
	let calls = 0;
	const f = await assembledSession(t, {
		producerExtensions: [
			{
				name: "local-control",
				factory: (pi) =>
					pi.registerCommand("fixture-status", {
						handler: () => {
							calls++;
						},
					}),
			},
		],
		script: async () => {
			entered.resolve();
			await release.promise;
			return { text: "Finished" };
		},
	});
	const running = f.session.prompt("Controlled active turn");
	try {
		await entered.promise;
		assert.equal(f.session.isIdle, false);
		// An unresolved request is what recovery holds model admission for, so the turn in flight is
		// itself the recovery block this command must not treat as consent to resume automated work.
		assert.equal(f.ingress.branch().attachment.nativeRequests.recoveryBlocked, true);
		const store = f.ingress.branch().attachment.submissions;
		const before = await store.snapshot();
		assert.equal(f.ingress.pauseAutomated("held for a fixture"), true);
		await f.session.prompt("/fixture-status");
		assert.equal(calls, 1, "a registered command runs during the turn, as upstream defines");
		assert.equal(f.bodies.length, 1, "the command adds no model work");
		assert.equal(f.ingress.automatedPause(), "held for a fixture");
		assert.deepEqual(await store.snapshot(), before);
	} finally {
		release.resolve();
		await running;
	}
	await waitForFlow(() => !f.ingress.branch().attachment.nativeRequests.recoveryBlocked);
	await f.session.prompt("/fixture-status");
	assert.equal(calls, 2);
	assert.equal(f.ingress.automatedPause(), undefined, "without a recovery hold the command ends the pause");
	assert.equal(f.bodies.length, 1);
});

test("a registered local command stays reachable during retry backoff and keeps the pause", async (t) => {
	let calls = 0;
	const f = await withheldSession(t, [
		{
			name: "local-control",
			factory: (pi) =>
				pi.registerCommand("fixture-status", {
					handler: () => {
						calls++;
					},
				}),
		},
	]);
	const retry = t.mock.getter(f.session, "isRetrying", () => true);
	try {
		const store = f.ingress.branch().attachment.submissions;
		const before = await store.snapshot();
		const pause = f.ingress.automatedPause();
		assert.ok(pause);
		await f.session.prompt("/fixture-status");
		assert.equal(calls, 1, "a registered command runs during retry backoff, as upstream defines");
		assert.equal(f.bodies.length, 0);
		assert.equal(f.ingress.automatedPause(), pause);
		assert.deepEqual(await store.snapshot(), before);
	} finally {
		retry.mock.restore();
	}
});

test("command-looking model text stays retained behind recovery instead of taking a control shortcut", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-literal-command-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const integration = createJouzuModelPicker(resolveJouzuPaths({ homeOverride: root }), {
		runtime: { about: () => "Unexpected local about" },
	});
	let calls = 0;
	const f = await withheldSession(t, [
		integration.extension,
		{
			name: "local-control",
			factory: (pi) =>
				pi.registerCommand("fixture-status", {
					handler: () => {
						calls++;
					},
				}),
		},
	]);
	const notices = capturedNotices(f.session);
	const store = f.ingress.branch().attachment.submissions;
	const before = await store.snapshot();
	// Every text below is model input, not a command: leading whitespace, a newline or tab separator,
	// an unregistered name, a steered or followed message, or a prompt with template expansion off.
	const texts = [" /flow", " /about", "/flow\nanything", "/flow\tclear", "/about\targument", "/missing-command"];
	for (const text of texts) await f.session.prompt(text);
	for (const text of ["/about", "/flow"]) await f.session.prompt(text, { expandPromptTemplates: false });
	await f.session.steer("/missing-command");
	await f.session.followUp(" /about");
	assert.equal(calls, 0, "no model text may reach a registered command handler");
	assert.equal(
		notices.some((notice) => notice.text.includes("Unexpected local about")),
		false,
		"no model text may reach the local about handler",
	);
	assert.equal(f.bodies.length, 0, "no held input is dispatched");
	const records = await store.snapshot(true);
	const held = records.filter((record) => record.holds?.some((hold) => hold.reason.includes("recovery")));
	assert.deepEqual(
		held.map((record) => record.submission.args[0]),
		[...texts, "/about", "/flow", "/missing-command", " /about"],
	);
	assert.equal(records.length, before.length + held.length, "every message is retained once, with no extra record");
	assert.ok(
		held.every((record) => record.dispatch === undefined),
		"held text is never dispatched through a shortcut",
	);
});

test("an extension-origin command-looking prompt stays retained behind recovery", async (t) => {
	let calls = 0;
	const f = await withheldSession(t, [
		{
			name: "local-control",
			factory: (pi) =>
				pi.registerCommand("fixture-status", {
					handler: () => {
						calls++;
					},
				}),
		},
	]);
	await f.session._flowBinding.fromExtension("fixture-origin", () => f.session.prompt("/fixture-status"));
	assert.equal(calls, 0);
	assert.equal(f.bodies.length, 0);
	const records = await f.ingress.branch().attachment.submissions.snapshot(true);
	const held = records.find((record) => record.submission.args[0] === "/fixture-status");
	assert.equal(held.submission.api, "prompt");
	assert.equal(held.submission.origin.kind, "extension");
	assert.ok(held.holds.some((hold) => hold.reason.includes("recovery")));
});

test("a local command's model send still obeys recovery admission", async (t) => {
	let calls = 0;
	const f = await withheldSession(t, [
		{
			name: "local-control",
			factory: (pi) =>
				pi.registerCommand("fixture-continue", {
					handler: () => {
						calls++;
						pi.sendUserMessage("Requested continuation", { deliverAs: "followUp" });
					},
				}),
		},
	]);
	const store = f.ingress.branch().attachment.submissions;
	await f.session.prompt("/fixture-continue");
	assert.equal(calls, 1);
	// The handler does not await its own send, so the hold is recorded after the record appears.
	await waitForFlow(async () =>
		(await store.snapshot(true)).some(
			(record) =>
				record.submission.api === "sendUserMessage" && record.holds?.some((hold) => hold.reason.includes("recovery")),
		),
	);
	const send = (await store.snapshot(true)).find((record) => record.submission.api === "sendUserMessage");
	assert.equal(send.submission.userCommand.name, "fixture-continue");
	assert.ok(send.holds.some((hold) => hold.reason.includes("recovery")));
	assert.equal(f.bodies.length, 0);
	assert.equal(f.ingress.branch().attachment.nativeRequests.recoveryBlocked, true);
});

test("literal command-looking input is delivered as model text once recovery clears", async (t) => {
	const f = await withheldSession(t);
	await f.session.prompt(" /flow");
	assert.equal(f.bodies.length, 0);
	f.restore();
	await f.session.prompt("/flow clear");
	await waitForFlow(() => f.bodies.length === 1);
	assert.ok(JSON.stringify(f.bodies[0]).includes(" /flow"), "the held message keeps its literal text");
	await f.session.waitForIdle();
	await f.session.prompt("/about", { expandPromptTemplates: false });
	await waitForFlow(() => f.bodies.length === 2);
	assert.ok(JSON.stringify(f.bodies[1]).includes("/about"));
	assert.deepEqual(f.errors, []);
});

test("a command's recovery read cannot clear a pause requested while it runs", async (t) => {
	const entered = deferred();
	const release = deferred();
	let calls = 0;
	const f = await assembledSession(t, {
		producerExtensions: [
			{
				name: "local-control",
				factory: (pi) =>
					pi.registerCommand("fixture-status", {
						handler: () => {
							calls++;
						},
					}),
			},
		],
	});
	// Let session-start advisory reads settle before one recovery read is gated.
	await new Promise((resolve) => setImmediate(resolve));
	await f.session.prompt("/flow pause");
	const pause = f.ingress.automatedPause();
	assert.equal(pause, "held from /flow");
	t.mock.method(f.ingress, "recoveryHold", async () => {
		entered.resolve();
		await release.promise;
		return undefined;
	});
	const command = f.session.prompt("/fixture-status");
	await entered.promise;
	// The same explicit pause, requested again while the earlier command is still reading.
	await f.session.prompt("/flow pause");
	assert.equal(f.ingress.automatedPause(), pause);
	release.resolve();
	await command;
	assert.equal(calls, 1, "the command still runs");
	assert.equal(f.ingress.automatedPause(), pause, "a pause requested after the read started survives");
});

test("a command does not start when disposal fences the ingress during its recovery read", async (t) => {
	const entered = deferred();
	const release = deferred();
	let calls = 0;
	const f = await assembledSession(t, {
		producerExtensions: [
			{
				name: "local-control",
				factory: (pi) =>
					pi.registerCommand("fixture-status", {
						handler: () => {
							calls++;
						},
					}),
			},
		],
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.ingress.pauseAutomated("held before disposal"), true);
	const reported = [];
	f.session.extensionRunner.onError((error) => reported.push(error));
	t.mock.method(f.ingress, "recoveryHold", async () => {
		entered.resolve();
		await release.promise;
		return undefined;
	});
	const command = f.session.prompt("/fixture-status").then(
		() => "resolved",
		(error) => error,
	);
	await entered.promise;
	const disposing = f.session.dispose();
	release.resolve();
	await disposing;
	const outcome = await command;
	assert.equal(calls, 0, "a command must not start after disposal fenced its session");
	assert.equal(f.ingress.automatedPause(), "held before disposal", "disposal during the read does not clear the pause");
	assert.equal(outcome, "resolved", "the refusal reports through Pi's command path instead of becoming model input");
	assert.match(
		reported.map((entry) => entry.error).join("\n"),
		/not attached to an active branch/,
		"the refused command names the stale session",
	);
});

test("a command does not start after its branch was replaced during the recovery read", async (t) => {
	const entered = deferred();
	const release = deferred();
	let calls = 0;
	const f = await assembledSession(t, {
		producerExtensions: [
			{
				name: "local-control",
				factory: (pi) =>
					pi.registerCommand("fixture-status", {
						handler: () => {
							calls++;
						},
					}),
			},
		],
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.ingress.pauseAutomated("held before replacement"), true);
	const original = f.ingress.branch();
	// Pi's own navigation cannot reach this window: the host boundary refuses a handoff while a
	// command holds its frame (`pi-host-boundary.ts`, `handoffNavigation` requires `active === 1`), so
	// `navigateTree` during this read rejects with `busy`. The replacement is therefore applied at the
	// boundary `runCommand` revalidates, and this contract test pins the comparison itself.
	let replacement;
	t.mock.method(f.ingress, "branch", () => replacement ?? original);
	// The read is mocked too: the production read is disposal-joined, so a real one keeps the ingress
	// fence set until it settles and hides the window between the read and the handler.
	t.mock.method(f.ingress, "recoveryHold", async () => {
		entered.resolve();
		await release.promise;
		return undefined;
	});
	const reported = [];
	f.session.extensionRunner.onError((error) => reported.push(error));
	const command = f.session.prompt("/fixture-status").then(
		() => "resolved",
		(error) => error,
	);
	await entered.promise;
	assert.equal(f.session.isIdle, true);
	replacement = { ...original };
	release.resolve();
	const outcome = await command;
	assert.deepEqual(
		[calls, f.ingress.automatedPause()],
		[0, "held before replacement"],
		"a command must not start against a replaced branch, and the pause must survive the read",
	);
	assert.equal(outcome, "resolved", "the refusal reports through Pi's command path instead of becoming model input");
	assert.match(reported.map((entry) => entry.error).join("\n"), /branch changed during its recovery read/);
});

test("a local command reads recovery state only when a pause is set", async (t) => {
	let calls = 0;
	let reads = 0;
	const f = await assembledSession(t, {
		producerExtensions: [
			{
				name: "local-control",
				factory: (pi) =>
					pi.registerCommand("fixture-status", {
						handler: () => {
							calls++;
						},
					}),
			},
		],
	});
	await new Promise((resolve) => setImmediate(resolve));
	t.mock.method(f.ingress, "recoveryHold", async () => {
		reads++;
		return undefined;
	});
	await f.session.prompt("/fixture-status");
	assert.equal(calls, 1);
	assert.equal(reads, 0, "no pause means no recovery read");
	assert.equal(f.ingress.automatedPause(), undefined);
});

test("an unreadable recovery state keeps the pause and still runs the command", async (t) => {
	let calls = 0;
	const f = await assembledSession(t, {
		producerExtensions: [
			{
				name: "local-control",
				factory: (pi) =>
					pi.registerCommand("fixture-status", {
						handler: () => {
							calls++;
						},
					}),
			},
		],
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.ingress.pauseAutomated("held for a fixture"), true);
	const unavailable = t.mock.method(f.ingress, "recoveryHold", async () => {
		throw new Error("recovery state is unavailable");
	});
	await f.session.prompt("/fixture-status");
	assert.equal(calls, 1, "the command stays reachable");
	assert.equal(f.ingress.automatedPause(), "held for a fixture", "an unreadable hold is kept");
	unavailable.mock.restore();
	await f.session.prompt("/fixture-status");
	assert.equal(calls, 2);
	assert.equal(f.ingress.automatedPause(), undefined, "a readable state ends the pause");
});

test("input held before clear does not race a new prompt for the work invocation", async (t) => {
	const f = await withheldSession(t);
	await f.session.prompt("Message held behind recovery");
	assert.equal(f.bodies.length, 0);
	f.restore();
	await f.session.prompt("/flow clear");
	await f.session.prompt("New message after recovery");
	const deadline = Date.now() + 5000;
	while (f.bodies.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
	await f.session.waitForIdle();
	assert.equal(f.bodies.length, 2, f.session.agent.state.errorMessage);
	assert.ok(JSON.stringify(f.bodies).includes("Message held behind recovery"));
	assert.ok(JSON.stringify(f.bodies).includes("New message after recovery"));
	assert.deepEqual(f.errors, []);
});
