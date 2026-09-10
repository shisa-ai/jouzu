import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BackgroundResultProducer } from "../dist/flow-control/background-results.js";
import { flowObservations } from "../dist/flow-control/observation.js";

const metadata = {
	id: "bg-result:execution",
	producer: "bg",
	execution: "execution",
	revision: "1",
	status: "success",
	title: "Task completed",
	reference: "/result.log",
	warnings: [],
};
for (const variant of ["success", "history-only", "failure", "rejected", "changed", "foreign", "unhanded"]) {
	test(`background delivery acknowledgement requires exact successful payload: ${variant}`, async () => {
		const member = { id: metadata.id, revision: "1", kind: "result", contentHash: "exact" };
		const request = {
			handedOff: variant !== "unhanded",
			outcome: variant === "failure" ? "failure" : "success",
			payload: {
				inclusion: [
					{
						id: variant === "foreign" ? "other" : member.id,
						revision: "1",
						disposition: variant === "rejected" ? "rejected" : "included",
						contentHash: variant === "changed" ? "changed" : "exact",
					},
				],
			},
		};
		const acknowledged = [];
		const attachment = {
			ledger: {
				scope: { sessionId: "session", branchId: "branch" },
				snapshot: async () => ({
					attempts: [
						{
							members: [member],
							history: [{ id: member.id, revision: "1" }],
							requests: variant === "history-only" ? [] : [request],
						},
					],
				}),
			},
		};
		const producer = new BackgroundResultProducer(
			attachment,
			{
				activateResults: () => ({ snapshot: () => [metadata] }),
				acknowledgeResult: (...args) => acknowledged.push(args),
			},
			() => {},
		);
		const intents = await producer.snapshot(new AbortController().signal);
		assert.equal(intents.length, variant === "success" ? 0 : 1);
		assert.deepEqual(acknowledged, variant === "success" ? [[metadata.id, "1"]] : []);
	});
}

for (const variant of ["success", "failure", "missing", "redacted", "error", "call", "tool", "uncaptured"]) {
	test(`terminal observation requires exact tool and successful request: ${variant}`, async () => {
		const content = [{ type: "text", text: "task: completed\n\noutput" }];
		const receipt = {
			id: metadata.id,
			revision: "1",
			toolCallId: "read",
			toolName: "bg_task",
			contentHash: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
		};
		const message = {
			role: "toolResult",
			toolCallId: variant === "call" ? "foreign" : "read",
			toolName: variant === "tool" ? "read" : "bg_task",
			isError: variant === "error",
			content,
		};
		const observations = [];
		const producer = new BackgroundResultProducer(
			{
				ledger: { scope: {}, snapshot: async () => ({ attempts: [] }) },
				nativeRequests: {
					snapshot: async () => [
						{
							outcome: variant === "failure" ? "failure" : "success",
							projectionCapture: { members: [{ index: 2, message }], model: { members: [{ status: "converted" }] } },
							payload: {
								projections:
									variant === "missing"
										? []
										: [{ sourceIndex: 2, disposition: variant === "redacted" ? "rejected" : "included" }],
							},
						},
					],
				},
			},
			{
				activateResults: () => ({
					snapshot: () => (observations.length ? [] : [metadata]),
					readReceipts: () => (variant === "uncaptured" ? [] : [receipt]),
				}),
				acknowledgeObservation: (...args) => observations.push(args),
				acknowledgeResult: () => assert.fail("not summary delivery"),
			},
			() => {},
		);
		await producer.snapshot(new AbortController().signal);
		assert.deepEqual(observations, variant === "success" ? [[metadata.id, "1"]] : []);
		// Recognition is by content hash, so an unchanged observation matches and a changed one does
		// not. Both directions are asserted: only the negative would pass on any broken projection.
		const offered = (content) => flowObservations([{ ...message, ...(content ? { content } : {}) }]);
		// Only a message that still matches its receipt is recognized: a foreign call id, a different
		// tool, an error result, or a missing receipt all disqualify it.
		const recognizable = !["call", "tool", "error", "uncaptured"].includes(variant);
		assert.deepEqual(producer.observationProjections(offered()), recognizable ? [0] : []);
		assert.deepEqual(producer.observationProjections(offered([{ type: "text", text: "changed" }])), []);
	});
}
