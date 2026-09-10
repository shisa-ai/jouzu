import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FlowModelInput } from "../dist/flow-control/model-input.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { buildFlowResultEnvelope } from "../dist/flow-control/result-envelope.js";

const member = (id, producer = "alpha", status = "success") => ({
	id,
	producer,
	execution: `exec-${id}`,
	revision: "1",
	status,
	title: `結果 ${id}`,
	reference: `result:${id}`,
	warnings: ["Review required"],
});
const options = (members, maxBytes = 4096) => ({
	attemptId: "attempt",
	// The envelope is the run's only member in these cases, which is the one shape that earns an
	// end-of-turn permission.
	runMembers: [],
	id: "batch",
	revision: "1",
	members,
	producerOrder: ["alpha", "beta"],
	maxBytes,
	retain: async () => `flow-results:${"a".repeat(64)}`,
});

test("aggregate samples failures first and rotates producers while preserving complete counts and review metadata", async () => {
	const members = [
		member("success", "beta"),
		...Array.from({ length: 20 }, (_, i) => member(`failure-${i}`, "alpha", "failure")),
		member("beta-failure", "beta", "failure"),
	];
	const { envelope, item, bytes } = await buildFlowResultEnvelope(options(members, 2200));
	assert.deepEqual(
		envelope.sample.slice(0, 2).map((item) => item.producer),
		["alpha", "beta"],
	);
	assert.ok(envelope.sample.every((item) => item.status === "failure"));
	assert.deepEqual(envelope.counts, { success: 1, failure: 21, cancelled: 0 });
	assert.equal(envelope.total, 22);
	assert.equal(envelope.omitted, 22 - envelope.sample.length);
	assert.equal(envelope.warningResults, 22);
	assert.equal(envelope.reviewNote, "Completion does not imply review approval.");
	const input = FlowModelInput.compose("attempt", [item], 2200);
	assert.equal(bytes, Buffer.byteLength(JSON.stringify(input.content)));
	assert.equal(input.members.length, 22);
});

test("the end-of-turn permission is offered only to a run carrying results alone", async () => {
	const solo = await buildFlowResultEnvelope(options([member("result")], 4096));
	assert.match(JSON.parse(solo.item.text).noReply ?? "", /^[a-f0-9]{64}$/);
	for (const kind of ["work", "wait", "alert", "user"])
		assert.equal(
			JSON.parse(
				(await buildFlowResultEnvelope({ ...options([member("result")], 4096), runMembers: [{ kind }] })).item.text,
			).noReply,
			undefined,
			kind,
		);
});

test("mandatory metadata overflow fails before storing a manifest", async () => {
	let calls = 0;
	await assert.rejects(
		buildFlowResultEnvelope({
			...options([member("result")], 10),
			retain: async () => {
				calls++;
				return "invalid";
			},
		}),
		{ code: "capacity" },
	);
	assert.equal(calls, 0);
});

test("omitted metadata remains retrievable exactly from the retained Pi manifest", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-envelope-"));
	const attachment = await PiFlowAttachment.open(root, { sessionId: "session", branchId: "main" });
	t.after(async () => {
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	const members = Array.from({ length: 20 }, (_, i) =>
		member(`result-${i}`, i % 2 ? "alpha" : "beta", i % 3 ? "success" : "failure"),
	);
	const { envelope } = await buildFlowResultEnvelope({
		...options(members, 1400),
		retain: (items) => attachment.results.retain(items),
	});
	assert.ok(envelope.omitted > 0);
	const page = await attachment.results.page(envelope.manifest, { limit: 20, maxBytes: 16000 });
	assert.deepEqual(page.counts, envelope.counts);
	assert.equal(page.total, members.length);
	assert.deepEqual(new Set(page.members.map((item) => item.id)), new Set(members.map((item) => item.id)));
	assert.deepEqual((await attachment.ledger.snapshot()).attempts, []);
});

for (const count of [1, 20, 1024])
	for (const maxBytes of [4096, 8192])
		test(`complete UTF-8 aggregate stays within ${maxBytes} bytes for ${count} retained mixed results`, async (t) => {
			const members = Array.from({ length: count }, (_, i) => ({
				...member(`result-${i}`, i % 2 ? "alpha" : "beta", i % 3 ? "success" : "failure"),
				title: `結果 ${"検証".repeat(40)} ${i}`,
				reference: `result:${"x".repeat(300)}:${i}`,
				warnings: ["Review required", "子の出力は未承認"],
			}));
			const { item, bytes, envelope } = await buildFlowResultEnvelope(options(members, maxBytes));
			assert.ok(bytes <= maxBytes);
			assert.equal(envelope.omitted + envelope.sample.length, count);
			assert.equal(item.resultManifest.members.length, count);
			assert.ok(envelope.sample.every((item) => item.warnings.length === 2));
			t.diagnostic(
				JSON.stringify({ count, maxBytes, bytes, sampled: envelope.sample.length, omitted: envelope.omitted }),
			);
		});
