import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantToolCalls } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { settlePrintWork } from "../dist/flow-control/print-settle.js";
import { wrapModelSelectionIngress } from "../dist/model-selection-ingress.js";
import { createScrollbackSessionObserver } from "../dist/scrollback-session.js";
import { assembledSession, installedProducerExtensions } from "./fixtures/flow-assembly.mjs";
import { controlledBackground } from "./fixtures/flow-background-gate.mjs";
import { waitDependencyFrom } from "./fixtures/flow-wait-dependency.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
	const listeners = new Set();
	const subscribe = (callback) => {
		listeners.add(callback);
		return () => listeners.delete(callback);
	};
	const f = { waits: [], pause: undefined, enabled: true, wakes: 0, listeners };
	const branch = {
		attachment: {
			waits: { onChanged: subscribe, snapshot: async () => f.waits },
			waitProducers: { onChanged: subscribe },
		},
		host: { onIdle: subscribe },
	};
	f.session = { waitForIdle: async () => {}, isStreaming: false };
	f.ingress = {
		enabled: () => f.enabled,
		branch: () => branch,
		automatedPause: () => f.pause,
		joinPendingOperations: async () => {},
		wakeProducers: async () => {
			f.wakes++;
		},
	};
	f.cancel = new AbortController();
	f.changed = () => {
		for (const listener of listeners) listener("operation");
	};
	f.settle = () => settlePrintWork(f.session, f.ingress, f.cancel.signal);
	return f;
}

test("print joins ready continuations and removes subscriptions", async () => {
	const f = fixture();
	await f.settle();
	assert.equal(f.wakes, 1);
	assert.equal(f.listeners.size, 0);
});

test("print retains accepted waits and drains their completion", async () => {
	const f = fixture();
	f.waits = [{ state: "waiting" }];
	let finished = false;
	const result = f.settle().then(() => {
		finished = true;
	});
	await tick();
	assert.equal(finished, false);
	f.waits[0].state = "resolved";
	f.changed();
	await result;
	assert.equal(f.wakes, 2);
	assert.equal(f.listeners.size, 0);
});

test("print cannot lose a terminal transition during snapshot", async () => {
	const f = fixture();
	f.ingress.branch().attachment.waits.snapshot = async () => {
		if (!f.woken) {
			f.woken = true;
			f.changed();
		}
		return [];
	};
	await f.settle();
	assert.equal(f.wakes, 2);
});

test("print cancellation releases subscriptions instead of claiming completion", async () => {
	const f = fixture();
	f.waits = [{ state: "waiting" }];
	const result = f.settle();
	await tick();
	f.cancel.abort(new Error("cancelled fixture"));
	await assert.rejects(result, /cancelled fixture/);
	assert.equal(f.listeners.size, 0);
});

test("deadline expiry drains the decision continuation before returning", async () => {
	const f = fixture();
	f.waits = [{ state: "waiting" }];
	const result = f.settle();
	await tick();
	f.waits[0].state = "expired";
	let delivered = false;
	f.ingress.wakeProducers = async () => {
		delivered = true;
	};
	f.changed();
	await result;
	assert.equal(delivered, true);
	assert.equal(f.listeners.size, 0);
});

test("launcher ingress wrappers forward print settlement and cancellation", async () => {
	const signal = new AbortController().signal;
	let received;
	const delegate = {
		version: 1,
		submit: async () => {},
		settlePrint: async (value) => {
			received = value;
		},
	};
	const wrapped = createScrollbackSessionObserver().wrap(
		wrapModelSelectionIngress(delegate, {
			enteringAutomaticSelection: () => false,
			beforeSelection: async () => {},
		}),
	);
	await wrapped.settlePrint(signal);
	assert.equal(received, signal);
});

test("print cleans up a partially installed subscription set", async () => {
	const f = fixture();
	f.ingress.branch().attachment.waitProducers.onChanged = () => {
		throw new Error("closed registry");
	};
	await assert.rejects(f.settle(), /closed registry/);
	assert.equal(f.listeners.size, 0);
});

test("print rejects an already cancelled settlement without subscribing", async () => {
	const f = fixture();
	f.cancel.abort(new Error("already cancelled"));
	await assert.rejects(f.settle(), /already cancelled/);
	assert.equal(f.listeners.size, 0);
});

test("print rejects a branch change while settling", async () => {
	const f = fixture();
	const branch = f.ingress.branch();
	f.ingress.wakeProducers = async () => {
		f.ingress.branch = () => ({ ...branch });
	};
	await assert.rejects(f.settle(), /session changed/);
	assert.equal(f.listeners.size, 0);
});

test("print drains an installed background wait through the final model reply", async (t) => {
	const background = await controlledBackground(t);
	const f = await assembledSession(t, {
		producerExtensions: await installedProducerExtensions(t),
		script: (body, index) => {
			if (index === 0)
				return assistantToolCalls({ name: "bg_task", arguments: { action: "spawn", command: background.command } });
			if (index === 1)
				return assistantToolCalls({
					name: "agent_wait",
					arguments: { reason: "Wait for the background result", deadline: "5m", on: [waitDependencyFrom(body)] },
				});
			return { text: index === 2 ? "WAITING" : "COMPLETED" };
		},
	});
	await f.session.prompt("Run the job and wait for its result.");
	assert.ok((await f.ingress.branch().attachment.waits.snapshot()).some((wait) => wait.state === "waiting"));
	let finished = false;
	const result = f.ingress.settlePrint(new AbortController().signal).then(() => {
		finished = true;
	});
	await background.started;
	await tick();
	assert.equal(finished, false);
	await background.release();
	await result;
	const last = f.session.state.messages.at(-1);
	assert.equal(last.role, "assistant");
	assert.ok(last.content.some((part) => part.type === "text" && part.text === "COMPLETED"));
	assert.deepEqual(f.errors, []);
});

test("print reports a paused continuation and bypasses disabled flow", async () => {
	const f = fixture();
	f.pause = "provider failure";
	await assert.rejects(f.settle(), /Print continuation is paused/);
	assert.equal(f.listeners.size, 0);
	f.enabled = false;
	await f.settle();
	assert.equal(f.wakes, 1);
});
