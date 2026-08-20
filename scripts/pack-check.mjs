#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageDirectories = [join("packages", "cli")];
const piPackageName = "@earendil-works/pi-coding-agent";
const piLock = JSON.parse(readFileSync(join("upstream", "pi.lock.json"), "utf8"));
const pinnedPiVersion = piLock.packages?.[piPackageName]?.version;
if (!pinnedPiVersion) throw new Error(`upstream/pi.lock.json is missing ${piPackageName}`);
const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmPrefixArguments = process.platform === "win32" ? ["/d", "/s", "/c", "npm"] : [];

for (const directory of packageDirectories) {
	const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const result = spawnSync(npmCommand, [...npmPrefixArguments, "pack", "--dry-run", "--ignore-scripts", "--json"], {
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
	if (packageJson.name === "jouzu") {
		if (packageJson.dependencies?.[piPackageName] !== pinnedPiVersion) {
			throw new Error(`jouzu must ship exact Pi ${pinnedPiVersion}`);
		}
		if (!packed.files.some((file) => file.path === "dist/pi.lock.json")) {
			throw new Error("jouzu tarball is missing dist/pi.lock.json");
		}
		for (const profileFile of [
			"dist/profiles/core/manifest.json",
			"dist/profiles/core/assets/jouzu-core-skill.md",
			"dist/profiles/core/assets/jouzu-review.md",
			"dist/profiles/ja/manifest.json",
			"dist/profiles/ja/assets/APPEND_SYSTEM.md",
		]) {
			if (!packed.files.some((file) => file.path === profileFile)) {
				throw new Error(`jouzu tarball is missing bundled profile file ${profileFile}`);
			}
		}
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
