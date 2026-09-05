#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "upstream", "pi.lock.json");
const destination = resolve(process.cwd(), process.argv[2] ?? "dist/pi.lock.json");
const packageName = "@earendil-works/pi-coding-agent";
const serverPackageName = "@earendil-works/pi-server";
const directRuntimePackageNames = [
	"@earendil-works/pi-ai",
	packageName,
	serverPackageName,
	"@earendil-works/pi-telemetry",
	"@earendil-works/pi-tui",
];
const lock = JSON.parse(readFileSync(source, "utf8"));
const cliPackage = JSON.parse(readFileSync(resolve(root, "packages", "cli", "package.json"), "utf8"));
const version = lock.packages?.[packageName]?.version;
const serverVersion = lock.packages?.[serverPackageName]?.version;

if (!version) throw new Error(`${source} is missing ${packageName}`);
if (!serverVersion) throw new Error(`${source} is missing ${serverPackageName}`);
if (directRuntimePackageNames.some((name) => cliPackage.dependencies?.[name] !== version)) {
	throw new Error(`jouzu runtime dependencies do not match the exact Pi lock tuple ${version}`);
}
if (serverVersion !== version || cliPackage.bundleDependencies?.includes(serverPackageName)) {
	throw new Error(`jouzu runtime does not install Pi server lock ${serverVersion} as an external exact dependency`);
}

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log(`copied Pi ${version} lock to ${destination}`);
