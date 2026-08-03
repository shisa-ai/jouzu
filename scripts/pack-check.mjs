#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageDirectories = ["cli", "core", "ja", "provider", "manifest"].map((name) => join("packages", name));

for (const directory of packageDirectories) {
	const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
		cwd: directory,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		process.stderr.write(result.stderr);
		process.exit(result.status ?? 1);
	}
	const [packed] = JSON.parse(result.stdout);
	if (!packed?.files?.length) {
		throw new Error(`${packageJson.name} would publish no files`);
	}
	console.log(`${packageJson.name}@${packageJson.version}: ${packed.files.length} files, ${packed.size} bytes`);
}
