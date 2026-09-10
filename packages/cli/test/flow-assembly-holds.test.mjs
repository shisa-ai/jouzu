import assert from "node:assert/strict";
import { test } from "node:test";
import { assembledSession, installedProducerExtensions, syntheticProducer } from "./fixtures/flow-assembly.mjs";
import { campaignScript, liveWait } from "./fixtures/flow-campaign.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a settled descriptor is fenced against replay, and the fence outlives its attempt", async (t) => {
	const f = await assembledSession(t);
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	await registration.changed();
	await settle();
	assert.equal(f.bodies.length, 1);
	const state = await f.ingress.branch().attachment.ledger.snapshot();
	assert.equal(state.attempts.length, 1);

	// The producer offers the same descriptor again after its attempt settled.
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	await registration.changed();
	await settle();
	assert.equal(f.bodies.length, 1, "the settled revision is fenced, not resurrected");

	// Retiring the attempt must keep that fence.
	await f.ingress.retireLedgerHistory(0);
	assert.deepEqual((await f.ingress.branch().attachment.ledger.snapshot()).attempts, []);
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	await registration.changed();
	await settle();
	assert.equal(f.bodies.length, 1, "the fence survives retirement");
});

test("cancelling an already dispatched submission is refused with the correct control named", async (t) => {
	const f = await assembledSession(t);
	await f.session.prompt("first");
	assert.equal(f.bodies.length, 1);
	const [record] = await f.ingress.branch().attachment.submissions.snapshot();
	assert.equal(record.status, "retained");
	// A returned submission is already consumed; cancelling it is refused with a reason that names
	// the correct control rather than silently succeeding.
	await assert.rejects(
		f.ingress.cancelRetained(record.id, record.revision),
		(error) => error.code === "transition" && /native queue or request cancellation/.test(error.message),
	);
	assert.equal(f.bodies.length, 1);
});

test("ledger retirement is refused while controller work is active", async (t) => {
	const f = await assembledSession(t);
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());
	let release;
	synthetic.state.buildGate = new Promise((resolve) => {
		release = resolve;
	});
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	const scheduling = registration.changed();
	await settle();
	// Mid-build the attempt is reserved, so retirement must not run against a moving ledger.
	await assert.rejects(f.ingress.retireLedgerHistory(0), (error) => ["busy", "stale"].includes(error.code));
	release();
	await scheduling;
	await settle();
	assert.equal(f.bodies.length, 1);
});

test("a blocked lane holds its continuation across idle maintenance", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: campaignScript({ goal: "Hold across maintenance" }),
	});
	await f.session.prompt("start the sweep and wait");
	const wait = await liveWait(f.ingress, "the lane is blocked on one live wait");
	const before = f.bodies.length;

	// Idle maintenance runs the full retirement pass; it must not release held work or the wait.
	for (const retire of [
		() => f.ingress.retireWaitHistory(true),
		() => f.ingress.archiveSubmissionHistory(),
		() => f.ingress.retireRequestHistory(),
		() => f.ingress.retireLedgerHistory(),
		() => f.ingress.retireResultHistory(),
	]) {
		const deadline = Date.now() + 5000;
		for (;;) {
			try {
				await retire();
				break;
			} catch (error) {
				if (!["stale", "busy"].includes(error.code) || Date.now() >= deadline) throw error;
				await settle();
			}
		}
	}
	await settle();

	assert.equal(f.bodies.length, before, "maintenance sends no continuation for the blocked lane");
	const held = await liveWait(f.ingress, "the wait is still live after maintenance");
	assert.equal(held.token, wait.token, "maintenance neither retires nor reissues the live wait");
	assert.equal(held.expiresAt, wait.expiresAt, "and does not restart its deadline");
	const work = (await f.ingress.branch().attachment.waits.authoritySnapshot()).work;
	assert.ok(
		work.some((record) => record.id === wait.workId && record.owner === "multiloop"),
		"the campaign work it depends on is not retired underneath it",
	);
	assert.deepEqual(f.errors, []);
});

