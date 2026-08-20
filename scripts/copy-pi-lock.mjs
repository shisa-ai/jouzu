#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "upstream", "pi.lock.json");
const destination = resolve(process.cwd(), process.argv[2] ?? "dist/pi.lock.json");
const packageName = "@earendil-works/pi-coding-agent";
const lock = JSON.parse(readFileSync(source, "utf8"));
const cliPackage = JSON.parse(readFileSync(resolve(root, "packages", "cli", "package.json"), "utf8"));
const version = lock.packages?.[packageName]?.version;

if (!version) throw new Error(`${source} is missing ${packageName}`);
if (cliPackage.dependencies?.[packageName] !== version) {
	throw new Error(
		`jouzu runtime dependency ${cliPackage.dependencies?.[packageName] ?? "(missing)"} does not match Pi lock ${version}`,
	);
}

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log(`copied Pi ${version} lock to ${destination}`);
