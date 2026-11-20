import assert from "node:assert/strict";
import { test } from "node:test";
import { createFlowStatusExtension, FLOW_STATUS_KEY } from "../dist/flow-control/flow-status-extension.js";

const RECOVERY = "an interrupted turn has an unknown outcome";

function fixture({ inspectGate } = {}) {
	const state = { hold: RECOVERY, held: [{ id: "s1", admission: "held", reason: RECOVERY }] };
	const ingress = {
		automatedPause: () => undefined,
		recoveryHold: async () => state.hold,
		inspect: async () => {
			if (inspectGate) await inspectGate.promise;
			return { version: 1, scope: {}, submissions: state.held, uncertain: [] };
		},
	};
	const handlers = new Map();
	const extension = createFlowStatusExtension({ ingress: () => ingress });
	extension.factory({
		on: (name, fn) => handlers.set(name, fn),
		registerMessageRenderer() {},
		registerCommand() {},
	});
	const notices = [];
	const statuses = [];
	const ctx = (mode) => ({
		hasUI: true,
		mode,
		ui: {
			notify: (text) => notices.push(text),
			setStatus: (key, text) => key === FLOW_STATUS_KEY && statuses.push(JSON.parse(text)),
		},
	});
	const settle = async () => {
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
	};
	return { state, handlers, notices, statuses, ctx, settle };
}

const deferred = () => {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

test("a recovery hold released while it is being read is not announced", async () => {
	const gate = deferred();
	const f = fixture({ inspectGate: gate });
	f.handlers.get("session_start")({}, f.ctx("tui"));
	await f.settle();
	// The user's /flow clear completes while the announcement is reading the held work.
	f.state.hold = undefined;
	f.state.held = [];
	gate.resolve();
	await f.settle();
	assert.deepEqual(f.notices, []);
});

test("one recovery hold is announced once, however many sessions start", async () => {
	const f = fixture();
	f.handlers.get("session_start")({}, f.ctx("tui"));
	f.handlers.get("session_start")({}, f.ctx("tui"));
	await f.settle();
	f.handlers.get("session_start")({}, f.ctx("tui"));
	await f.settle();
	assert.equal(f.notices.filter((text) => /holding/i.test(text)).length, 1, f.notices.join("\n"));
});

test("clients without a terminal get read-only structured state; the terminal does not", async () => {
	const tui = fixture();
	tui.handlers.get("session_start")({}, tui.ctx("tui"));
	await tui.settle();
	assert.deepEqual(tui.statuses, []);

	const f = fixture();
	f.handlers.get("session_start")({}, f.ctx("rpc"));
	await f.settle();
	const [status] = f.statuses;
	assert.equal(status.version, 1);
	assert.equal(status.enabled, true);
	assert.equal(status.recovery.code, "interruptedOutcome");
	assert.equal(typeof status.recovery.text, "string");
	assert.deepEqual(
		status.held.map(({ id, code }) => ({ id, code })),
		[{ id: "s1", code: "interruptedOutcome" }],
	);
	assert.deepEqual(status.withheld, []);
	assert.deepEqual(status.uncertain, []);
	// The state follows the release, latest reading wins, and repeats are not resent.
	f.state.hold = undefined;
	f.state.held = [];
	f.handlers.get("agent_end")({}, f.ctx("rpc"));
	f.handlers.get("agent_end")({}, f.ctx("rpc"));
	await f.settle();
	assert.equal(f.statuses.length, 2);
	assert.equal(f.statuses[1].recovery, undefined);
	assert.deepEqual(f.statuses[1].held, []);
});
