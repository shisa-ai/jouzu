import assert from "node:assert/strict";
import { test } from "node:test";
import { groupWork, selectWork } from "../dist/work-dashboard.js";
import { WorkDashboardController } from "../dist/work-dashboard-controller.js";

const unit = (id, extra = {}) => ({
	id,
	producer: "children",
	owner: "s",
	kind: "agent",
	state: "completed",
	label: id,
	completedAt: 1000,
	attention: [],
	route: "/workflow",
	...extra,
});
const snapshot = (units) => ({
	scope: { sessionId: "s", branchId: "b" },
	generation: 1,
	sequence: 1,
	sources: { children: { availability: "available", complete: true, units } },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("completion expiry uses explicit time; hidden and filtered attention survives", () => {
	const units = [
		unit("done"),
		unit("alert", { attention: [{ id: "r", type: "result", since: 1000, route: "/workflow" }] }),
	];
	assert.equal(selectWork(snapshot(units), 30_999, 5).details.length, 2);
	assert.equal(selectWork(snapshot(units), 31_000, 5).details.length, 1);
	for (const lines of [0, 1, 5]) {
		const selected = selectWork(snapshot(units), 40_000, lines, {
			completionMs: 30_000,
			detailCapacity: 100,
			filter: () => false,
		});
		assert.equal(selected.attentionCount, 1);
		assert.equal(selected.omittedAttention, 1);
		assert.equal(selected.details.length, 0);
	}
	assert.equal(units[1].attention.length, 1);
});

test("capacity and overflow preserve unique counts and oldest attention ordering", () => {
	const units = [
		unit("new", { attention: [{ id: "a", type: "input", since: 3000 }] }),
		unit("old", {
			attention: [
				{ id: "a", type: "result", since: 1000 },
				{ id: "b", type: "recovery", since: 2000 },
			],
		}),
	];
	const selected = selectWork(snapshot([...units, units[0]]), 4000, 2, { completionMs: 30_000, detailCapacity: 1 });
	assert.deepEqual(
		selected.details.map((item) => item.id),
		["old"],
	);
	assert.equal(selected.attentionCount, 2);
	assert.equal(selected.omittedAttention, 1);
	assert.deepEqual(selected.routes, ["/workflow"]);
	const groups = groupWork([...units, units[0]], () => ["all", "attention", "all"]);
	assert.equal(groups.get("all").length, 2);
	assert.equal(groups.get("attention").length, 2);
	assert.equal(selectWork(snapshot(units), 4000, 1).details.length, 0);
});

test("subscribe-before-read repeats invalidated reads and preserves stale attention", async () => {
	const controller = new WorkDashboardController();
	let changed;
	let release;
	let calls = 0;
	let fail = false;
	let disposed = false;
	const source = {
		id: "children",
		subscribe(callback) {
			changed = callback;
			return () => {
				disposed = true;
			};
		},
		async read() {
			assert.equal(typeof changed, "function");
			calls++;
			if (calls === 1)
				await new Promise((resolve) => {
					release = resolve;
				});
			if (fail) throw new Error("offline");
			return {
				availability: "available",
				complete: true,
				units: [unit(String(calls), { attention: [{ id: "a", type: "result" }] })],
			};
		},
	};
	controller.attach({ sessionId: "s", branchId: "b" }, [source]);
	changed();
	release();
	await tick();
	assert.equal(calls, 2);
	assert.equal(controller.getSnapshot().sources.children.units[0].id, "2");
	fail = true;
	changed();
	await tick();
	assert.equal(controller.getSnapshot().sources.children.availability, "stale");
	assert.equal(selectWork(controller.getSnapshot(), 40_000, 0).attentionCount, 1);
	controller.dispose();
	assert.equal(disposed, true);
});

test("navigation fences late reads and never retains another scope's attention", async () => {
	const controller = new WorkDashboardController();
	let release;
	let signal;
	controller.attach({ sessionId: "old", branchId: "b" }, [
		{
			id: "children",
			subscribe: () => () => {},
			read: (_scope, abort) => {
				signal = abort;
				return new Promise((resolve) => {
					release = resolve;
				});
			},
		},
	]);
	const oldGeneration = controller.getSnapshot().generation;
	controller.attach({ sessionId: "new", branchId: "c" }, []);
	release({ availability: "available", complete: true, units: [unit("old")] });
	await tick();
	assert.equal(signal.aborted, true);
	assert.ok(controller.getSnapshot().generation > oldGeneration);
	assert.deepEqual(controller.getSnapshot().sources, {});
	assert.equal(controller.getSnapshot().scope.sessionId, "new");
	controller.dispose();
});
