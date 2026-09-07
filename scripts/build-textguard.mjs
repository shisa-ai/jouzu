#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const upstream = join(root, "upstream", "textguard");
const lock = JSON.parse(readFileSync(join(upstream, "source.lock.json"), "utf8"));
const expected = JSON.parse(readFileSync(join(upstream, "artifacts.lock.json"), "utf8"));
const output = resolve(process.argv[2] ?? join(root, "packages", "cli", "dist", "textguard"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const list = (directory, prefix = "") =>
	readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isSymbolicLink()) throw new Error(`TextGuard source must not contain symlinks: ${path}`);
		return entry.isDirectory() ? list(join(directory, entry.name), path) : [path];
	});
const actualFiles = ["source", "licenses"].flatMap((part) => list(join(upstream, part), part)).sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(Object.keys(lock.files).sort()))
	throw new Error("TextGuard source file inventory differs from the lock");
for (const [path, digest] of Object.entries(lock.files)) {
	if (sha(readFileSync(join(upstream, path))) !== digest)
		throw new Error(`TextGuard source integrity mismatch: ${path}`);
}
const sourceDigest = sha(Buffer.from(JSON.stringify(lock)));
if (sourceDigest !== expected.sourceDigest) throw new Error("TextGuard artifact lock does not match its source lock");
const env = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith("GO") && key !== "CGO_ENABLED"),
);
Object.assign(env, {
	GOTOOLCHAIN: lock.toolchain,
	CGO_ENABLED: "0",
	GOWORK: "off",
	GOENV: "off",
	GOFLAGS: "",
	GOSUMDB: "sum.golang.org",
});
function go(args, extra = {}) {
	const result = spawnSync("go", args, {
		cwd: join(upstream, "source"),
		env: { ...env, ...extra },
		encoding: "utf8",
		timeout: 300000,
		maxBuffer: 16 << 20,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`TextGuard Go build failed: ${result.stderr}`);
	return result.stdout.trim();
}
if (go(["env", "GOVERSION"]) !== lock.toolchain) throw new Error("TextGuard requires its pinned Go toolchain");
mkdirSync(output, { recursive: true });
const artifacts = {};
for (const target of lock.targets) {
	const [os, arch] = target.split("-");
	const filename = `textguard-${target}${os === "windows" ? ".exe" : ""}`;
	const path = join(output, filename);
	go(
		[
			"build",
			"-mod=vendor",
			"-trimpath",
			"-buildvcs=false",
			"-ldflags=-s -w -buildid=",
			"-o",
			path,
			"./cmd/textguard-helper",
		],
		{ GOOS: os, GOARCH: arch },
	);
	chmodSync(path, 0o755);
	artifacts[target] = {
		filename,
		sha256: sha(readFileSync(path)),
		bytes: statSync(path).size,
	};
	if (JSON.stringify(artifacts[target]) !== JSON.stringify(expected.artifacts[target]))
		throw new Error(`TextGuard artifact differs from the reviewed build: ${target}`);
}
cpSync(join(upstream, "licenses"), join(output, "licenses"), {
	recursive: true,
});
const manifest = {
	schemaVersion: 1,
	protocol: lock.protocol,
	policy: lock.policy,
	sourceDigest,
	toolchain: lock.toolchain,
	artifacts,
};
if (JSON.stringify(manifest) !== JSON.stringify(expected)) throw new Error("TextGuard artifact manifest mismatch");
writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built ${Object.keys(artifacts).length} TextGuard native artifacts with ${lock.toolchain}`);
