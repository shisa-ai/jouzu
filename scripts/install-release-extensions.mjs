#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "packages", "cli");
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
let installStatus = 1;
for (let attempt = 1; attempt <= 3; attempt += 1) {
	const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "inherit" });
	if (result.error) throw result.error;
	installStatus = result.status ?? 1;
	if (installStatus === 0) break;
	if (attempt < 3) {
		console.warn(`npm ci failed while preparing the release bundle; retrying with a clean tree (${attempt + 1}/3)`);
		rmSync(resolve(cli, "node_modules"), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
	}
}
if (installStatus !== 0) process.exit(installStatus);
const webaioRoot = resolve(cli, "node_modules", "pi-webaio");
const webaioDist = resolve(webaioRoot, "dist");
rmSync(webaioDist, { recursive: true, force: true });
const webaioBuild = spawnSync(
	process.execPath,
	[resolve(root, "node_modules", "typescript", "bin", "tsc"), "--project", resolve(webaioRoot, "tsconfig.dist.json")],
	{ cwd: webaioRoot, encoding: "utf8", stdio: "inherit" },
);
if (webaioBuild.error) throw webaioBuild.error;
if (webaioBuild.status !== 0) process.exit(webaioBuild.status ?? 1);
const camoufoxAdapterRoot = resolve(cli, "node_modules", "@the-forge-flow", "camoufox-pi");
const camoufoxAdapterPackagePath = resolve(camoufoxAdapterRoot, "package.json");
const camoufoxAdapterPackage = JSON.parse(readFileSync(camoufoxAdapterPackagePath, "utf8"));
delete camoufoxAdapterPackage.dependencies["camoufox-js"];
delete camoufoxAdapterPackage.dependencies["playwright-core"];
delete camoufoxAdapterPackage.peerDependencies;
delete camoufoxAdapterPackage.peerDependenciesMeta;
writeFileSync(camoufoxAdapterPackagePath, `${JSON.stringify(camoufoxAdapterPackage, null, 2)}\n`);
rmSync(resolve(camoufoxAdapterRoot, "node_modules", "camoufox-js"), { recursive: true, force: true });
rmSync(resolve(camoufoxAdapterRoot, "node_modules", "playwright-core"), { recursive: true, force: true });
const camoufoxRuntimeRoot = resolve(cli, "node_modules", "camoufox-js");
const camoufoxRuntimePackagePath = resolve(camoufoxRuntimeRoot, "package.json");
const camoufoxRuntimePackage = JSON.parse(readFileSync(camoufoxRuntimePackagePath, "utf8"));
delete camoufoxRuntimePackage.dependencies["better-sqlite3"];
delete camoufoxRuntimePackage.dependencies.impit;
delete camoufoxRuntimePackage.dependencies["ua-parser-js"];
writeFileSync(camoufoxRuntimePackagePath, `${JSON.stringify(camoufoxRuntimePackage, null, 2)}\n`);
rmSync(resolve(camoufoxRuntimeRoot, "node_modules", "better-sqlite3"), { recursive: true, force: true });
rmSync(resolve(camoufoxRuntimeRoot, "node_modules", "impit"), { recursive: true, force: true });
rmSync(resolve(camoufoxRuntimeRoot, "node_modules", "ua-parser-js"), { recursive: true, force: true });
rmSync(resolve(cli, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@esbuild"), {
	recursive: true,
	force: true,
});
const bundledTypeboxSources = [
	resolve(cli, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "typebox"),
	resolve(cli, "node_modules", "@earendil-works", "pi-agent-core", "node_modules", "typebox"),
];
const bundledTypeboxTarget = resolve(cli, "node_modules", "typebox");
if (!existsSync(bundledTypeboxTarget)) {
	const bundledTypeboxSource = bundledTypeboxSources.find((path) => existsSync(path));
	if (!bundledTypeboxSource) throw new Error("installed Pi tree is missing typebox");
	renameSync(bundledTypeboxSource, bundledTypeboxTarget);
}
rmSync(resolve(cli, "node_modules", "pi-skill-dollar", "README.md"), { force: true });
console.log("installed the exact release-owned extension bundle without lifecycle scripts");
