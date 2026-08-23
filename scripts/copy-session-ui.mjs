#!/usr/bin/env node

import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = join(root, "packages", "session-ui", "dist");
const target = join(root, "packages", "cli", "dist", "session-ui");

function copyRuntimeTree(sourceDirectory, targetDirectory) {
	mkdirSync(targetDirectory, { recursive: true });
	for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
		const sourcePath = join(sourceDirectory, entry.name);
		const targetPath = join(targetDirectory, entry.name);
		if (entry.isDirectory()) {
			copyRuntimeTree(sourcePath, targetPath);
			continue;
		}
		if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".js.map"))) {
			copyFileSync(sourcePath, targetPath);
		}
	}
}

rmSync(target, { recursive: true, force: true });
copyRuntimeTree(source, target);
const notice = join(root, "packages", "session-ui", "THIRD_PARTY_NOTICES.md");
copyFileSync(notice, join(target, basename(notice)));
console.log(`copied session UI runtime to ${target}`);
