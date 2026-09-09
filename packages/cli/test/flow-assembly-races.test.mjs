import assert from "node:assert/strict";
import { test } from "node:test";
import { assembledSession, syntheticProducer } from "./fixtures/flow-assembly.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a synthetic producer reaches the model without any plugin-specific admission branch", async (t) => {
	const f = await assembledSession(t);
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	await registration.changed();
	await settle();
	assert.deepEqual(synthetic.state.builds, ["intent-1"]);
	assert.equal(f.bodies.length, 1);
	assert.ok(JSON.stringify(f.bodies[0].messages).includes("work intent-1"));
	const requests = await f.ingress.branch().attachment.nativeRequests.snapshot();
	assert.equal(requests.length, 1);
	assert.equal(requests[0].outcome, "success");
});

test("an unchanged descriptor is not admitted twice", async (t) => {
	const f = await assembledSession(t);
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	await registration.changed();
	await settle();
	// The producer repeats the same descriptor; a receipt already covers it.
	await registration.changed();
	await settle();
	assert.deepEqual(synthetic.state.builds, ["intent-1"]);
	assert.equal(f.bodies.length, 1);
	// A new revision is separate work and is admitted.
	synthetic.offer([{ id: "intent-1", revision: "2" }]);
	await registration.changed();
	await settle();
	assert.deepEqual(synthetic.state.builds, ["intent-1", "intent-1"]);
	assert.equal(f.bodies.length, 2);
});

test("user input arriving during producer selection preempts the attempt and is sent first", async (t) => {
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
	assert.deepEqual(synthetic.state.builds, ["intent-1"], "the producer is mid-build");
	// The user prompts while the automated attempt is still being composed.
	const prompted = f.session.prompt("user wins");
	await settle();
	release();
	await scheduling;
	await prompted;
	await settle();

	// Request order, not mere presence: the user's turn must reach the model before the automated one.
	const sent = f.bodies.map((body) => JSON.stringify(body.messages));
	const user = sent.findIndex((body) => body.includes("user wins"));
	const automated = sent.findIndex((body) => body.includes("work intent-1"));
	assert.notEqual(user, -1, "the user instruction reached the model");
	assert.notEqual(automated, -1, "the preempted work is re-admitted rather than dropped");
	assert.ok(user < automated, "the user's request is sent first");
	assert.equal(sent.filter((body) => body.includes("work intent-1")).length, 1, "and the work is sent once");

	// The controller's own record of the preemption: the reserved attempt is cancelled, then retried.
	const attempts = (await f.ingress.branch().attachment.ledger.snapshot()).attempts;
	const preempted = attempts.find((attempt) => attempt.phase === "cancelled");
	assert.ok(preempted, "the in-flight attempt is cancelled rather than dispatched behind the user");
	assert.match(preempted.reason, /changed before enqueue/);
	assert.ok(
		attempts.some((attempt) => attempt.phase === "settled" && attempt.consumed),
		"a later attempt carries the same work to the model",
	);
	const requests = await f.ingress.branch().attachment.nativeRequests.snapshot();
	assert.ok(requests.every((request) => request.outcome !== "failure"));
});

test("a producer that fails to build does not bypass admission or block user work", async (t) => {
	const f = await assembledSession(t);
	const synthetic = syntheticProducer();
	synthetic.producer.build = async () => {
		throw new Error("producer build failed");
	};
	const registration = f.ingress.registerProducer(synthetic.producer);
	t.after(() => registration.dispose());
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	await registration.changed().catch(() => {});
	await settle();
	assert.equal(f.bodies.length, 0, "a failed build sends nothing");
	await f.session.prompt("still works");
	assert.equal(f.bodies.length, 1);
	assert.ok(JSON.stringify(f.bodies[0].messages).includes("still works"));
});

test("a disposed producer stops reaching the model", async (t) => {
	const f = await assembledSession(t);
	const synthetic = syntheticProducer();
	const registration = f.ingress.registerProducer(synthetic.producer);
	synthetic.offer([{ id: "intent-1", revision: "1" }]);
	await registration.changed();
	await settle();
	assert.equal(f.bodies.length, 1);
	registration.dispose();
	synthetic.offer([{ id: "intent-2", revision: "1" }]);
	await f.ingress.wakeProducers();
	await settle();
	assert.equal(f.bodies.length, 1, "a disposed producer cannot dispatch");
	assert.deepEqual(synthetic.state.builds, ["intent-1"]);
});
