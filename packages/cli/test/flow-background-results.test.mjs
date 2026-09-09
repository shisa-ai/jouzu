import assert from "node:assert/strict";
import { test } from "node:test";
import { BackgroundResultProducer } from "../dist/flow-control/background-results.js";

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
