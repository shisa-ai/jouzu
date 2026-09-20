import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJouzuModelPicker } from "../dist/model-picker.js";
import { resolveJouzuPaths } from "../dist/paths.js";
import {
	assembledSession,
	capturedNotices,
	installedProducerExtensions,
	replacedSession,
} from "./fixtures/flow-assembly.mjs";
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

// `/flow clear` is the reservation release; `/flow reset` is off-then-on and must leave the hold alone.
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
