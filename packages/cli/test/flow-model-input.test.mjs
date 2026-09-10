import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assistant, createFlowSession } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { FlowModelInput, prepareFlowModelInput, validateFlowToolOrder } from "../dist/flow-control/model-input.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { PiQueueReceipts } from "../dist/flow-control/pi-queue-receipts.js";
import { buildFlowResultEnvelope } from "../dist/flow-control/result-envelope.js";

const item = (id, kind = "result", text = "same") => ({ id, revision: "1", kind, text });
const user = (content) => ({ role: "user", content, timestamp: 1 });
const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

test("composition isolates identical text by attempt/member identity and ignores mutable snapshots", () => {
	const inputs = [item("first"), item("second")];
	const composition = FlowModelInput.compose("attempt", inputs, 4096);
	inputs[0].text = "caller changed";
	composition.content[0].text = "observer changed";
	composition.members[0].contentHash = "0".repeat(64);
	const content = composition.content;
	assert.notEqual(content[0].text, content[1].text);
	assert.deepEqual(
		composition.inspect([user(content.slice(1))]).map((entry) => entry.disposition),
		["omitted", "included"],
	);
	const newer = FlowModelInput.compose("other-attempt", [item("first")], 4096);
	assert.equal(newer.inspect([user(content)])[0].disposition, "omitted");
});

test("retained identity with changed text or missing image is replacement, not inclusion", () => {
	const composition = FlowModelInput.compose("attempt", [{ ...item("result"), images: [image] }], 4096);
	const changed = composition.content;
	const frame = JSON.parse(changed[0].text);
	frame.content = "changed by policy";
	changed[0].text = JSON.stringify(frame);
	assert.equal(composition.inspect([user(changed)])[0].disposition, "replaced");
	assert.equal(composition.inspect([user(composition.content.slice(0, 1))])[0].disposition, "replaced");
	assert.equal(composition.inspect([user(composition.content)])[0].disposition, "included");
	assert.equal(
		composition.inspect([user([...composition.content, ...composition.content])])[0].disposition,
		"rejected",
	);
});

test("complete composed UTF-8 text and images fit the declared cap without truncating work", () => {
	const inputs = [{ ...item("work", "work", "日本語"), images: [image] }];
	const composition = FlowModelInput.compose("attempt", inputs, 4096);
	assert.equal(composition.bytes, Buffer.byteLength(JSON.stringify(composition.content)));
	assert.throws(() => FlowModelInput.compose("attempt", inputs, composition.bytes - 1), { code: "capacity" });
	assert.doesNotThrow(() => FlowModelInput.compose("attempt", inputs, composition.bytes));
	assert.throws(() => FlowModelInput.compose("attempt", [item("duplicate"), item("duplicate")], 4096), {
		code: "identity",
	});
});

