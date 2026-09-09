import assert from "node:assert/strict";
import { assistantToolCalls } from "../../../../scripts/fixtures/pi-flow-session.mjs";
import { waitDependencyFrom } from "./flow-wait-dependency.mjs";

/**
 * The model-issued chain the first candidate has to survive: start a lane, spawn a background
 * dependency, then block the lane on that exact dependency. `command` decides whether the wait
 * resolves during the test (a short sleep) or stays live until the session ends (a long one).
 */
export function campaignScript({ command = "sleep 20", goal = "Finish the sweep" } = {}) {
	return (body, index) => {
		if (index === 0)
			return assistantToolCalls({
				name: "multiloop_start",
				arguments: { lane: "sweep", runTag: "run", mode: "research", goal },
			});
		if (index === 1) return assistantToolCalls({ name: "bg_task", arguments: { action: "spawn", command } });
		if (index === 2) {
			const dependency = waitDependencyFrom(body);
			assert.ok(dependency, "the task tool result carries wait evidence");
			return assistantToolCalls({
				name: "agent_wait",
				arguments: {
					work: dependency.work.id,
					reason: "the sweep must finish",
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
		return { text: `turn ${index}` };
	};
}

/** The single live wait a campaign leaves behind, asserted rather than searched for. */
export async function liveWait(ingress, message = "one live wait") {
	const waits = await ingress.branch().attachment.waits.snapshot();
	const live = waits.filter((wait) => wait.state === "waiting");
	assert.equal(live.length, 1, message);
	return live[0];
}
