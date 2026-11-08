import assert from "node:assert/strict";
import test from "node:test";
import { addWorkerUsage, formatUsageCost, projectWorkerUsage } from "../dist/subagents/usage.js";

const usage = (total, totalFromProvider) => ({
	input: 2,
	output: 3,
	cacheRead: 4,
	cacheWrite: 0,
	cost: { total, totalFromProvider },
});

test("worker cost projection distinguishes billed zero, estimates and missing prices", () => {
	for (const [total, reported, expected] of [
		[0, true, { total: 0, source: "provider" }],
		[2, true, { total: 2, source: "provider" }],
		[2, false, { total: 2, source: "estimate" }],
		[0, false, null],
		[-1, true, null],
		[NaN, true, null],
		[Infinity, true, null],
	]) {
		assert.deepEqual(projectWorkerUsage(usage(total, reported)).cost, expected);
	}
});

test("partial totals retain known costs before and after unknown usage and mix provenance", () => {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null, costComplete: true };
	addWorkerUsage(total, projectWorkerUsage(usage(2, true)));
	addWorkerUsage(total, projectWorkerUsage(usage(0, false)));
	addWorkerUsage(total, projectWorkerUsage(usage(3, false)));
	assert.equal(total.cost, 5);
	assert.equal(total.costComplete, false);
	assert.equal(total.costSource, "mixed");
	assert.equal(total.input, 6);
	assert.match(formatUsageCost(total), /≥ \$5\.0000.*partly estimated/);
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null, costComplete: true };
	addWorkerUsage(zero, projectWorkerUsage(usage(0, true)));
	assert.equal(zero.cost, 0);
	assert.equal(zero.costComplete, true);
	assert.match(formatUsageCost(zero), /\$0\.0000.*billed/);
});

test("legacy numeric costs display without inventing provider provenance", () => {
	assert.equal(formatUsageCost({ cost: 2, costComplete: true }), "$2.0000");
	assert.equal(formatUsageCost({ cost: 2 }), "$2.0000");
	assert.equal(formatUsageCost({ cost: null, costComplete: false }), null);
	assert.match(formatUsageCost({ cost: 2, costComplete: false }), /^≥ \$2\.0000$/);
	assert.match(formatUsageCost({ cost: 2, costSource: "estimate", costComplete: true }), /estimated/);
});
