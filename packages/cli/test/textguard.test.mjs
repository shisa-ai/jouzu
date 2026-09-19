import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJouzuArgs, UsageError } from "../dist/args.js";

test("ordinary read scanning is opted in at launch", () => {
	assert.deepEqual(parseJouzuArgs([]).options, {});
	assert.equal(parseJouzuArgs(["--jouzu-textguard-files"]).options.textguardFiles, true);
	assert.deepEqual(parseJouzuArgs(["--jouzu-textguard-files", "-p", "hello"]).options, { textguardFiles: true });
	assert.deepEqual(parseJouzuArgs(["--", "--jouzu-textguard-files"]).args, ["--jouzu-textguard-files"]);
});

test("scanning mode is chosen at launch and the contradictory combinations are refused", () => {
	assert.deepEqual(parseJouzuArgs([]).options, {});
	assert.equal(parseJouzuArgs(["--jouzu-textguard-strict"]).options.textguardStrict, true);
	assert.equal(parseJouzuArgs(["--jouzu-textguard-off"]).options.textguardOff, true);
	for (const args of [
		["--jouzu-textguard-off", "--jouzu-textguard-strict"],
		["--jouzu-textguard-off", "--jouzu-textguard-files"],
		["--jouzu-textguard-off", "--jouzu-textguard-off"],
		["--jouzu-textguard-strict", "--jouzu-textguard-strict"],
	]) {
		assert.throws(() => parseJouzuArgs(args), UsageError);
	}
	assert.deepEqual(parseJouzuArgs(["--", "--jouzu-textguard-off"]).args, ["--jouzu-textguard-off"]);
});