test("a producer whose descriptor changes after retirement is admitted once", async (t) => {
	const f = await assembledSession(t);
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	await registration.changed();
	await settle();
	await f.ingress.retireLedgerHistory(0);
	synthetic.offer([{ id: "intent-1", revision: "2" }]);
	await registration.changed();
	await settle();
	assert.equal(f.bodies.length, 2, "a new revision runs after retirement");
	assert.deepEqual(synthetic.state.builds, ["intent-1", "intent-1"]);
	// And the new revision is itself fenced afterwards.
	synthetic.offer([{ id: "intent-1", revision: "2" }]);
	await registration.changed();
	await settle();
	assert.equal(f.bodies.length, 2);
});

const until = async (predicate, label, timeoutMs = 5000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`timed out waiting for ${label}`);
};
const carrying = (bodies, text) => bodies.filter((body) => JSON.stringify(body.messages).includes(text)).length;

test("a provider retry holds automated work and the held work runs once afterwards", async (t) => {
	let failures = 0;
	const f = await assembledSession(t, {
		settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 500 } },
		script: (_body, index) => {
			if (index === 0) {
				failures++;
				return { httpStatus: 503 };
			}
			return { text: `turn ${index}` };
		},
	});
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());

	const prompted = f.session.prompt("user work that fails once");
	await until(() => f.session.isRetrying, "the host to enter its retry backoff");

	// Both paths are offered mid-retry: a producer descriptor and an unadapted extension-style send.
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	const scheduling = registration.changed();
	const note = f.session.sendCustomMessage("background note", { triggerTurn: true });
	let heldSend = false;
	while (f.session.isRetrying) {
		assert.equal(carrying(f.bodies, "work intent-1"), 0, "no producer work is sent while the host retries");
		assert.equal(carrying(f.bodies, "background note"), 0, "no unadapted send is dispatched while the host retries");
		const records = await f.ingress.branch().attachment.submissions.snapshot();
		const retained = records.find((record) => record.submission.api === "sendCustomMessage");
		heldSend ||= Boolean(retained?.holds?.length);
		await settle();
	}
	assert.ok(heldSend, "the unadapted send is retained under a recorded hold rather than dropped");

	await prompted;
	await scheduling;
	await note;
	assert.equal(failures, 1, "the fixture failed exactly once");
	await until(() => carrying(f.bodies, "work intent-1") === 1, "the held producer work to run after the retry");
	await settle();
	assert.equal(carrying(f.bodies, "work intent-1"), 1, "and to run exactly once");
	assert.deepEqual(synthetic.state.builds, ["intent-1"]);
});

test("compaction holds automated work and the held work runs once afterwards", async (t) => {
	let releaseSummary;
	const summarizing = new Promise((resolve) => {
		releaseSummary = resolve;
	});
	const summaryIndexes = [];
	const f = await assembledSession(t, {
		// One recent entry is kept, so two turns are enough to give manual compaction something to do.
		settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
		script: (body, index) => {
			// Compaction issues its own summarization requests, which carry no tools and their own
			// system prompt; hold the first open so isCompacting stays true.
			if (!body.tools?.length && body.messages?.[0]?.content?.startsWith?.("You are a context summarization")) {
				summaryIndexes.push(index);
				return summarizing.then(() => ({ text: "summary" }));
			}
			return { text: `turn ${index}` };
		},
	});
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());
	await f.session.prompt("first");
	await f.session.prompt("second");
	const beforeCompaction = f.bodies.length;

	const compacted = f.session.compact();
	await until(() => f.session.isCompacting, "the host to start compacting");
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	const scheduling = registration.changed();
	// The summarization response is held open, so compaction stays in flight for this whole window.
	for (let attempt = 0; attempt < 20; attempt++) {
		assert.ok(f.session.isCompacting, "the held summarization keeps compaction in flight");
		assert.equal(carrying(f.bodies, "work intent-1"), 0, "no producer work is sent while the host compacts");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.deepEqual(summaryIndexes, [beforeCompaction], "compaction's own request is the only one it sends");

	releaseSummary();
	await compacted;
	await scheduling;
	await until(() => carrying(f.bodies, "work intent-1") === 1, "the held producer work to run after compaction");
	await settle();
	assert.equal(carrying(f.bodies, "work intent-1"), 1, "and to run exactly once");

	// Compaction is Pi's own request, so it is recorded without claiming any retained submission.
	const requests = await f.ingress.branch().attachment.nativeRequests.snapshot();
	const summary = requests.filter((request) => request.kind === "maintenance");
	// This conversation splits a turn, so compaction summarizes twice; each call gets one receipt.
	assert.equal(summary.length, summaryIndexes.length, "every summarization is recorded as a maintenance receipt");
	assert.ok(summaryIndexes.length >= 1);
	for (const record of summary) {
		assert.equal(record.outcome, "success");
		assert.ok(record.payload?.bytes > 0, "its exact final payload is observed");
		assert.equal(record.sourceCapture, undefined, "and it establishes no source membership");
	}
});

