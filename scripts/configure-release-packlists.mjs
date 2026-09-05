#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const releaseDependencyExclusions = ["!**/*.map", "!**/*.d.ts", "!**/*.d.mts", "!**/*.d.cts"];

function isPrunedMetadataName(path) {
	return /(?:\.map|\.d\.(?:ts|mts|cts))$/iu.test(path);
}

export function releaseDependencyFiles(files) {
	const included = (Array.isArray(files) ? files : ["**/*"]).filter(
		(pattern) => pattern.startsWith("!") || !isPrunedMetadataName(pattern),
	);
	return [...included, ...releaseDependencyExclusions.filter((pattern) => !included.includes(pattern))];
}

export function isPrunedDependencyMetadata(path) {
	return path.startsWith("node_modules/") && isPrunedMetadataName(path);
}

function installedChildren(packageRoot) {
	const modules = join(packageRoot, "node_modules");
	if (!existsSync(modules)) return [];
	const children = [];
	for (const entry of readdirSync(modules, { withFileTypes: true }).sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		if (!entry.isDirectory()) continue;
		const entryPath = join(modules, entry.name);
		if (entry.name.startsWith("@")) {
			for (const scoped of readdirSync(entryPath, { withFileTypes: true }).sort((left, right) =>
				left.name.localeCompare(right.name),
			)) {
				if (scoped.isDirectory() && existsSync(join(entryPath, scoped.name, "package.json"))) {
					children.push(join(entryPath, scoped.name));
				}
			}
		} else if (existsSync(join(entryPath, "package.json"))) {
			children.push(entryPath);
		}
	}
	return children;
}

export function configureReleasePacklists(packageRoots) {
	const pending = [...packageRoots];
	const visited = new Set();
	while (pending.length > 0) {
		const packageRoot = resolve(pending.pop());
		if (visited.has(packageRoot)) continue;
		const packagePath = join(packageRoot, "package.json");
		if (!existsSync(packagePath)) throw new Error(`release dependency is missing package.json: ${packageRoot}`);
		const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
		manifest.files = releaseDependencyFiles(manifest.files);
		writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
		visited.add(packageRoot);
		pending.push(...installedChildren(packageRoot));
	}
	return visited.size;
}

function main() {
	const root = resolve(import.meta.dirname, "..");
	const cli = join(root, "packages", "cli");
	const count = configureReleasePacklists(installedChildren(cli));
	console.log(`configured release packlists for ${count} installed package trees`);
}

const executedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executedDirectly) main();
