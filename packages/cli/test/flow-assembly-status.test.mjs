import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantToolCalls } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { assembledSession, capturedNotices, installedProducerExtensions } from "./fixtures/flow-assembly.mjs";
import { campaignScript, liveWait } from "./fixtures/flow-campaign.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));
// The envelope is JSON inside a text part inside a request body, so the key arrives multiply
// escaped. Match the key and its token rather than a fixed escaping depth.
const offered = (text) => /noReply[\\":]+[a-f0-9]{64}/.test(text);
const permissionFrom = (text) => text.match(/noReply[\\":]+([a-f0-9]{64})/)?.[1];

test("the status command reads and repairs holds without reaching the model", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: campaignScript({ goal: "Report status" }),
	});
	await f.session.prompt("start the sweep and wait");
	const wait = await liveWait(f.ingress, "the campaign leaves one live wait");
	const blocked = f.bodies.length;

	// Pi dispatches an extension command inside prompt, so this is the real user path.
	await f.session.prompt("/flow");
	await settle();
	assert.equal(f.bodies.length, blocked, "reading status sends no request and adds no model context");

	await f.session.prompt(`/flow cancel ${wait.token}`);
	const cancelled = (await f.ingress.branch().attachment.waits.snapshot()).find(
		(record) => record.token === wait.token,
	);
	assert.equal(cancelled?.state, "cancelled", "the wait is cancelled, with its reason recorded");
	assert.match(cancelled.cancellationReason ?? "", /\/flow/);
	await settle();
	assert.equal(f.bodies.length, blocked, "and cancelling it sends no request either");
	const live = (await f.ingress.branch().attachment.waits.snapshot()).filter((record) => record.state === "waiting");
	assert.deepEqual(live, [], "no live wait remains");

	// The campaign work outlives its wait: cancelling a gate does not complete or retire the work.
	const authority = await f.ingress.branch().attachment.waits.authoritySnapshot();
	assert.ok(
		authority.work.some((record) => record.id === wait.workId),
		"the owning work stays registered",
	);
	assert.deepEqual(f.errors, []);
});

test("the status command refuses unknown targets and states what it accepts", async (t) => {
	const f = await assembledSession(t, { producerExtensions: await installedProducerExtensions() });
	const before = f.bodies.length;
	await f.session.prompt("/flow retry no-such-request");
	await f.session.prompt("/flow cancel no-such-token");
	await f.session.prompt("/flow explode something");
	await f.session.prompt("/flow cancel one two");
	await settle();
	assert.equal(f.bodies.length, before, "a rejected control still sends nothing");
	// Command failures are reported to the user, never raised through the runtime's error channel.
	assert.deepEqual(f.errors, []);
});

test("a lane from an earlier session in the same process does not break the next one", async (t) => {
	const producers = await installedProducerExtensions();
	const first = await assembledSession(t, { producerExtensions: producers, script: campaignScript({ goal: "One" }) });
	await first.session.prompt("start the sweep and wait");
	await liveWait(first.ingress, "the first session leaves a live campaign");
	assert.deepEqual(first.errors, []);

	// The loaded multiloop instance outlives one session, so the next session sees its lane inventory
	// and its continuations while holding no campaign work for them.
	const next = await assembledSession(t, { producerExtensions: producers });
	await next.session.prompt("hello");
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.deepEqual(next.errors, [], "the unaccountable lane does not fail the session's producer");
	const sent = next.bodies.map((body) => JSON.stringify(body.messages));
	assert.equal(sent.length, 1, "and no continuation is sent for it");
	assert.ok(sent[0].includes("hello"));
});

test("status names an active campaign, so pause and stop have a target without a wait", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: campaignScript({ goal: "Name the target" }),
	});
	await f.session.prompt("start the sweep and wait");
	const wait = await liveWait(f.ingress, "the campaign is live");

	// Cancelling the gate leaves the campaign registered with no wait: the state in which its
	// identity used to appear nowhere a user could read it.
	await f.session.prompt(`/flow cancel ${wait.token}`);
	await settle();
	assert.deepEqual(
		(await f.ingress.branch().attachment.waits.snapshot()).filter((record) => record.state === "waiting"),
		[],
		"no live wait remains to carry the work identity",
	);

	const notices = capturedNotices(f.session);
	const requests = f.bodies.length;
	await f.session.prompt("/flow");
	await settle();
	assert.equal(f.bodies.length, requests, "listing work still sends no request");
	const listed = notices.map((notice) => notice.text).join("\n");
	assert.match(listed, /Active work\n- multiloop /, "the campaign is listed with its owner");
	assert.ok(listed.includes(wait.workId), "and with the identity the controls take");
	const target = listed.match(/pause with: \/flow pause (\S+)$/m)?.[1];
	assert.equal(target, wait.workId, "the printed control names that identity");

	// The printed command is the one that works: copied verbatim, it holds the campaign.
	await f.session.prompt(`/flow pause ${target}`);
	await settle();
	assert.equal(
		(await f.ingress.branch().attachment.waits.authoritySnapshot()).work.find((record) => record.id === target)
			?.lifecycle?.state,
		"paused",
	);
	assert.deepEqual(f.errors, []);
});

