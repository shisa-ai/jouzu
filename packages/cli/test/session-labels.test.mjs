import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLabelProposal } from "../dist/session-labels.js";
import { TerminalTitleFilter } from "../dist/terminal-title-filter.js";
import { validPaneLabel } from "../dist/tmux-labels.js";

test("title filter suppresses every split of OSC titles, preserving other bytes", () => {
	for (const terminator of ["\x07", "\x1b\\"]) {
		for (const code of [0, 1, 2]) {
			const input = Buffer.from(`before\x1b]${code};user name${terminator}after\x1b[31mred\x1b[0m日本語`);
			for (let split = 0; split <= input.length; split++) {
				const filter = new TerminalTitleFilter();
				assert.equal(
					Buffer.concat([filter.filter(input.subarray(0, split)), filter.filter(input.subarray(split))]).toString(),
					"beforeafter\x1b[31mred\x1b[0m日本語",
				);
			}
		}
	}
	const filter = new TerminalTitleFilter();
	assert.equal(filter.filter("\x1b]52;c;clipboard\x07").toString(), "\x1b]52;c;clipboard\x07");
	assert.equal(filter.filter(`\x1b]0;${"x".repeat(100000)}\x07ok`).toString(), "ok");
});

test("proposals reject controls, oversized names, and non-ASCII pane labels", () => {
	assert.deepEqual(parseLabelProposal('{"action":"rename","name":"Fix labels","label":"label-fix"}'), {
		name: "Fix labels",
		label: "label-fix",
	});
	assert.equal(parseLabelProposal('{"action":"keep"}'), undefined);
	assert.deepEqual(parseLabelProposal('{"action":"defer","revisitAfterTurns":2}'), { revisitAfterTurns: 2 });
	for (const revisitAfterTurns of [0, 4, 1.5, "1", null])
		assert.throws(() => parseLabelProposal(JSON.stringify({ action: "defer", revisitAfterTurns })));
	for (const name of ["", "x".repeat(61), "a\x1bb", "a\u202eb"])
		assert.throws(() => parseLabelProposal(JSON.stringify({ action: "rename", name, label: "ok" })));
	for (const label of ["日本語", "x".repeat(13), "x;y", "-", "ok\n"]) assert.equal(validPaneLabel(label), false);
});
