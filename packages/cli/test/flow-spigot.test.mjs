import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assistantToolCalls } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { FLOW_OFF_MESSAGE } from "../dist/flow-control/flow-off-message.js";
import {
	assembledSession,
	capturedNotices,
	installedProducerExtensions,
	installedTaskExtension,
	syntheticProducer,
} from "./fixtures/flow-assembly.mjs";
import { campaignScript, liveWait } from "./fixtures/flow-campaign.mjs";
import { waitDependencyFrom } from "./fixtures/flow-wait-dependency.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A session whose request for required input was withheld, leaving a recovery hold in place. */
async function withheldSession(t) {
	let filter = true;
	const producers = await installedProducerExtensions();
	const f = await assembledSession(t, {
		persist: true,
		producerExtensions: [
			...producers,
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
	assert.equal(f.bodies.length, 0, "the request is withheld");
	assert.equal(f.ingress.branch().attachment.nativeRequests.recoveryBlocked, true);
	return {
		...f,
		restore: () => {
			filter = false;
		},
	};
}

test("flow control off flushes a send held behind a recovery hold and lets later sends through", async (t) => {
	const f = await withheldSession(t);
	const notices = capturedNotices(f.session);
	await f.session.prompt("held behind the hold");
	assert.equal(f.bodies.length, 0, "the send waits behind the recovery hold");

	const result = await f.ingress.suspend();
	assert.equal(result.flushed, 1, "turning flow control off hands the retained send back to Pi");
	assert.equal(f.ingress.enabled(), false);
	const deadline = Date.now() + 5000;
	while (f.bodies.length < 1 && Date.now() < deadline) await settle();
	assert.equal(f.bodies.length, 1, "the flushed send ran, without flow control enforcing the hold");
	assert.ok(JSON.stringify(f.bodies).includes("held behind the hold"), "as the message the user sent");

	// The hold itself is untouched: off hands delivery back, and /flow clear is what repairs a hold.
	assert.equal(f.ingress.branch().attachment.nativeRequests.recoveryBlocked, true);
	await f.session.prompt("after flow control is off");
	const next = Date.now() + 5000;
	while (f.bodies.length < 2 && Date.now() < next) await settle();
	assert.equal(f.bodies.length, 2, "later sends run while flow control is off");

	await f.session.prompt("/flow on");
	assert.equal(f.ingress.enabled(), true);
	assert.match(notices.at(-1).text, /Flow control is on again/);
	assert.deepEqual(f.errors, []);
});

test("flow control off flushes a retained producer delivery back to Pi", async (t) => {
	// A producer's completion arrives while the request that would carry it is withheld, so flow
	// retains the message instead of dispatching it. Off hands that delivery back to Pi, which is what
	// makes off usable when a stuck hold is what brought the user here.
	const f = await withheldSession(t);
	const delivered = () => f.sessionManager.getEntries().some((entry) => entry.customType === "probe:delivery");
	const retained = async () => (await f.ingress.branch().attachment.submissions.snapshot()).length;
	const before = await retained();
	void f.session.sendCustomMessage(
		{ customType: "probe:delivery", content: "the job finished", display: false },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	const deadline = Date.now() + 5000;
	while ((await retained()) === before && Date.now() < deadline) await settle();
	assert.equal(await retained(), before + 1, "flow retains the delivery while the request is withheld");
	assert.equal(delivered(), false, "and Pi has not seen it");

	const result = await f.ingress.suspend();
	assert.equal(result.flushed, 1, "turning flow control off hands the retained delivery back to Pi");
	while (!delivered() && Date.now() < deadline) await settle();
	assert.ok(delivered(), "the flushed delivery ran, with no flow turn composed for it");
	assert.deepEqual(f.errors, []);
});

test("flow control off ends live waits, and the completion arrives natively", async (t) => {
	const campaign = campaignScript({ command: "sleep 2", goal: "Sweep while flow control stops" });
	let asked = false;
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		// While flow control is off the model asks for the wait once more, so the refusal is what it
		// reads back rather than something the test calls directly.
		script: (body, index) => {
			if (!asked && !f.ingress.enabled()) {
				asked = true;
				const dependency = waitDependencyFrom(body);
				assert.ok(dependency, "the earlier spawn is still in the conversation");
				return assistantToolCalls({
					name: "agent_wait",
					arguments: {
						work: dependency.work.id,
						reason: "still waiting",
						deadline: "30m",
						on: [
							{
								producer: dependency.producer,
								handle: dependency.handle,
								execution: dependency.execution,
								until: dependency.until,
							},
						],
					},
				});
			}
			return campaign(body, index);
		},
	});
	await f.session.prompt("start the sweep and wait");
	const wait = await liveWait(f.ingress, "the campaign leaves one live wait");
	const notices = capturedNotices(f.session);

	await f.session.prompt("/flow off");
	assert.equal(f.ingress.enabled(), false);
	assert.match(notices.at(-1).text, /Flow control is off/);
	assert.match(notices.at(-1).text, /1 wait ended/);
	const waits = await f.ingress.branch().attachment.waits.snapshot();
	assert.equal(waits.find((record) => record.token === wait.token)?.state, "cancelled");
	assert.equal(waits.filter((record) => record.state === "waiting").length, 0, "no live wait remains");
	const authority = await f.ingress.branch().attachment.waits.authoritySnapshot();
	assert.ok(
		authority.work.some((record) => record.id === wait.workId),
		"the work that declared the wait is untouched by turning flow control off",
	);

	// Flow tools stay visible and refuse rather than failing obscurely. The model asks for one and
	// the refusal is what it reads back.
	await f.session.prompt("wait for the sweep again");
	const refusal = f.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
		.map((entry) => entry.message)
		.at(-1);
	assert.match(JSON.stringify(refusal), new RegExp(FLOW_OFF_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	const status = capturedNotices(f.session);
	await f.session.prompt("/flow");
	assert.match(status.at(-1).text, /Flow control is off for this session/);
	await f.session.prompt("/flow cancel no-such-token");
	assert.match(status.at(-1).text, /works again after \/flow on/);

	// The job finishes while flow control is off, so the extension delivers its own completion through
	// Pi instead of flow composing a turn for it. That delivery is the case a finished dispatch's
	// leftover permit used to block, so this waits for the turn it starts, not for a later prompt.
	const turns = f.bodies.length;
	const entries = () => f.sessionManager.getEntries();
	const delivered = () => entries().some((entry) => entry.customType === "kendex-background-tasks:event");
	const deadline = Date.now() + 30000;
	while (!delivered() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(delivered(), "the extension delivered its own completion message, with no flow turn composed for it");
	const replied = () => {
		const list = entries();
		const at = list.findIndex((entry) => entry.customType === "kendex-background-tasks:event");
		return at >= 0 && list.slice(at).some((entry) => entry.message?.role === "assistant");
	};
	while (!replied() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
	assert.ok(replied(), "and the turn it started belongs to the model, not to flow");
	assert.ok(f.bodies.length > turns, "which cost one ordinary request");
	await f.session.prompt("/flow on");
	assert.equal(f.ingress.enabled(), true);
	assert.deepEqual(f.errors, []);
});

test("flow control off keeps navigation working, and /flow on binds the branch it landed on", async (t) => {
	const f = await assembledSession(t, { persist: true, producerExtensions: await installedProducerExtensions() });
	await f.session.prompt("first branch turn");
	const original = f.ingress.branch().scope.branchId;
	await f.session.prompt("/flow off");
	const user = f.session.sessionManager
		.getBranch()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	await f.session.navigateTree(user.id);
	const landed = f.ingress.branch().scope.branchId;
	assert.notEqual(landed, original, "the attachment follows navigation while flow control is off");

	await f.session.prompt("/flow on");
	assert.equal(f.ingress.enabled(), true);
	assert.equal(
		f.ingress.branch().scope.branchId,
		landed,
		"turning flow control on keeps the branch navigation landed on",
	);
	await f.session.prompt("after navigation");
	assert.deepEqual(f.errors, []);
});

test("flow control on restores routing, and reset is off followed by on", async (t) => {
	const f = await assembledSession(t, { producerExtensions: await installedProducerExtensions() });
	const notices = capturedNotices(f.session);
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());

	await f.session.prompt("/flow off");
	assert.equal(f.ingress.enabled(), false);
	await f.session.prompt("/flow off");
	assert.match(notices.at(-1).text, /already off/);

	// Off stops scheduling as well as interception: offered work starts no turn, which is what leaves
	// a producer's own delivery path as the only thing that can act on it.
	synthetic.offer([{ id: "intent-0", revision: "1" }]);
	await registration.changed();
	await settle();
	assert.equal(f.bodies.length, 0, "no turn starts for offered work while flow control is off");

	await f.session.prompt("/flow on");
	assert.equal(f.ingress.enabled(), true);
	assert.match(notices.at(-1).text, /Flow control is on again/);
	await f.session.prompt("/flow on");
	assert.match(notices.at(-1).text, /already on/);

	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	await registration.changed();
	await settle();
	assert.equal(f.bodies.length, 1, "the restored spigot drives offered work");

	// A malformed verb is the one place the whole command list is shown, so it has to name the
	// controls that get a session out of trouble.
	await f.session.prompt("/flow off extra");
	assert.equal(f.ingress.enabled(), true, "a malformed verb changes nothing");
	for (const line of [
		"off turns flow control off",
		"on turns flow control back on",
		"reset turns flow control off and on again",
		"clear releases a stuck reservation",
	])
		assert.match(notices.at(-1).text, new RegExp(`/flow ${line}`));

	// Reset is the same pair in one command: it takes the spigot down and back up.
	await f.session.prompt("/flow reset");
	assert.equal(f.ingress.enabled(), true);
	assert.match(notices.at(-1).text, /Flow control reset/);
	assert.deepEqual(f.errors, []);
});

test("off and on reach the task and lane hosts without a re-handshake", async (t) => {
	// The producers hold one host each for the life of the attachment, so the switch has to be readable
	// through that host rather than delivered as a new one.
	const hosts = { tasks: [], multiloop: [] };
	const capture = {
		name: "capture-producer-hosts",
		factory(pi) {
			for (const [channel, into] of [
				["jouzu:task-flow", hosts.tasks],
				["jouzu:multiloop-flow", hosts.multiloop],
			])
				pi.events.on(channel, (request) => {
					const accept = request.accept;
					request.accept = (host) => {
						into.push(host);
						accept(host);
					};
				});
		},
	};
	const f = await assembledSession(t, {
		producerExtensions: [
			capture,
			...(await installedProducerExtensions()),
			await installedTaskExtension(join(await mkdtemp(join(tmpdir(), "jouzu-spigot-tasks-")), "tasks.json")),
		],
	});
	await f.session.prompt("hello");
	assert.ok(hosts.tasks.length, "the task store takes its host at attach");
	assert.ok(hosts.multiloop.length, "and so does the loaded multiloop");
	const live = () => [...hosts.tasks, ...hosts.multiloop].map((host) => host.live());
	assert.deepEqual(live(), [true, true], "flow control is on by default");

	await f.session.prompt("/flow off");
	assert.deepEqual(live(), [false, false], "off reaches both hosts, which is what stops flow routing");
	await f.session.prompt("/flow on");
	assert.deepEqual(live(), [true, true], "and on reaches the same hosts again");
	assert.deepEqual(f.errors, []);
});

test("flow control off releases the background delivery lease so the task extension delivers its own batches", async (t) => {
	const f = await assembledSession(t, { producerExtensions: await installedProducerExtensions() });
	const attachment = f.ingress.branch().attachment;
	const attached = () => attachment.waitProducers.attachedNamespaces();
	assert.deepEqual(attached(), ["bg"], "the background wait source is attached while flow control is on");
	await f.session.prompt("/flow off");
	assert.deepEqual(
		attached(),
		[],
		"turning flow control off closes the source, which is what releases the extension's delivery lease",
	);
	await f.session.prompt("/flow on");
	assert.deepEqual(
		attached(),
		["bg"],
		"turning it back on re-acquires the lease on the same attachment, with no re-handshake",
	);
	assert.equal(f.ingress.branch().attachment, attachment, "and the branch is never torn down");
	assert.deepEqual(f.errors, []);
});
