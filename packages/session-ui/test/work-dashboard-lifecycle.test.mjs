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