test("a provider call outside compaction is still refused without a request checkpoint", async (t) => {
	const f = await assembledSession(t);
	const before = f.bodies.length;
	await assert.rejects(
		f.session.agent.streamFunction(f.runtime.getModel("fixture", "fixture"), {
			systemPrompt: "probe",
			messages: [{ role: "user", content: [{ type: "text", text: "unchecked" }] }],
			tools: [],
		}),
		(error) => error.code === "identity" && /no request checkpoint/.test(error.message),
	);
	assert.equal(f.bodies.length, before, "and the transport is never reached");
});

test("a result manifest is retired only once its reference leaves the model's context", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		// One recent entry is kept, so compaction has something to drop after a few turns.
		settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
		script: (body, index) =>
			!body.tools?.length && body.messages?.[0]?.content?.startsWith?.("You are a context summarization")
				? { text: "summary" }
				: campaignScript({ command: "sleep 0.3 && echo swept" })(body, index),
	});
	await f.session.prompt("start the sweep and wait");
	// The composed wake carries a result manifest, and its reference lands in the model's context.
	await until(
		() => f.bodies.some((body) => JSON.stringify(body.messages).includes("flow-results:")),
		"a delivered result manifest reference",
	);
	// The idle boundary is contended right after a wake, so retire on the same terms the launcher
	// does: retry briefly while the host reports busy rather than asserting on one attempt.
	const retire = async () => {
		const deadline = Date.now() + 5000;
		for (;;) {
			try {
				return await f.ingress.retireResultHistory(1);
			} catch (error) {
				if (!["busy", "stale"].includes(error.code) || Date.now() >= deadline) throw error;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
	};
	const referenced = JSON.stringify(f.session.messages).match(/flow-results:[a-f0-9]{64}/g) ?? [];
	assert.ok(referenced.length, "the manifest reference is in the live context, not only in a past request");
	// Two manifests nothing names give the referenced one candidates beside it. The referenced one is
	// the oldest, so a keep window of one would drop it first were it not protected.
	const orphan = (id) =>
		f.ingress.branch().attachment.results.retain([
			{
				id,
				producer: "bg",
				execution: `${id}-exec`,
				revision: "1",
				status: "success",
				title: id,
				reference: `bg-result:${id}`,
				warnings: [],
			},
		]);
	const first = await orphan("orphan-a");
	await orphan("orphan-b");

	// Retirement keeps it while the model could still page it with agent_results.
	await retire();
	assert.ok(
		JSON.stringify(f.session.messages).includes(referenced[0]),
		"the reference is still in context after maintenance",
	);
	const page = await f.ingress.branch().attachment.results.page(referenced[0], { limit: 8, maxBytes: 20_000 });
	assert.ok(page.total > 0, "and the manifest it names is still readable");
	// An unreferenced manifest went in that same pass, so the keep window is not what saved the other.
	await assert.rejects(f.ingress.branch().attachment.results.page(first, { limit: 8, maxBytes: 20_000 }), {
		code: "identity",
	});

	// Compaction drops the message carrying it, and only then may the manifest go.
	await f.session.prompt("second");
	await f.session.compact();
	assert.equal(
		JSON.stringify(f.session.messages).includes(referenced[0]),
		false,
		"compaction removed the reference from context",
	);
	await retire();
	await assert.rejects(
		f.ingress.branch().attachment.results.page(referenced[0], { limit: 8, maxBytes: 20_000 }),
		{ code: "identity" },
		"a manifest the model can no longer name is retired",
	);
	assert.deepEqual(f.errors, []);
});

