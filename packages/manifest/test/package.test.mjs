import assert from "node:assert/strict";
import { test } from "node:test";
import extension, { version } from "../dist/index.js";

test("exports a Pi extension stub", () => {
	assert.equal(typeof extension, "function");
	assert.equal(version, "0.0.1");
});
