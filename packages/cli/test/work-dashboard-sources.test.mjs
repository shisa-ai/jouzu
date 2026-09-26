import assert from "node:assert/strict";
import { test } from "node:test";
import {
	activeChildCount,
	childWorkSnapshot,
	createChildWorkSource,
	createClaimedWorkSource,
	createFlowWorkSource,
	flowWorkSnapshot,
	jobWorkUnits,
	taskWorkUnits,
} from "../dist/work-dashboard-sources.js";

const scope = { sessionId: "parent", branchId: "branch" };
const run = {
	id: "child",
	parentSessionId: "parent",
	role: { id: "coder" },
	status: "completed",
	task: "test",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:01:00Z",
	completion: { revision: "r", handled: false },
};
test("children remain parent-session scoped across branches and handling clears attention", () => {
	for (const branchId of ["branch", "other"]) {
		const result = childWorkSnapshot({ ...scope, branchId }, [run, { ...run, parentSessionId: "elsewhere" }]);
		assert.equal(result.units.length, 1);
		assert.equal(result.units[0].attention.length, 1);
		assert.equal(result.units[0].completedAt, Date.parse(run.updatedAt));
	}
	assert.equal(
		childWorkSnapshot(scope, [{ ...run, completion: { ...run.completion, handled: true } }]).units[0].attention.length,
		0,
	);
	assert.equal(childWorkSnapshot(scope, [{ ...run, status: "running" }]).units[0].attention.length, 0);
	assert.equal(
		childWorkSnapshot(scope, [{ ...run, status: "running", currentTool: "bash", task: "fix tests\nthen report" }])
			.units[0].detail,
		"bash · fix tests",
	);
	assert.equal(childWorkSnapshot(scope, [{ ...run, currentTool: "bash" }]).units[0].detail, "test");
	assert.equal(
		createChildWorkSource({ runs: () => [], sessionId: () => undefined, subscribe: () => () => {} }).read(scope)
			.complete,
		false,
	);
});
test("flow alerts use branch identity and exclude ordinary waits and holds", () => {
	const status = {
		version: 1,
		scope,
		retryable: [],
		uncertain: [],
		unaccountable: [],
		held: [{ id: "held" }],
		waiting: [{ workId: "child" }],
		active: [{ id: "child" }],
		suspended: [{ id: "paused" }],
	};
	assert.deepEqual(flowWorkSnapshot(scope, status).units, []);
	status.retryable.push({ requestId: "r", hash: "hash" });
	status.uncertain.push({ id: "u" });
	status.unaccountable.push({ producer: "tasks", description: "task #1" });
	const result = flowWorkSnapshot(scope, status);
	assert.equal(result.units.length, 3);
	assert.ok(result.units.every((unit) => unit.attention[0].type === "authority"));
	assert.equal(flowWorkSnapshot({ ...scope, branchId: "other" }, status).complete, false);
	assert.deepEqual(flowWorkSnapshot(scope, undefined), { availability: "available", complete: true, units: [] });
	assert.doesNotThrow(() => JSON.stringify(result));
});
test("the Session Line child count includes queued children and ignores other producers", () => {
	const children = childWorkSnapshot(scope, [
		{ ...run, id: "a", status: "starting" },
		{ ...run, id: "b", status: "queued" },
		{ ...run, id: "c", status: "running" },
		run,
	]);
	const loop = { availability: "available", complete: true, units: [{ id: "l", producer: "loop", state: "running" }] };
	const snapshot = (child) => ({ scope, generation: 0, sequence: 0, sources: { subagent: child, loop } });
	assert.equal(activeChildCount(snapshot(children)), 3);
	assert.equal(activeChildCount(snapshot({ availability: "unknown", complete: false, units: [] })), undefined);
	assert.equal(activeChildCount({ scope, generation: 0, sequence: 0, sources: {} }), undefined);
});
test("flow alerts keep their first-seen time and idle flow reads back off", async () => {
	let clock = 1000;
	let reads = 0;
	let status = {
		version: 1,
		scope,
		retryable: [],
		uncertain: [],
		unaccountable: [],
		held: [],
		waiting: [],
		active: [],
		suspended: [],
	};
	const source = createFlowWorkSource(
		async () => {
			reads++;
			return status;
		},
		() => clock,
	);
	assert.deepEqual((await source.read(scope)).units, []);
	clock += 1000;
	await source.read(scope);
	assert.equal(reads, 1);
	clock += 4000;
	status = { ...status, uncertain: [{ id: "u", reason: "interrupted" }] };
	assert.equal((await source.read(scope)).units[0].attention[0].since, 6000);
	clock += 1000;
	assert.equal((await source.read(scope)).units[0].attention[0].since, 6000);
	assert.equal(reads, 3);
	status = { ...status, uncertain: [] };
	clock += 1000;
	await source.read(scope);
	status = { ...status, uncertain: [{ id: "u", reason: "interrupted" }] };
	clock += 5000;
	assert.equal((await source.read(scope)).units[0].attention[0].since, 13000);
	assert.equal(
		await createFlowWorkSource(async () => undefined)
			.read(scope)
			.then((result) => result.complete),
		true,
	);
});
function claimBus(respond = true) {
	const handlers = new Map();
	const released = [];
	let claims = 0;
	const bus = {
		on(event, handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		emit(event, data) {
			if (event !== "producer:claim" || !respond) return;
			const id = ++claims;
			data.respond(() => released.push(id));
		},
		ready: () => handlers.get("producer:ready")?.(),
		released,
		claims: () => claims,
	};
	return bus;
}
const channel = (events) => ({ events, claim: "producer:claim", ready: "producer:ready" });
const row = {
	id: "u",
	producer: "p",
	owner: "parent",
	kind: "job",
	state: "running",
	label: "x",
	attention: [],
	route: "/p",
};
test("producer rows appear only while the producer confirms its widget is hidden", () => {
	const events = claimBus();
	let available = true;
	const source = createClaimedWorkSource({
		id: "p",
		channel: channel(events),
		read: () => (available ? [row] : undefined),
	});
	const unsubscribe = source.subscribe(() => {});
	assert.deepEqual(source.read(scope).units, [row]);
	source.read(scope);
	assert.equal(events.claims(), 1, "a held claim is not repeated");
	available = false;
	assert.deepEqual(source.read(scope).units, []);
	assert.deepEqual(events.released, [1], "an unavailable inventory returns the native widget");
	available = true;
	source.read(scope);
	events.ready();
	source.read(scope);
	assert.equal(events.claims(), 3, "a producer session start ends claims and the source claims again");
	unsubscribe();
	assert.deepEqual(events.released, [1, 3]);
	const silent = createClaimedWorkSource({ id: "p", channel: channel(claimBus(false)), read: () => [row] });
	assert.deepEqual(silent.read(scope), { availability: "available", complete: true, units: [] });
	assert.deepEqual(
		createClaimedWorkSource({ id: "p", channel: channel(undefined), read: () => [row] }).read(scope).units,
		[],
	);
});
test("every task becomes a unit in checklist order so the section counts the whole list", () => {
	const task = (taskId, status, state = "active", reason) => ({
		key: `k${taskId}`,
		taskId,
		revision: "r",
		state,
		subject: `do ${taskId}`,
		status,
		blockedBy: [],
		...(reason ? { reason } : {}),
	});
	const units = taskWorkUnits(scope, [
		task("10", "pending"),
		task("1", "completed", "completed"),
		task("2", "in_progress"),
		task("3", "pending", "blocked", "Waiting for task #2"),
		task("4", "pending", "paused"),
	]);
	assert.deepEqual(
		units.map((unit) => [unit.state, unit.label, unit.detail, unit.completedAt]),
		[
			["queued", "#10 do 10", undefined, undefined],
			["completed", "#1 do 1", undefined, undefined],
			["running", "#2 do 2", undefined, undefined],
			["waiting", "#3 do 3", "Waiting for task #2", undefined],
			["paused", "#4 do 4", undefined, undefined],
		],
	);
	assert.ok(units[1].id < units[0].id, "padded identities sort numerically");
});
test("jobs map states, scope, timing, and undelivered completions", () => {
	const job = (id, status, extra = {}) => ({
		id,
		sessionId: "parent",
		status,
		command: "npm test\n--watch",
		startedAt: 1000,
		updatedAt: 5000,
		...extra,
	});
	const units = jobWorkUnits(scope, [
		job("bg-1", "running", { title: "tests" }),
		job("bg-2", "failed", { exitCode: 2, exitNotified: true }),
		job("bg-3", "completed"),
		job("bg-4", "stopped", { notifyOnExit: false }),
		job("bg-5", "running", { sessionId: "other" }),
	]);
	assert.deepEqual(
		units.map((unit) => [
			unit.id,
			unit.state,
			unit.label,
			unit.detail,
			unit.createdAt,
			unit.completedAt,
			unit.attention.length,
		]),
		[
			["bg-1", "running", "bg-1 tests", undefined, 1000, undefined, 0],
			["bg-2", "failed", "bg-2 npm test", "exit 2", 1000, 5000, 0],
			["bg-3", "completed", "bg-3 npm test", undefined, 1000, 5000, 1],
			["bg-4", "cancelled", "bg-4 npm test", undefined, 1000, 5000, 0],
		],
	);
});
