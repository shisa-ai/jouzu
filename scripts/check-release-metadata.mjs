#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const rootPackage = readJson("package.json");
const cliPackage = readJson(process.env.JOUZU_CLI_PACKAGE ?? "packages/cli/package.json");
const sessionUiPackage = readJson(process.env.JOUZU_SESSION_UI_PACKAGE ?? "packages/session-ui/package.json");
const lock = readJson(process.env.JOUZU_PACKAGE_LOCK ?? "package-lock.json");
const piLockPath = process.env.JOUZU_PI_LOCK ?? "upstream/pi.lock.json";
const piLock = readJson(piLockPath);
const pythonProject = readFileSync(resolve(root, "python/jouzu/pyproject.toml"), "utf8");
const pythonModule = readFileSync(resolve(root, "python/jouzu/src/jouzu/__init__.py"), "utf8");
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
const npmWorkflow = readFileSync(resolve(root, ".github/workflows/publish-npm.yml"), "utf8");
const npmPublisher = readFileSync(resolve(root, "scripts/publish-npm.mjs"), "utf8");

function hasExactFields(value, fields) {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).length === fields.length &&
		fields.every((field) => Object.hasOwn(value, field))
	);
}

function validIsoDate(value) {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

if (rootPackage.version !== cliPackage.version) throw new Error("root and npm Jouzu versions differ");
if (lock.version !== cliPackage.version || lock.packages?.[""]?.version !== cliPackage.version) {
	throw new Error("root package-lock version differs from the npm Jouzu version");
}
if (lock.packages?.["packages/cli"]?.version !== cliPackage.version) {
	throw new Error("workspace package-lock version differs from the npm Jouzu version");
}
if (!changelog.includes(`## ${cliPackage.version} - `)) throw new Error("CHANGELOG is missing the npm Jouzu version");
const piName = "@earendil-works/pi-coding-agent";
const tuiName = "@earendil-works/pi-tui";
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const dependencyRangeTargetsVersion = (range, version) =>
	range === version || range === `^${version}` || range === `~${version}`;
const lockFields = [
	"schemaVersion",
	"repository",
	"tag",
	"tagCommit",
	"commit",
	"packages",
	"reviewedAt",
	"compatibilityStatus",
	"deviations",
];
if (!hasExactFields(piLock, lockFields)) throw new Error("Pi lock fields differ from schema 2");
if (piLock.schemaVersion !== 2) throw new Error("Pi lock schemaVersion must be 2");
if (piLock.repository !== "https://github.com/earendil-works/pi") throw new Error("Pi lock repository is invalid");
if (!hasExactFields(piLock.packages, [piName])) throw new Error("Pi lock must contain only the exact Pi package");
const piRecord = piLock.packages[piName];
if (
	!hasExactFields(piRecord, ["version", "integrity"]) ||
	typeof piRecord.version !== "string" ||
	!VERSION_RE.test(piRecord.version) ||
	typeof piRecord.integrity !== "string" ||
	!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(piRecord.integrity)
) {
	throw new Error("Pi lock package record is invalid");
}
const piVersion = piRecord.version;
const tuiVersion = cliPackage.dependencies?.[tuiName];
if (rootPackage.devDependencies?.[piName] !== piVersion || cliPackage.dependencies?.[piName] !== piVersion) {
	throw new Error("Jouzu does not use the exact Pi lock version");
}
if (typeof tuiVersion !== "string" || !VERSION_RE.test(tuiVersion)) {
	throw new Error("Jouzu does not use an exact Pi TUI version");
}
if (
	sessionUiPackage.peerDependencies?.[piName] !== piVersion ||
	sessionUiPackage.peerDependencies?.[tuiName] !== tuiVersion
) {
	throw new Error("Session UI peer versions differ from the Jouzu Pi tuple");
}
const rootLock = lock.packages?.[""];
const cliLock = lock.packages?.["packages/cli"];
const sessionUiLock = lock.packages?.["packages/session-ui"];
const piPackageLock = lock.packages?.[`node_modules/${piName}`];
const tuiPackageLock = lock.packages?.[`node_modules/${tuiName}`];
if (
	rootLock?.devDependencies?.[piName] !== piVersion ||
	cliLock?.dependencies?.[piName] !== piVersion ||
	cliLock?.dependencies?.[tuiName] !== tuiVersion ||
	sessionUiLock?.peerDependencies?.[piName] !== piVersion ||
	sessionUiLock?.peerDependencies?.[tuiName] !== tuiVersion ||
	piPackageLock?.version !== piVersion ||
	tuiPackageLock?.version !== tuiVersion ||
	!dependencyRangeTargetsVersion(piPackageLock?.dependencies?.[tuiName], tuiVersion)
) {
	throw new Error("package-lock Pi and Pi TUI records differ from the Jouzu Pi tuple");
}
if (
	piLock.tag !== `v${piVersion}` ||
	!/^[0-9a-f]{40}$/.test(piLock.tagCommit) ||
	!/^[0-9a-f]{40}$/.test(piLock.commit)
) {
	throw new Error("Pi lock tag or source commit is invalid");
}
if (piLock.compatibilityStatus !== "qualified") {
	throw new Error(`Pi lock must be qualified for publication (got ${piLock.compatibilityStatus})`);
}
if (!validIsoDate(piLock.reviewedAt)) throw new Error("Pi lock reviewedAt is missing or invalid");
if (!Array.isArray(piLock.deviations) || piLock.deviations.length > 10) {
	throw new Error("Pi lock deviations must be an array of at most 10 entries");
}
for (const deviation of piLock.deviations) {
	if (
		!hasExactFields(deviation, ["path", "sha256"]) ||
		typeof deviation.path !== "string" ||
		deviation.path.length === 0 ||
		deviation.path.startsWith("/") ||
		deviation.path.includes("\\") ||
		deviation.path.split("/").some((part) => part === "" || part === "." || part === "..") ||
		typeof deviation.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(deviation.sha256)
	) {
		throw new Error("Pi lock deviation record is invalid");
	}
}
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
