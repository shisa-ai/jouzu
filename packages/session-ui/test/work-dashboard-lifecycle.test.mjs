import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkDashboardController } from "../dist/work-dashboard-controller.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
test("same-session navigation retains stale session members but not branch members", async () => {
	const controller = new WorkDashboardController();
	let fail = false;
	let disposed = 0;
	const source = (id, membership) => ({
		id,
		membership,
		subscribe: () => () => {
			disposed++;
			throw new Error("cleanup");
		},
		read: () => {
			if (fail) throw new Error("offline");
			return { availability: "available", complete: true, units: [{ id, attention: [{ id: "r", type: "result" }] }] };
		},
	});
	const sources = [source("child", "session"), source("flow", "branch")];
	controller.subscribe(() => {
		throw new Error("observer");
	});
	let observed = 0;
	controller.subscribe(() => {
		observed++;
	});
	controller.attach({ sessionId: "s", branchId: "a" }, sources);
	await tick();
	fail = true;
	controller.attach({ sessionId: "s", branchId: "b" }, sources);
	await tick();
	const snapshot = controller.getSnapshot();
	assert.equal(snapshot.sources.child.units.length, 1);
	assert.equal(snapshot.sources.child.availability, "stale");
	assert.equal(snapshot.sources.flow.units.length, 0);
	assert.equal(disposed, 2);
	assert.ok(observed > 2);
	controller.dispose();
	assert.equal(disposed, 4);
});

test("slow poll reads publish and detach clears the timer and aborts reads", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const controller = new WorkDashboardController();
	t.after(() => controller.dispose());
	let calls = 0;
	let resolve;
	let signal;
	controller.attach({ sessionId: "s", branchId: "b" }, [
		{
			id: "flow",
			pollIntervalMs: 1000,
			subscribe: () => () => {},
			read: (_scope, abort) => {
				calls++;
				signal = abort;
				return new Promise((done) => {
					resolve = done;
				});
			},
		},
	]);
	t.mock.timers.tick(5000);
	assert.equal(calls, 1);
	resolve({ availability: "available", complete: true, units: [] });
	await tick();
	assert.equal(controller.getSnapshot().sources.flow.availability, "available");
	t.mock.timers.tick(1000);
	assert.equal(calls, 2);
	controller.detach();
	assert.equal(signal.aborted, true);
	t.mock.timers.tick(5000);
	assert.equal(calls, 2);
	resolve({ availability: "available", complete: true, units: [] });
	await tick();
	assert.equal(controller.getSnapshot(), undefined);
});

test("subscription failure falls back to polling and incomplete reads retain attention", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const controller = new WorkDashboardController();
	t.after(() => controller.dispose());
	const units = [{ id: "child", attention: [{ id: "result", type: "result" }] }];
	let next = { availability: "available", complete: true, units };
	controller.attach({ sessionId: "s", branchId: "b" }, [
		{
			id: "child",
			subscribe: () => {
				throw new Error("offline notifications");
			},
			read: () => next,
		},
	]);
	await tick();
	next = { availability: "available", complete: false, units: [] };
	t.mock.timers.tick(1000);
	await tick();
	assert.deepEqual(controller.getSnapshot().sources.child.units, units);
	assert.equal(controller.getSnapshot().sources.child.availability, "stale");
	next = { availability: "available", complete: true, units: [] };
	t.mock.timers.tick(1000);
	await tick();
	assert.deepEqual(controller.getSnapshot().sources.child.units, []);
	assert.equal(controller.getSnapshot().sources.child.availability, "available");
});
