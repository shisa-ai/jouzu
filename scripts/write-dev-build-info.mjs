#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatDisplayVersion, parseBuildInfo } from "../packages/cli/dist/metadata.js";

const root = resolve(import.meta.dirname, "..");
const packageRoot = resolve(root, "packages", "cli");
const target = resolve(packageRoot, "dist", "build-info.json");
const temporary = `${target}.${process.pid}.tmp`;
const packageMetadata = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

function git(...args) {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

const build = parseBuildInfo({
	schemaVersion: 1,
	builtAt: new Date().toISOString(),
	gitCommit: git("rev-parse", "HEAD"),
	gitDirty: git("status", "--porcelain=v1", "--untracked-files=normal") !== "",
});

writeFileSync(temporary, `${JSON.stringify(build, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
renameSync(temporary, target);
console.log(`Jouzu development build: ${formatDisplayVersion(packageMetadata.version, build)}`);
