#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageDirectories = ["cli", "core", "ja", "provider", "manifest"].map((name) => join("packages", name));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

for (const directory of packageDirectories) {
	const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const result = spawnSync(npmCommand, ["pack", "--dry-run", "--ignore-scripts", "--json"], {
		cwd: directory,
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		process.stderr.write(result.stderr ?? "npm pack failed without diagnostic output\n");
		process.exit(result.status ?? 1);
	}
	const [packed] = JSON.parse(result.stdout);
	if (!packed?.files?.length) {
		throw new Error(`${packageJson.name} would publish no files`);
	}
	for (const [command, target] of Object.entries(packageJson.bin ?? {})) {
		if (target.startsWith("./")) {
			throw new Error(`${packageJson.name} bin ${command} must omit the leading ./ for npm compatibility`);
		}
		if (!packed.files.some((file) => file.path === target)) {
			throw new Error(`${packageJson.name} bin ${command} targets missing file ${target}`);
		}
	}
	console.log(`${packageJson.name}@${packageJson.version}: ${packed.files.length} files, ${packed.size} bytes`);
}
