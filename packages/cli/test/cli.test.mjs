import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("prints the package version", () => {
	const output = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
	assert.equal(output.trim(), "0.0.1");
});

test("reports reservation status", () => {
	const output = execFileSync(process.execPath, [cli, "doctor"], { encoding: "utf8" });
	assert.equal(JSON.parse(output).status, "package-name-reservation");
});
