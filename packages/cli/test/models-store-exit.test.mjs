import assert from "node:assert/strict";
import { test } from "node:test";
import { createModelsStoreExitExtension } from "../dist/models-store-exit.js";

function shutdownHandler(close) {
	const handlers = [];
	createModelsStoreExitExtension(close).factory({
		on(event, handler) {
			if (event === "session_shutdown") handlers.push(handler);
		},
	});
	assert.equal(handlers.length, 1);
	return handlers[0];
}

test("the models store closes when the runtime quits and waits for the close", async () => {
	let finish;
	const closing = new Promise((resolve) => {
		finish = resolve;
	});
	let calls = 0;
	const handler = shutdownHandler(() => {
		calls++;
		return closing;
	});
	let settled = false;
	const shutdown = Promise.resolve(handler({ type: "session_shutdown", reason: "quit" })).then(() => {
		settled = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls, 1);
	assert.equal(settled, false, "shutdown waits for the store to close");
	finish();
	await shutdown;
	assert.equal(settled, true);
});

test("switching sessions keeps the models store open", async () => {
	let calls = 0;
	const handler = shutdownHandler(async () => {
		calls++;
	});
	for (const reason of ["reload", "new", "resume", "fork"]) await handler({ type: "session_shutdown", reason });
	assert.equal(calls, 0);
});
