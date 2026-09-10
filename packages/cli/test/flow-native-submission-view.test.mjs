import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { assistant } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { projectFlowSubmissions } from "../dist/flow-control/submission-view.js";
import { nativeRequests } from "./fixtures/native-requests.mjs";

test("native submission inspection joins duplicate sends by operation and survives reopen", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	await f.session.followUp("same");
	await f.session.followUp("same");
	f.session.agent.followUpMode = "all";
	await f.session.continueQueued();
	const records = await f.attachment.submissions.snapshot();
	const views = await f.attachment.submissionViews();
	assert.equal(views.length, 2);
	for (const [index, view] of views.entries()) {
		assert.equal(view.admission, "held");
		assert.equal(view.delivery, "history");
		assert.equal(view.nativeRequests.length, 1);
		const request = view.nativeRequests[0];
		assert.equal(request.operationId, records[index].dispatch.operationId);
		assert.equal(request.sources.length, 1);
		assert.equal(request.sources[0].consumed, true);
		assert.equal(request.sources[0].history.entryId, records[index].dispatch.queueHistory[0].entryId);
		assert.deepEqual(request.sources[0].identity.queue, records[index].dispatch.inputs[0].queue);
		assert.equal(request.sources[0].model.status, "intact");
		assert.equal(request.outcome, "success");
	}
	// Two sends of the same content keep distinct source identities in the view.
	assert.notEqual(
		views[0].nativeRequests[0].sources[0].identity.operationId,
		views[1].nativeRequests[0].sources[0].identity.operationId,
	);
	await f.bridge.close();
	await f.dispatch.close();
	await f.attachment.close();
	const reopened = await PiFlowAttachment.open(join(f.root, "receipts"), f.scope);
	try {
		assert.deepEqual(await reopened.submissionViews(), views);
	} finally {
		await reopened.close();
	}
});

test("native inspection keeps per-message conversion status for each source", async (t) => {
	const f = await nativeRequests(t, {
		retainInputs: true,
		contextHandler: ({ messages }) => ({
			messages: messages.filter((message) => message.role !== "user" || message.content[0]?.text !== "remove"),
		}),
	});
	await f.session.prompt("seed");
	const [seed] = await f.attachment.submissions.snapshot();
	const saved = await f.attachment.submissions.retain({ ...seed.submission, id: "pair" });
	await f.dispatch.dispatch(saved.id, saved.revision, "pair-operation", () =>
		f.session.agent.prompt([
			{ role: "user", content: [{ type: "text", text: "keep" }], timestamp: 1 },
			{ role: "user", content: [{ type: "text", text: "remove" }], timestamp: 1 },
		]),
	);
	const view = (await f.attachment.submissionViews()).find((view) => view.id === "pair");
	assert.deepEqual(
		view.nativeRequests[0].sources.map((source) => source.model.status),
		["intact", "unresolved"],
	);
	assert.equal(view.admission, "held");
	assert.equal(view.delivery, "history");
});

test("native request failure keeps exact inclusion separate from outcome", async (t) => {
	const f = await nativeRequests(t, {
		retainInputs: true,
		native: async (model, context, options) => {
			const source = context.messages[0],
				output = { role: "user", content: source.content };
			options.onMessageConverted?.(source, output);
			await options.onPayload({ messages: [output] }, model);
			return { async *[Symbol.asyncIterator]() {}, result: async () => ({ ...assistant(), stopReason: "error" }) };
		},
	});
	await f.session.prompt("source");
	const [view] = await f.attachment.submissionViews();
	assert.equal(view.nativeRequests[0].outcome, "failure");
	assert.equal(view.nativeRequests[0].sources[0].model.status, "intact");
	assert.equal(view.admission, "held");
});

test("native submission join rejects foreign claims and returns owned inspection data", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	await f.session.prompt("source");
	const records = await f.attachment.submissions.snapshot(),
		ledger = await f.attachment.ledger.snapshot();
	const requests = await f.store.snapshot();
	for (const mutate of [
		(request) => {
			request.sourceCapture.members[0].operationId = "foreign";
		},
		(request) => {
			request.sourceCapture.members[0].prompt.messageIndex = 99;
		},
		(request) => {
			request.sourceCapture.model.members[0].sourceIndex = 99;
		},
	]) {
		const changed = structuredClone(requests);
		mutate(changed[0]);
		assert.throws(() => projectFlowSubmissions(records, ledger, changed), { code: "identity" });
	}
	assert.throws(() => projectFlowSubmissions(records, ledger, [...requests, ...requests]), { code: "identity" });
	const [view] = projectFlowSubmissions(records, ledger, requests);
	view.nativeRequests[0].sources[0].identity.operationId = "edited";
	assert.notEqual(requests[0].sourceCapture.members[0].operationId, "edited");
});