async function fixture(t, inputs, transform = (messages) => messages, blockImages = false) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-model-input-"));
	const composition = FlowModelInput.compose("attempt", inputs, 8192);
	let attachment;
	let checking = false;
	const checks = [];
	const { session, requests } = await createFlowSession(t, {
		checkpoints: {
			beforeRequest: async (input) => {
				if (!checking) return;
				checks.push(input);
				await prepareFlowModelInput(attachment.ledger, composition, input, false);
			},
		},
	});
	attachment = await PiFlowAttachment.open(root, { sessionId: session.sessionId, branchId: "main" });
	const receipts = new PiQueueReceipts(session.agent, attachment.ledger);
	t.after(async () => {
		receipts.close();
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	await session.prompt("initial");
	requests.length = 0;
	session.settingsManager.setBlockImages(blockImages);
	session._extensionRunner.emitContext = transform;
	await attachment.ledger.select("attempt", composition.members);
	await receipts.enqueue("attempt", () => {
		session.agent.followUp({
			role: "custom",
			customType: "flow",
			content: composition.content,
			display: false,
			details: { privateMembership: composition.members },
			timestamp: Date.now(),
		});
	});
	checking = true;
	await session.agent.continue();
	return { session, requests, checks, composition, state: await attachment.ledger.snapshot() };
}

for (const kind of ["result", "work", "wait"]) {
	test(`post-transform removal of ${kind} records exact disposition before any provider call`, async (t) => {
		const { requests, state } = await fixture(t, [item("first", kind), item("second")], (messages) =>
			messages.map((message) =>
				message.role === "custom" ? { ...message, content: message.content.slice(1) } : message,
			),
		);
		assert.deepEqual(
			state.attempts[0].requests[0].inclusion.map((entry) => entry.disposition),
			["omitted", "included"],
		);
		assert.equal(requests.length, kind === "result" ? 1 : 0);
		assert.equal(state.attempts[0].phase, kind === "result" ? "prepared" : "withheld");
	});
}

test("all filtered input withholds while history remains a separate fact", async (t) => {
	const { session, requests, state } = await fixture(t, [item("result")], (messages) =>
		messages.filter((message) => message.role !== "custom"),
	);
	assert.equal(requests.length, 0);
	assert.equal(state.attempts[0].phase, "withheld");
	assert.equal(state.attempts[0].history.length, 0);
	assert.ok(session.sessionManager.getBranch().some((entry) => entry.type === "custom_message"));
});

test("metadata removal cannot hide a content replacement or acknowledge it", async (t) => {
	const { requests, state } = await fixture(t, [item("first"), item("second")], (messages) =>
		messages.map((message) => {
			if (message.role !== "custom") return message;
			const content = structuredClone(message.content);
			const first = JSON.parse(content[0].text);
			first.content = "redacted";
			content[0].text = JSON.stringify(first);
			return { ...message, details: undefined, content };
		}),
	);
	assert.equal(requests.length, 1);
	assert.deepEqual(
		state.attempts[0].requests[0].inclusion.map((entry) => entry.disposition),
		["replaced", "included"],
	);
});

const call = () => ({ ...assistant(), content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] });
const result = () => ({
	role: "toolResult",
	toolCallId: "call",
	toolName: "read",
	content: [{ type: "text", text: "done" }],
	isError: false,
	timestamp: 1,
});
test("tool call/result validation accepts complete batches and rejects missing, duplicate, or mismatched relationships", () => {
	assert.doesNotThrow(() => validateFlowToolOrder([user("first"), call(), result(), user("next")]));
	assert.doesNotThrow(() => validateFlowToolOrder([call(), result(), call(), result()]));
	for (const messages of [
		[result()],
		[call()],
		[call(), user("interrupt"), result()],
		[call(), result(), result()],
		[call(), { ...result(), toolName: "write" }],
		[{ ...call(), content: [...call().content, ...call().content] }],
	])
		assert.throws(() => validateFlowToolOrder(messages), { code: "schema" });
});

test("an invalid transformed tool relationship durably rejects the composed request", async (t) => {
	const { requests, state } = await fixture(t, [item("work", "work")], (messages) => [...messages, result()]);
	assert.equal(requests.length, 0);
	assert.equal(state.attempts[0].phase, "withheld");
	assert.equal(state.attempts[0].requests[0].inclusion[0].disposition, "rejected");
});

test("native image conversion withholds required images before a provider invocation", async (t) => {
	const { requests, checks, state } = await fixture(t, [{ ...item("work", "work"), images: [image] }], undefined, true);
	assert.equal(requests.length, 0);
	assert.ok(
		checks[0].modelMessages
			.at(-1)
			.content.some((part) => part.type === "text" && part.text === "Image reading is disabled."),
	);
	assert.equal(state.attempts[0].requests[0].inclusion[0].disposition, "replaced");
	assert.equal(state.attempts[0].phase, "withheld");
});

