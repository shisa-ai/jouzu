#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "packages", "cli");

function walk(dir) {
	const entries = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) entries.push(...walk(path));
		else entries.push(path);
	}
	return entries;
}

function mtime(path) {
	return statSync(path).mtimeMs;
}

function maxMtime(paths) {
	return Math.max(...paths.map(mtime));
}

function assertFresh(source, output, label) {
	if (!existsSync(output)) {
		console.error(`stale dist: ${label} is missing (${output}); run npm run build`);
		process.exit(1);
	}
	if (maxMtime(source) > mtime(output)) {
		console.error(`stale dist: ${label} sources are newer than ${output}; run npm run build`);
		process.exit(1);
	}
}

function assertTreeFresh(sourceRoot, outputRoot, label) {
	for (const source of walk(sourceRoot)) {
		const relativePath = relative(sourceRoot, source);
		assertFresh([source], join(outputRoot, relativePath), `${label} ${relativePath}`);
	}
}

const src = walk(join(cli, "src")).filter((path) => path.endsWith(".ts"));
assertFresh(src, join(cli, "dist", "cli.js"), "compiled CLI");
assertFresh([join(root, "upstream", "pi.lock.json")], join(cli, "dist", "pi.lock.json"), "Pi lock");
assertTreeFresh(join(cli, "profiles"), join(cli, "dist", "profiles"), "bundled profile");
console.log("dist is fresh");
