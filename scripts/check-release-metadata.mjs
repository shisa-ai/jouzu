#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const rootPackage = readJson("package.json");
const cliPackage = readJson("packages/cli/package.json");
const lock = readJson("package-lock.json");
const piLock = readJson("upstream/pi.lock.json");
const pythonProject = readFileSync(resolve(root, "python/jouzu/pyproject.toml"), "utf8");
const pythonModule = readFileSync(resolve(root, "python/jouzu/src/jouzu/__init__.py"), "utf8");
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
const npmWorkflow = readFileSync(resolve(root, ".github/workflows/publish-npm.yml"), "utf8");
const npmPublisher = readFileSync(resolve(root, "scripts/publish-npm.mjs"), "utf8");

if (rootPackage.version !== cliPackage.version) throw new Error("root and npm Jouzu versions differ");
if (lock.version !== cliPackage.version || lock.packages?.[""]?.version !== cliPackage.version) {
	throw new Error("root package-lock version differs from the npm Jouzu version");
}
if (lock.packages?.["packages/cli"]?.version !== cliPackage.version) {
	throw new Error("workspace package-lock version differs from the npm Jouzu version");
}
if (!changelog.includes(`## ${cliPackage.version} - `)) throw new Error("CHANGELOG is missing the npm Jouzu version");
const piName = "@earendil-works/pi-coding-agent";
const piVersion = piLock.packages?.[piName]?.version;
if (!piVersion || cliPackage.dependencies?.[piName] !== piVersion)
	throw new Error("npm Jouzu does not use the exact Pi lock version");
if (!pythonProject.includes('version = "0.0.1"') || !pythonModule.includes('__version__ = "0.0.1"')) {
	throw new Error("PyPI must remain at the non-functional 0.0.1 reservation for the npm-only v0.1 release");
}
if (rootPackage.workspaces?.length !== 1 || rootPackage.workspaces[0] !== "packages/*") {
	throw new Error("unexpected npm workspace configuration");
}
for (const required of [
	"environment: npm-publish",
	"id-token: write",
	"fetch-depth: 0",
	"git cat-file -t",
	"git merge-base --is-ancestor",
]) {
	if (!npmWorkflow.includes(required)) throw new Error(`npm publish workflow is missing ${required}`);
}
if (npmWorkflow.includes("NODE_AUTH_TOKEN") || npmWorkflow.includes("NPM_TOKEN")) {
	throw new Error("npm publish workflow must use OIDC without a registry token");
}
if (!npmPublisher.includes('"--provenance"') || !npmPublisher.includes("is already published")) {
	throw new Error("npm publisher must request provenance and fail closed for an existing version");
}
console.log(`release metadata: jouzu@${cliPackage.version}, Pi ${piVersion}, PyPI reservation 0.0.1`);
