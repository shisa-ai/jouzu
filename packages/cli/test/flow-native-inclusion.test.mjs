import assert from "node:assert/strict";
import { test } from "node:test";
import {
	nativeInclusionDivergence,
	nativeProjectionDelivered,
	nativeSourceDelivered,
} from "../dist/flow-control/native-inclusion.js";
import { assembledSession, installedProducerExtensions } from "./fixtures/flow-assembly.mjs";
import { campaignScript, liveWait } from "./fixtures/flow-campaign.mjs";

const hash = "a".repeat(64);
/** One retained source at `index`, with the model status Pi recorded for it. */
const request = ({ sources = [], projections = [], wire = true, outcome = "success" } = {}) => ({
	id: "request",
	ownerId: "owner",
	sourceHash: hash,
	transformedHash: hash,
	modelHash: hash,
	systemHash: hash,
	outcome,
	...(sources.length
		? {
				sourceCapture: {
					hash,
					count: sources.length,
					members: sources.map((_status, index) => ({
						index,
						operationId: "operation",
						messageHash: hash,
						prompt: { inputIndex: 0, messageIndex: 0 },
					})),
					model: {
						hash,
						count: sources.length,
						members: sources.map((status, index) => ({ sourceIndex: index, status, index, messageHash: hash })),
					},
				},
			}
		: {}),
	...(projections.length
		? {
				projectionCapture: {
					hash,
					count: projections.length,
					members: projections.map((_status, index) => ({
						index,
						messageHash: hash,
						message: { role: "custom", customType: "flow", content: "text", display: false, timestamp: 0 },
					})),
					model: {
						hash,
						count: projections.length,
						members: projections.map((status, index) => ({ sourceIndex: index, status, index, messageHash: hash })),
					},
				},
			}
		: {}),
	...(wire
		? {
				payload: {
					hash,
					bytes: 1000,
					api: "openai-completions",
					provider: "fixture",
					model: "fixture",
					// The store only admits a wire-included receipt over an accepted model status, so the
					// wire layer here mirrors that rule rather than inventing inclusions.
					...(sources.length
						? {
								sources: sources.map((status, index) => ({
									sourceIndex: index,
									disposition: ["intact", "converted"].includes(status) ? "included" : status,
									...(["intact", "converted"].includes(status) ? { index, contentHash: hash } : {}),
								})),
							}
						: {}),
					...(projections.length
						? {
								projections: projections.map((status, index) => ({
									sourceIndex: index,
									disposition: status === "converted" ? "included" : status,
									...(status === "converted" ? { index, contentHash: hash } : {}),
								})),
							}
						: {}),
				},
			}
		: {}),
});

test("only intact and converted sources acknowledge delivery", () => {
	const record = request({ sources: ["intact", "converted", "changed", "unresolved"] });
	assert.equal(nativeSourceDelivered(record, 0), true);
	assert.equal(nativeSourceDelivered(record, 1), true);
	// Pi records `changed` when it replaces content, such as removing an image. Replaced content is
	// not what the controller retained, so it cannot acknowledge that the instruction was delivered.
	assert.equal(nativeSourceDelivered(record, 2), false);
	assert.equal(nativeSourceDelivered(record, 3), false);
	// An index no capture member claims is not delivered by omission.
	assert.equal(nativeSourceDelivered(record, 9), false);
	assert.equal(nativeSourceDelivered(request(), 0), false);
});

test("a projection acknowledges delivery only when it converted intact", () => {
	const record = request({ projections: ["converted", "changed", "unresolved"] });
	assert.equal(nativeProjectionDelivered(record, 0), true);
	assert.equal(nativeProjectionDelivered(record, 1), false);
	assert.equal(nativeProjectionDelivered(record, 2), false);
	assert.equal(nativeProjectionDelivered(record, 9), false);
});

test("the model layer agrees with the wire layer wherever the wire layer reports", () => {
	// Every status combination the store admits, in one request.
	const record = request({
		sources: ["intact", "converted", "changed", "unresolved"],
		projections: ["converted", "changed", "unresolved"],
	});
	assert.deepEqual(nativeInclusionDivergence(record), [], "the substitution preserves the existing decision");
});

test("the model layer answers where the wire layer cannot report at all", () => {
	// A request with no payload receipt: the provider's body was never decoded, either because its
	// API has no decoder or because the request was withheld before handoff. The wire layer reports
	// nothing here, and this is the difference the reduction accepts.
	const record = request({ sources: ["intact", "changed"], projections: ["converted"], wire: false });
	assert.deepEqual(nativeInclusionDivergence(record), [
		{ kind: "source", sourceIndex: 0, model: true, wire: false },
		{ kind: "projection", sourceIndex: 0, model: true, wire: false },
	]);
	// The accepted difference only ever widens acknowledgment for content the adapter received
	// intact. Changed content stays unacknowledged under both layers.
	assert.equal(nativeSourceDelivered(record, 1), false);
});

test("no divergence can acknowledge delivery the wire layer refused", () => {
	// The store rejects a wire-included receipt whose model status is not accepted, so this shape is
	// unreachable through the ingress. Assert the predicate's own direction rather than trusting it.
	const record = request({ sources: ["changed"] });
	record.payload.sources = [{ sourceIndex: 0, disposition: "included", index: 0, contentHash: hash }];
	assert.deepEqual(nativeInclusionDivergence(record), [{ kind: "source", sourceIndex: 0, model: false, wire: true }]);
	assert.equal(nativeSourceDelivered(record, 0), false, "the model layer refuses replaced content either way");
});

test("the two layers agree on every request a real campaign produces", async (t) => {
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(),
		script: campaignScript({ command: "sleep 0.3 && echo swept", goal: "Compare inclusion layers" }),
	});
	await f.session.prompt("start the sweep and wait");
	await liveWait(f.ingress, "the campaign leaves one live wait");
	// Idle maintenance retires superseded requests within about a second, so accumulate each one as
	// it appears rather than snapshotting once at the end and finding it already retired.
	const seen = new Map();
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		for (const request of await f.ingress.branch().attachment.nativeRequests.snapshot())
			seen.set(request.id, request);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	const requests = [...seen.values()];
	assert.ok(requests.length >= 2, `the campaign made several provider requests, saw ${requests.length}`);
	assert.ok(
		requests.some((request) => request.sourceCapture?.members.length),
		"at least one request carried retained sources",
	);
	// Projections are composed by the wait-decision context path rather than this campaign, so their
	// real-fixture agreement is proven where that path already runs: the ingress, wait-observation,
	// and background-results suites exercise it once their readers move to the model layer.
	for (const request of requests) {
		// Every request the qualified path produced decides delivery identically under both layers,
		// which is what makes the wire layer safe to delete.
		assert.deepEqual(
			nativeInclusionDivergence(request),
			[],
			`request ${request.id} (${request.payload?.api ?? "no payload"}) decides differently between layers`,
		);
	}
	assert.deepEqual(f.errors, []);
});
