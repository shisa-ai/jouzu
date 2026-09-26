import assert from "node:assert/strict";
import { test } from "node:test";

import { sessionActivity } from "../dist/session-activity.js";

test("reports nothing while the session works alone", () => {
	assert.equal(sessionActivity({ activeAgents: 0 }), undefined);
	assert.equal(sessionActivity({ loopStatus: "   ", activeAgents: 0 }), undefined);
});

test("reports loop counts with the marker state the loop reports", () => {
	assert.deepEqual(sessionActivity({ loopStatus: "multiloop: 1 running", activeAgents: 0 }), {
		text: "multiloop: 1 running",
		active: true,
	});
	assert.deepEqual(sessionActivity({ loopStatus: "multiloop: 1 paused", activeAgents: 0 }), {
		text: "multiloop: 1 paused",
		active: false,
	});
	assert.deepEqual(sessionActivity({ loopStatus: "multiloop: 1 stopped, 1 completed", activeAgents: 0 }), {
		text: "multiloop: 1 stopped, 1 completed",
		active: false,
	});
	assert.equal(sessionActivity({ loopStatus: "multiloop: 1 running, 1 paused", activeAgents: 0 }).active, true);
	assert.equal(sessionActivity({ loopStatus: "multiloop: 12 running", activeAgents: 0 }).active, true);
	// Only the count label marks activity, so a lane or reason that mentions running does not animate.
	assert.equal(sessionActivity({ loopStatus: "multiloop: 1 paused (running tests)", activeAgents: 0 }).active, false);
});

test("reports child agents alone or beside loop counts", () => {
	assert.deepEqual(sessionActivity({ activeAgents: 1 }), { text: "1 subagent", active: true });
	assert.deepEqual(sessionActivity({ activeAgents: 2 }), { text: "2 subagents", active: true });
	assert.deepEqual(sessionActivity({ loopStatus: "multiloop: 1 paused", activeAgents: 2 }), {
		text: "multiloop: 1 paused · 2 subagents",
		active: true,
	});
	assert.deepEqual(sessionActivity({ loopStatus: "multiloop: 1 running", activeAgents: 1 }), {
		text: "multiloop: 1 running · 1 subagent",
		active: true,
	});
});
test("running background jobs join the activity text and animate the marker", () => {
	assert.deepEqual(sessionActivity({ activeAgents: 1, activeJobs: 2 }), { text: "1 subagent · 2 jobs", active: true });
	assert.deepEqual(sessionActivity({ activeAgents: 0, activeJobs: 1 }), { text: "1 job", active: true });
});
