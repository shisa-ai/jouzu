#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "packages", "cli");
const releaseManifest = JSON.parse(readFileSync(resolve(cli, "release-extensions.json"), "utf8"));
const npmExecPath = process.env.npm_execpath;
const command = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const args = [
	...(npmExecPath ? [npmExecPath] : []),
	"ci",
	"--prefix",
	cli,
	"--workspaces=false",
	"--ignore-scripts",
	"--legacy-peer-deps",
	"--loglevel=error",
	"--install-strategy=nested",
	"--no-audit",
	"--no-fund",
];
const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const camoufoxRoot = resolve(cli, "node_modules", "@the-forge-flow", "camoufox-pi");
const camoufoxPackagePath = resolve(camoufoxRoot, "package.json");
const camoufoxPackage = JSON.parse(readFileSync(camoufoxPackagePath, "utf8"));
delete camoufoxPackage.dependencies["camoufox-js"];
delete camoufoxPackage.dependencies["playwright-core"];
delete camoufoxPackage.peerDependencies;
delete camoufoxPackage.peerDependenciesMeta;
writeFileSync(camoufoxPackagePath, `${JSON.stringify(camoufoxPackage, null, 2)}\n`);
const smartFetchPackagePath = resolve(cli, "node_modules", "pi-smart-fetch", "package.json");
const smartFetchPackage = JSON.parse(readFileSync(smartFetchPackagePath, "utf8"));
const smartFetchRecord = releaseManifest.packages.find((record) => record.name === "pi-smart-fetch");
if (!smartFetchRecord?.engineOverride || !smartFetchRecord.dependencyOverrides) {
	throw new Error("pi-smart-fetch release compatibility metadata is missing");
}
smartFetchPackage.engines.node = smartFetchRecord.engineOverride;
Object.assign(smartFetchPackage.dependencies, smartFetchRecord.dependencyOverrides);
writeFileSync(smartFetchPackagePath, `${JSON.stringify(smartFetchPackage, null, 2)}\n`);
rmSync(resolve(camoufoxRoot, "node_modules", "camoufox-js"), { recursive: true, force: true });
rmSync(resolve(camoufoxRoot, "node_modules", "playwright-core"), { recursive: true, force: true });
rmSync(resolve(cli, "node_modules", "pi-skill-dollar", "README.md"), { force: true });
console.log("installed the exact release-owned extension bundle without lifecycle scripts");
