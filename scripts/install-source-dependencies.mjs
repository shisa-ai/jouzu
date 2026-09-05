#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function runInstall(root) {
	return spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts"], {
		cwd: root,
		stdio: "inherit",
		shell: process.platform === "win32",
	});
}

export function installSourceDependencies(root, install = runInstall) {
	const manifestPath = resolve(root, "packages/cli/package.json");
	const lockPath = resolve(root, "package-lock.json");
	const originalManifest = readFileSync(manifestPath);
	const originalLock = readFileSync(lockPath);
	const manifest = JSON.parse(originalManifest);
	const lock = JSON.parse(originalLock);
	// npm treats workspace bundle declarations as already-present archive content
	// and skips their installation. Source builds need that content from the lock.
	delete manifest.bundleDependencies;
	delete lock.packages["packages/cli"].bundleDependencies;
	for (const [path, entry] of Object.entries(lock.packages)) {
		if (path.startsWith("packages/cli/node_modules/")) delete entry.inBundle;
	}
	let result;
	try {
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
		result = install(root);
	} finally {
		writeFileSync(manifestPath, originalManifest);
		writeFileSync(lockPath, originalLock);
	}
	if (result.error) throw result.error;
	return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = installSourceDependencies(resolve(import.meta.dirname, ".."));
}
