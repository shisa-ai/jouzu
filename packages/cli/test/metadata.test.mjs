import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDisplayVersion, parseBuildInfo } from "../dist/metadata.js";

const cleanBuild = {
	schemaVersion: 1,
	builtAt: "2026-08-23T14:04:09.123Z",
	gitCommit: "b3e714f25c3225260f2520a789a2adfa0dbfd1e4",
	gitDirty: false,
};

test("formats a UTC build timestamp and source commit as a development version", () => {
	const parsed = parseBuildInfo(cleanBuild);
	assert.deepEqual(parsed, cleanBuild);
	assert.equal(formatDisplayVersion("0.1.1", parsed), "0.1.1-dev.20260823-140409+gb3e714f2");
	assert.equal(
		formatDisplayVersion("0.1.1", { ...parsed, gitDirty: true }),
		"0.1.1-dev.20260823-140409+gb3e714f2.dirty",
	);
	assert.equal(formatDisplayVersion("0.1.1", undefined), "0.1.1");
});

test("rejects ambiguous or malformed development build metadata", () => {
	for (const value of [
		null,
		{ ...cleanBuild, schemaVersion: 2 },
		{ ...cleanBuild, builtAt: "2026-08-23 14:04" },
		{ ...cleanBuild, gitCommit: "b3e714f" },
		{ ...cleanBuild, gitDirty: "false" },
		{ ...cleanBuild, extra: true },
	]) {
		assert.throws(() => parseBuildInfo(value));
	}
});