test("a lifecycle control aimed at unknown work says where the identities are", async (t) => {
	const f = await assembledSession(t, { producerExtensions: await installedProducerExtensions() });
	const notices = capturedNotices(f.session);
	await f.session.prompt("/flow stop no-such-work");
	await settle();
	assert.deepEqual(notices, [
		{ text: "No registered work no-such-work. Run /flow to list active work.", level: "error" },
	]);
	assert.deepEqual(f.errors, []);
});

test("pausing a campaign holds its turns and resuming releases them", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: campaignScript({ command: "sleep 0.3 && echo swept", goal: "Pause and resume" }),
	});
	await f.session.prompt("start the sweep and wait");
	const wait = await liveWait(f.ingress, "the campaign is live");

	await f.session.prompt(`/flow pause ${wait.workId}`);
	await settle();
	const paused = (await f.ingress.branch().attachment.waits.authoritySnapshot()).work.find(
		(record) => record.id === wait.workId,
	);
	assert.equal(paused?.lifecycle?.state, "paused");
	assert.match(paused.lifecycle.reason, /\/flow/);
	// Pausing holds automated turns; it does not cancel the wait or stop the job.
	assert.equal((await f.ingress.branch().attachment.waits.snapshot())[0].state, "waiting");
	const held = f.bodies.length;
	await new Promise((resolve) => setTimeout(resolve, 900));
	assert.equal(f.bodies.length, held, "a paused campaign produces no automated turn when its job ends");

	await f.session.prompt(`/flow resume ${wait.workId}`);
	await settle();
	assert.equal(
		(await f.ingress.branch().attachment.waits.authoritySnapshot()).work.find((r) => r.id === wait.workId)?.lifecycle
			?.state,
		"active",
	);
	assert.deepEqual(f.errors, []);
});

test("stopping a campaign cancels its waits and refuses a second transition", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: campaignScript({ goal: "Stop it" }),
	});
	await f.session.prompt("start the sweep and wait");
	const wait = await liveWait(f.ingress, "the campaign is live");

	await f.session.prompt(`/flow stop ${wait.workId}`);
	await settle();
	// Stopping cancels the work's live waits, and idle maintenance then retires the ended records, so
	// the observable end state is that no gate remains for it.
	assert.deepEqual(await f.ingress.branch().attachment.waits.snapshot(), [], "stopping work ends the gate it owns");
	const stopped = (await f.ingress.branch().attachment.waits.authoritySnapshot()).work.find(
		(record) => record.id === wait.workId,
	);
	assert.equal(stopped?.lifecycle?.state, "stopped");

	// Stopped work is terminal: pausing or resuming it afterwards is refused rather than silently
	// reopening a retired campaign.
	await assert.rejects(f.ingress.changeWorkStatus(wait.workId, "paused", "late"), { code: "transition" });
	await assert.rejects(f.ingress.changeWorkStatus(wait.workId, "active", "late"), { code: "transition" });
	await assert.rejects(f.ingress.changeWorkStatus("no-such-work", "paused", "late"), { code: "identity" });
	// Repeating the same state is a no-op rather than an error, so the control is idempotent.
	assert.equal((await f.ingress.changeWorkStatus(wait.workId, "stopped", "again")).lifecycle.state, "stopped");
	assert.deepEqual(f.errors, []);
});

test("a result-only wake offers no-reply and a mixed wake does not", async (t) => {
	// No lane and no wait: the job's terminal result is the only thing the wake carries, which is
	// the one shape the contract lets the model end without replying.
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: (_body, index) =>
			index === 0
				? assistantToolCalls({ name: "bg_task", arguments: { action: "spawn", command: "sleep 0.3 && echo swept" } })
				: { text: `turn ${index}` },
	});
	await f.session.prompt("run the sweep in the background");
	const deadline = Date.now() + 6000;
	let offer;
	while (Date.now() < deadline && !offer) {
		offer = f.bodies.map((body) => JSON.stringify(body.messages)).find((text) => offered(text));
		if (!offer) await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(offer, "a result-only wake offers a run-bound permission");
	assert.ok(f.session.getActiveToolNames().includes("agent_no_reply"), "the tool is registered alongside the offer");
	assert.deepEqual(f.errors, []);
});