test("malformed transformed content receives a durable rejection", async (t) => {
	const { requests, state } = await fixture(t, [item("work", "work")], (messages) =>
		messages.map((message) => (message.role === "custom" ? { ...message, content: null } : message)),
	);
	assert.equal(requests.length, 0);
	assert.equal(state.attempts[0].phase, "withheld");
	assert.equal(state.attempts[0].requests[0].inclusion[0].disposition, "rejected");
});

test("maximum member count preserves exact inclusion when one identical-text result is removed", () => {
	const composition = FlowModelInput.compose(
		"attempt",
		Array.from({ length: 1024 }, (_, i) => item(`result-${i}`)),
		1024 * 1024,
	);
	const content = composition.content;
	content.splice(512, 1);
	const inclusion = composition.inspect([user(content)]);
	assert.equal(inclusion.filter((entry) => entry.disposition === "included").length, 1023);
	assert.deepEqual(
		inclusion.filter((entry) => entry.disposition !== "included"),
		[{ id: "result-512", revision: "1", disposition: "omitted" }],
	);
});

test("a bounded aggregate represents 1024 retained results without serializing their IDs", () => {
	const members = Array.from({ length: 1024 }, (_, i) => ({ id: `result-${i}`, revision: "1" }));
	const composition = FlowModelInput.compose(
		"attempt",
		[
			{
				...item("batch", "result", "1024 completed results; inspect the manifest for full output."),
				resultManifest: { reference: "flow-results://batch", members },
			},
		],
		4096,
	);
	assert.equal(composition.members.length, 1024);
	assert.equal(composition.content.length, 1);
	assert.equal(composition.content[0].text.includes("result-1023"), false);
	const frame = JSON.parse(composition.content[0].text);
	assert.deepEqual(frame.results, { count: 1024, manifest: "flow-results://batch" });
	assert.ok(composition.inspect([user(composition.content)]).every((entry) => entry.disposition === "included"));
	for (const key of ["count", "manifest"]) {
		const changed = structuredClone(frame);
		delete changed.results[key];
		assert.ok(
			composition
				.inspect([user([{ type: "text", text: JSON.stringify(changed) }])])
				.every((entry) => entry.disposition === "replaced"),
		);
	}
});

test("aggregate membership cannot duplicate a result or relabel required work as optional", () => {
	const resultManifest = { reference: "flow-results://batch", members: [{ id: "first", revision: "1" }] };
	assert.throws(() => FlowModelInput.compose("attempt", [{ ...item("batch", "work"), resultManifest }], 4096), {
		code: "identity",
	});
	assert.throws(() => FlowModelInput.compose("attempt", [{ ...item("batch"), resultManifest }, item("first")], 4096), {
		code: "identity",
	});
});

test("context transformation cannot send an aggregate with altered mandatory counts", async (t) => {
	const { item: aggregate } = await buildFlowResultEnvelope({
		attemptId: "attempt",
		// The aggregate joins a run that already carries work, so no end-of-turn permission is offered.
		runMembers: [{ kind: "work" }],
		id: "batch",
		revision: "1",
		maxBytes: 4096,
		producerOrder: ["worker"],
		members: [
			{
				id: "result",
				producer: "worker",
				execution: "exec",
				revision: "1",
				status: "failure",
				title: "Failed",
				reference: "result:1",
				warnings: [],
			},
		],
		retain: async () => `flow-results:${"a".repeat(64)}`,
	});
	const { requests, state } = await fixture(t, [item("work", "work", "Do work"), aggregate], (messages) =>
		messages.map((message) => {
			if (message.role !== "custom") return message;
			const content = structuredClone(message.content);
			const frame = JSON.parse(content[1].text);
			const body = JSON.parse(frame.content);
			body.counts.failure = 0;
			frame.content = JSON.stringify(body);
			content[1].text = JSON.stringify(frame);
			return { ...message, content };
		}),
	);
	assert.equal(requests.length, 0);
	assert.equal(state.attempts[0].phase, "withheld");
	assert.deepEqual(
		state.attempts[0].requests[0].inclusion.map((item) => item.disposition),
		["included", "replaced"],
	);
});
