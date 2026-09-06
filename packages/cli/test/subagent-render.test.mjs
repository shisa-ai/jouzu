import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseSubagentResult, runPresentation, subagentComponent } from "../dist/subagents/render.js";

const plain = { fg: (_role, value) => value };
const run = {
	id: "3a08e7c8-full-run-id",
	role: "coder",
	model: { provider: "local", id: "local/GLM-5.3-Flash" },
	status: "starting",
	task: "Repair six findings 日本語",
	usage: { input: 0, output: 0, cost: null, costComplete: true },
	cwd: "/review/root",
};

test("compact subagent summary highlights identity and hides startup metadata", () => {
	const output = subagentComponent(run, plain).render(80).join("\n");
	assert.match(output, /Starting · coder/);
	assert.match(output, /local\/GLM-5.3-Flash/);
	assert.doesNotMatch(output, /local\/local|cost|Cost|input|full-run-id/);
	assert.match(output, /Repair six findings/);
	assert.match(output, /Run 3a08e7c8/);
});

test("expanded completion distinguishes unknown cost and candidate stability from approval", () => {
	const output = subagentComponent(
		{
			...run,
			status: "completed",
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:01:02Z",
			outcome: "Review blocked: no target inspected",
			review: { status: "unchanged", candidate: { head: "abc123" } },
		},
		plain,
		true,
	)
		.render(80)
		.join("\n");
	assert.match(output, /Completed/);
	assert.match(output, /1m 2s \(including queue\)/);
	assert.match(output, /Cost: unknown/);
	assert.match(output, /Review blocked/);
	assert.match(output, /not review approval/);
	assert.doesNotMatch(output, /turns|approved|Accepted/);
});

test("theme assigns distinct semantic status colors while no-color retains text", () => {
	const seen = [];
	const theme = {
		fg: (role, value) => {
			seen.push(role);
			return `\x1b[32m${value}\x1b[0m`;
		},
	};
	for (const [status, expected] of [
		["running", "accent"],
		["completed", "success"],
		["failed", "error"],
		["cancelled", "warning"],
		["interrupted", "warning"],
	]) {
		seen.length = 0;
		const old = process.env.NO_COLOR;
		delete process.env.NO_COLOR;
		try {
			const colored = subagentComponent({ ...run, status }, theme).render(48);
			assert.ok(seen.includes(expected));
			assert.ok(colored.every((line) => visibleWidth(line) <= 48));
			process.env.NO_COLOR = "1";
			const noColor = subagentComponent({ ...run, status }, theme).render(48);
			assert.ok(noColor.every((line) => !line.includes("\x1b")));
			assert.deepEqual(noColor, subagentComponent({ ...run, status }, plain).render(48));
		} finally {
			if (old === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = old;
		}
	}
});

test("rendering bounds malformed, legacy, list and hostile terminal content", () => {
	const hostile = { ...run, task: "日本語👩🏽‍💻\x1b]52;c;secret\x07".repeat(200), outcome: "x".repeat(20_000) };
	for (const value of [
		null,
		"failure",
		{ runs: [] },
		{ runs: Array(30).fill(hostile), nextOffset: 20 },
		hostile,
		[{ id: "reviewer", model: "local/test", description: "Inspect" }],
	]) {
		for (const width of [1, 10, 24, 48, 80]) {
			const lines = subagentComponent(value, plain, true).render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.ok(lines.every((line) => !line.includes("\x1b")));
		}
	}
	assert.equal(parseSubagentResult([{ type: "text", text: "broken json" }]), "broken json");
	assert.deepEqual(parseSubagentResult([{ type: "text", text: '{"status":"cancelled"}' }]), { status: "cancelled" });
});

test("presentation is a bounded snapshot and never mutates the run", () => {
	const source = { ...run, role: { id: "coder" }, task: "x".repeat(3000), result: "y".repeat(5000) };
	const snapshot = runPresentation(source);
	assert.equal(snapshot.task.length, 2000);
	assert.equal(snapshot.outcome.length, 4000);
	assert.equal(source.task.length, 3000);
});