test("a manifest for results still pending with their producer is not retired unread", async (t) => {
	const f = await assembledSession(t, { producerExtensions: await installedProducerExtensions() });
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());
	// The result is pending but not yet deliverable, so no wake has carried its reference into the
	// model's context. Its manifest exists only in the store, which is exactly the shape whose
	// retirement would make it unavailable to agent_results before anyone read it.
	synthetic.offer([{ id: "intent", revision: "1", rank: 6, runnable: false }]);
	await registration.changed();
	const results = f.ingress.branch().attachment.results;
	const reference = (id, producer) =>
		results.retain([
			{
				id,
				producer,
				execution: `${id}-exec`,
				revision: "1",
				status: "success",
				title: id,
				reference: `${producer}-result:${id}`,
				warnings: [],
			},
		]);
	// The pending result's manifest is the oldest, so a keep window of one would drop it first were
	// it not protected; the two orphans nothing names sit beside it as candidates.
	const pending = await reference("intent", "synthetic");
	const first = await reference("orphan-a", "synthetic");
	await reference("orphan-b", "synthetic");
	// The idle boundary is contended right after a producer change, so retire on the same terms
	// the launcher does: retry briefly while the host reports busy.
	const retire = async () => {
		const deadline = Date.now() + 5000;
		for (;;) {
			try {
				return await f.ingress.retireResultHistory(1);
			} catch (error) {
				if (!"busy".includes(error.code ?? "") || Date.now() >= deadline) throw error;
				await settle();
			}
		}
	};
	await retire();
	assert.equal(
		(await results.page(pending, { limit: 8, maxBytes: 20_000 })).total,
		1,
		"the unread result keeps its manifest",
	);
	await assert.rejects(
		results.page(first, { limit: 8, maxBytes: 20_000 }),
		{
			code: "identity",
		},
		"an unreferenced manifest with no pending result was retired in the same pass",
	);
	assert.deepEqual(f.errors, []);
});

test("a composed wake is recorded as notification-only", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: campaignScript({ command: "sleep 0.3 && echo swept" }),
	});
	await f.session.prompt("start the sweep and wait");
	await until(
		() => f.bodies.some((body) => JSON.stringify(body.messages).includes('kind\\":\\"wait')),
		"the composed wake to be delivered",
	);
	const requests = await f.ingress.branch().attachment.nativeRequests.snapshot();
	const ledger = await f.ingress.branch().attachment.ledger.snapshot();
	const flagged = new Map(
		ledger.attempts.flatMap((attempt) => attempt.requests.map((request) => [request.id, request.containsUserInput])),
	);
	assert.ok(flagged.size, "the ledger recorded per-request input evidence");

	// Only controller-composed runs reach the ledger; a native user prompt dispatches without an
	// attempt. Every composed run here is a wake carrying no instruction, so each must be recorded
	// notification-only. The launcher previously recorded them all as carrying user input, which
	// withholds no-reply permission unconditionally.
	const recorded = requests.filter((request) => flagged.has(request.id));
	assert.ok(recorded.length, "the composed wake reached the ledger");
	assert.deepEqual(
		recorded.map((request) => flagged.get(request.id)),
		recorded.map(() => false),
	);
	assert.deepEqual(f.errors, []);
});
