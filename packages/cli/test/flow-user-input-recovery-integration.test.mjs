import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isProviderPause } from "../dist/flow-control/flow-pause.js";
import { afterCleanup } from "./fixtures/cleanup.mjs";
import { fixture } from "./fixtures/flow-session-ingress.mjs";

/**
 * External adapter input against the recovery and provider-pause controls.
 *
 * The adapter suite owns receipts, grants and dispatch ordering; the recovery and provider-failure
 * suites own the host's own controls. These cases cover the seam between them: text that names a
 * registered command arriving from an adapter while recovery is blocking admission, and an
 * authorized human message arriving while a provider failure has paused automated work.
 */
async function setup(t, options = {}) {
	const agentDir = await mkdtemp(join(tmpdir(), "jouzu-user-input-recovery-"));
	afterCleanup(t, () => rm(agentDir, { recursive: true, force: true }));
	const path = join(agentDir, "extension.ts");
	await writeFile(path, "export default () => {};\n");
	const extensionId = await realpath(path);
	await writeFile(
		join(agentDir, "user-input-adapters.json"),
		JSON.stringify({ schemaVersion: 1, grants: [{ extensionPath: extensionId, adapterId: "fixture" }] }),
	);
	const f = await fixture(t, { agentDir, ...options });
	const adapter = await f.session._flowBinding.registerUserInputAdapter(extensionId, {
		id: "fixture",
		label: "Fixture",
	});
	return { ...f, adapter, binding: await adapter.bind(), agentDir, extensionId };
}

const input = (f, messageId, text) => ({ binding: f.binding, messageId, text, deliverAs: "followUp" });
const lookup = (f, messageId) => f.adapter.lookup({ target: f.binding.target, messageId });
const records = async (f) => f.ingress.branch().attachment.submissions.snapshot(false);
/** Index of the provider request carrying this text, or -1. */
const delivered = (f, text) => f.sent.findIndex((messages) => JSON.stringify(messages).includes(text));

/** Bounded wait for a state the host reaches asynchronously, with the expectation in the failure. */
async function until(predicate, message) {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(message);
}

/** The fixture's ordinary streaming reply, used once the scripted failure has been observed. */
const completed = () =>
	new Response(
		`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
const outage = () =>
	new Response(JSON.stringify({ error: { message: "fixture provider outage" } }), {
		status: 503,
		headers: { "content-type": "application/json" },
	});

test("adapter text naming a registered command stays literal and is held during recovery", async (t) => {
	const calls = [];
	let blocked = true;
	const f = await setup(t, {
		admit: null,
		policy: () => ({ userPending: false, recoveryBlocked: blocked, waitingWorkIds: [] }),
		extensions: [
			(pi) =>
				pi.registerCommand("fixture-recovery", {
					description: "Inspect local fixture state",
					handler: () => {
						calls.push("command");
					},
				}),
		],
	});
	const text = "/fixture-recovery now";
	// Control: typed input naming the registered command takes the recovery shortcut and runs locally.
	await f.session.prompt(text);
	assert.equal(calls.length, 1, "the registered command did not run from typed input");
	assert.equal(f.sent.length, 0, "the local control started model work");
	// The same text from an authorized adapter is user input, not a host command, so recovery holds it.
	const receipt = await f.adapter.submit(input(f, "recovery", text));
	assert.equal(receipt.state, "held");
	assert.equal(calls.length, 1, "adapter text executed the registered command");
	assert.equal(f.sent.length, 0, "held adapter text reached the provider");
	const record = (await records(f)).find((candidate) => candidate.submission.externalUser);
	assert.ok(record, "the adapter text left no external record");
	assert.equal(record.status, "retained");
	assert.equal(record.holds.at(-1).reason, "Input is waiting for recovery reconciliation.");
	// Clearing recovery delivers the text once, literally, and still runs no command.
	blocked = false;
	await f.ingress.releaseReady();
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "recovery")).state, "consumed");
	assert.equal(calls.length, 1, "the delivered adapter text executed the registered command");
	assert.equal(f.sent.filter((messages) => JSON.stringify(messages).includes(text)).length, 1);
	assert.ok(JSON.stringify(f.sent[0]).includes(text), "the delivered text was not the literal prompt");
});

test("a provider failure holds automated input until an authorized external human resumes admission", async (t) => {
	let failing = true;
	const f = await setup(t, {
		provider: true,
		admit: null,
		response: () => (failing ? outage() : completed()),
	});
	await f.session.prompt("failing turn");
	// The pause comes from the host's own recovery outcome, not from an injected reason.
	await until(
		() => isProviderPause(f.ingress.automatedPause() ?? "") && f.session.isIdle,
		"the provider failure never raised a pause on an idle session",
	);
	assert.match(f.ingress.automatedPause(), /fixture provider outage/);
	assert.equal(f.sent.length, 1, "the failed turn made more than the one request");
	// Automated work is now held, and the hold is the pause rather than a boundary reason.
	await f.session.sendUserMessage("automated continuation");
	const automated = (await records(f)).find((record) =>
		JSON.stringify(record.submission.args).includes("automated continuation"),
	);
	assert.ok(automated, "the automated send was not retained");
	assert.equal(automated.status, "retained");
	assert.equal(automated.holds.at(-1).reason, "Automated input is paused until the next user turn is under way.");
	assert.equal(f.sent.length, 1, "the paused automated send ran");
	// The authorized human message arrives from the adapter while the pause still holds that work.
	failing = false;
	await f.adapter.submit(input(f, "human", "external instruction"));
	assert.equal(f.ingress.automatedPause(), undefined, "the external human did not clear the provider pause");
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "human")).state, "consumed");
	const humanAt = delivered(f, "external instruction");
	assert.ok(humanAt > 0, "the external human request never reached the provider");
	// Human before automation: the held send takes a later boundary than the person's own turn.
	for (let pass = 0; pass < 4 && delivered(f, "automated continuation") === -1; pass++)
		await f.ingress.joinPendingOperations();
	const automatedAt = delivered(f, "automated continuation");
	assert.ok(automatedAt > humanAt, "the held automated send did not run after the human turn");
	// Later requests retain the earlier human text in their history. Count new requests and native
	// user messages instead of treating that repeated context as duplicate delivery.
	const requestsBeforeRetry = f.sent.length;
	assert.equal((await f.adapter.submit(input(f, "human", "external instruction"))).state, "consumed");
	await f.ingress.joinPendingOperations();
	assert.equal(f.sent.length, requestsBeforeRetry);
	assert.equal(
		f.session.agent.state.messages.filter(
			(message) =>
				message.role === "user" &&
				message.content.some((part) => part.type === "text" && part.text === "external instruction"),
		).length,
		1,
	);
});
