#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageDirectories = [join("packages", "cli")];
const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmPrefixArguments = process.platform === "win32" ? ["/d", "/s", "/c", "npm"] : [];
const dryRun = process.argv.includes("--dry-run");
const unknown = process.argv.slice(2).filter((argument) => argument !== "--dry-run");
if (unknown.length > 0) {
	throw new Error("Usage: node scripts/publish-npm.mjs [--dry-run]");
}

function run(command, args, cwd, capture = false) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.error) throw result.error;
	return result;
}

for (const directory of packageDirectories) {
	const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const packageId = `${packageJson.name}@${packageJson.version}`;
	const lookup = run(npmCommand, [...npmPrefixArguments, "view", packageId, "version", "--json"], undefined, true);
	if (lookup.status === 0 && lookup.stdout?.trim()) {
		console.log(`Skipping ${packageId}: already published`);
		continue;
	}
	const lookupError = lookup.stderr ?? "";
	if (!lookupError.includes("E404") && !lookupError.includes("404 Not Found")) {
		process.stderr.write(lookupError || "npm view failed without diagnostic output\n");
		process.exit(lookup.status ?? 1);
	}

	const args = dryRun
		? ["pack", "--dry-run", "--ignore-scripts"]
		: ["publish", "--access", "public", "--provenance", "--ignore-scripts"];
	console.log(`${dryRun ? "Validating" : "Publishing"} ${packageId}`);
	const publish = run(npmCommand, [...npmPrefixArguments, ...args], directory);
	if (publish.status !== 0) process.exit(publish.status ?? 1);
}
