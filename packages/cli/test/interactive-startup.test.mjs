import assert from "node:assert/strict";
import { test } from "node:test";
import { usesMachineReadableStdout } from "../dist/interactive-startup.js";

test("detects Pi protocol and event modes in both argument forms", () => {
	assert.equal(usesMachineReadableStdout(["--mode", "rpc"]), true);
	assert.equal(usesMachineReadableStdout(["--mode", "json"]), true);
	assert.equal(usesMachineReadableStdout(["--mode=rpc"]), true);
	assert.equal(usesMachineReadableStdout(["--mode=json"]), true);
	assert.equal(usesMachineReadableStdout(["--model", "gpt-5", "--mode", "rpc", "--no-themes"]), true);
});

test("leaves human-readable modes and unrelated arguments alone", () => {
	assert.equal(usesMachineReadableStdout([]), false);
	assert.equal(usesMachineReadableStdout(["--mode", "text"]), false);
	assert.equal(usesMachineReadableStdout(["--mode", "print"]), false);
	assert.equal(usesMachineReadableStdout(["--mode=text"]), false);
	assert.equal(usesMachineReadableStdout(["--print"]), false);
	assert.equal(usesMachineReadableStdout(["--session", "01a02007-8a6e-753c-b232-babb4ba4f3d5"]), false);
	assert.equal(usesMachineReadableStdout(["--mode"]), false);
	assert.equal(usesMachineReadableStdout(["--mode="]), false);
});