test("a wake carrying a wait decision and lane work offers no permission", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: campaignScript({ command: "sleep 0.3 && echo swept", goal: "Owed a reply" }),
	});
	await f.session.prompt("start the sweep and wait");
	const deadline = Date.now() + 5000;
	let wake;
	while (Date.now() < deadline && !wake) {
		wake = f.bodies.map((body) => JSON.stringify(body.messages)).find((text) => text.includes('kind\\":\\"wait'));
		if (!wake) await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(wake, "the composed wake was delivered");
	// It carries a wait decision and a lane continuation, both of which the model was asked to act
	// on, so no permission is offered anywhere in it.
	assert.equal(offered(wake), false);
	assert.deepEqual(f.errors, []);
});

test("the model ends a result-only turn with the permission its result carried", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: (body, index) => {
			if (index === 0)
				return assistantToolCalls({
					name: "bg_task",
					arguments: { action: "spawn", command: "sleep 0.3 && echo swept" },
				});
			// The wake carries the run's own permission; using it is the only silent exit.
			const permission = permissionFrom(JSON.stringify(body.messages));
			return permission
				? assistantToolCalls({ name: "agent_no_reply", arguments: { permission } })
				: { text: `turn ${index}` };
		},
	});
	await f.session.prompt("run the sweep in the background");
	const deadline = Date.now() + 8000;
	let ending;
	while (Date.now() < deadline && !ending) {
		const last = f.session.messages.at(-1);
		if (last?.role === "toolResult" && last.toolName === "agent_no_reply") ending = last;
		else await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(ending, "the tool ran and left a visible result rather than ending invisibly");
	assert.equal(ending.isError, false);
	assert.match(JSON.stringify(ending.content), /without a reply/);
	// Termination skips the follow-up model call, so the wake that carried the permission is the
	// last request the run makes: nothing follows the terminating tool result.
	const requests = f.bodies.length;
	await new Promise((resolve) => setTimeout(resolve, 700));
	assert.equal(f.bodies.length, requests, "no request follows the terminating tool call");
	// The run settles rather than leaking an attempt that stays active.
	const settled = Date.now() + 3000;
	while (Date.now() < settled && (await f.ingress.branch().attachment.ledger.snapshot()).activeAttemptId !== undefined)
		await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal((await f.ingress.branch().attachment.ledger.snapshot()).activeAttemptId, undefined);
	assert.deepEqual(f.errors, []);
});

test("a permission the run did not offer is refused and the turn continues", async (t) => {
	let forged = false;
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: (body, index) => {
			if (index === 0)
				return assistantToolCalls({
					name: "bg_task",
					arguments: { action: "spawn", command: "sleep 0.3 && echo swept" },
				});
			// A well-formed token from some other run: validation, not format, is what refuses it. The
			// envelope stays in context after the refusal, so the forged call is issued exactly once.
			if (!forged && permissionFrom(JSON.stringify(body.messages))) {
				forged = true;
				return assistantToolCalls({ name: "agent_no_reply", arguments: { permission: "0".repeat(64) } });
			}
			return { text: `turn ${index}` };
		},
	});
	await f.session.prompt("run the sweep in the background");
	const deadline = Date.now() + 8000;
	let refusal;
	while (Date.now() < deadline && !refusal) {
		refusal = f.session.messages.find(
			(message) => message.role === "toolResult" && message.toolName === "agent_no_reply",
		);
		if (!refusal) await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(refusal, "the forged permission was executed and answered");
	assert.equal(refusal.isError, true, "a foreign token is refused rather than trusted");
	assert.match(JSON.stringify(refusal.content), /Answer this turn instead/);
	// The refusal did not end the turn: the model was asked again and answered in prose.
	const answered = Date.now() + 5000;
	while (Date.now() < answered && f.bodies.length < 3) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.ok(f.bodies.length >= 3, "a follow-up request follows the refusal");
	const last = f.session.messages.at(-1);
	assert.equal(last?.role, "assistant", "the model replied instead of going silent");
	assert.deepEqual(f.errors, []);
});
