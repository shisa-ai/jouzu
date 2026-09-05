#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertStandaloneMcpBoundary } from "./webaio-package-boundary.mjs";

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
const sourceOnly = process.env.JOUZU_BUILD_SOURCE_ONLY === "1";
if (sourceOnly) {
	// Root npm ci already installed these exact workspace dependencies. Junctions
	// preserve the CLI package paths used by the runtime and source tests.
	const manifest = JSON.parse(readFileSync(resolve(cli, "package.json"), "utf8"));
	for (const name of Object.keys(manifest.dependencies)) {
		const target = resolve(cli, "node_modules", name);
		if (existsSync(target)) continue;
		const installed = resolve(root, "node_modules", name);
		if (!existsSync(installed)) throw new Error(`source dependency is missing: ${name}; run npm ci`);
		mkdirSync(resolve(target, ".."), { recursive: true });
		symlinkSync(installed, target, "junction");
	}
}
let installStatus = sourceOnly ? 0 : 1;
for (let attempt = 1; attempt <= (sourceOnly ? 0 : 3); attempt += 1) {
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
const webaioPackagePath = resolve(webaioRoot, "package.json");
const webaioPackage = JSON.parse(readFileSync(webaioPackagePath, "utf8"));
if (webaioPackage.optionalDependencies?.playwright === undefined) {
	throw new Error("pi-webaio no longer declares the expected optional playwright dependency");
}
delete webaioPackage.optionalDependencies.playwright;
if (Object.keys(webaioPackage.optionalDependencies).length === 0) delete webaioPackage.optionalDependencies;
if (webaioPackage.dependencies?.["wreq-js"] !== "^3.0.0") {
	throw new Error("pi-webaio no longer declares the expected wreq-js transport dependency");
}
delete webaioPackage.dependencies["wreq-js"];
if (webaioPackage.dependencies?.["@modelcontextprotocol/sdk"] !== "^1.30.0") {
	throw new Error("pi-webaio MCP dependency differs from the expected version");
}
assertStandaloneMcpBoundary(resolve(webaioRoot, "src"));
assertStandaloneMcpBoundary(webaioDist);
delete webaioPackage.dependencies["@modelcontextprotocol/sdk"];
delete webaioPackage.bin;
for (const entry of ["bin", "src/mcp-server.ts", "dist/src/mcp-server.js", "dist/src/mcp-server.d.ts"]) {
	rmSync(resolve(webaioRoot, entry), { recursive: true, force: true });
}
rmSync(resolve(webaioRoot, "node_modules", "@modelcontextprotocol"), { recursive: true, force: true });
writeFileSync(webaioPackagePath, `${JSON.stringify(webaioPackage, null, 2)}\n`);
rmSync(resolve(webaioRoot, "node_modules", "playwright"), { recursive: true, force: true });
rmSync(resolve(webaioRoot, "node_modules", "wreq-js"), { recursive: true, force: true });
rmSync(resolve(cli, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@esbuild"), {
	recursive: true,
	force: true,
});
const bundledTypeboxSources = [
	resolve(cli, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "typebox"),
	resolve(cli, "node_modules", "@earendil-works", "pi-agent-core", "node_modules", "typebox"),
];
const bundledTypeboxTarget = resolve(cli, "node_modules", "typebox");
if (!sourceOnly && !existsSync(bundledTypeboxTarget)) {
	const bundledTypeboxSource = bundledTypeboxSources.find((path) => existsSync(path));
	if (!bundledTypeboxSource) throw new Error("installed Pi tree is missing typebox");
	renameSync(bundledTypeboxSource, bundledTypeboxTarget);
}
rmSync(resolve(cli, "node_modules", "pi-skill-dollar", "README.md"), { force: true });
console.log("installed the exact release-owned extension bundle without lifecycle scripts");
