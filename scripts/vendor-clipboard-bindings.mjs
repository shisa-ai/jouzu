#!/usr/bin/env node

// Vendor every platform variant of the native clipboard bindings into the
// bundled Pi runtime. The bundled @earendil-works/pi-coding-agent declares
// @mariozechner/clipboard as an optionalDependency whose prebuilt bindings are
// themselves platform-specific optionalDependencies. npm resolves those for the
// build machine only, so a Linux-built tarball ships Linux-only bindings and
// Windows/macOS installs silently degrade (no clipboard image paste). This
// script fetches every variant recorded in the package lock, verifies each
// download against the locked integrity hash, and extracts it next to the
// variants npm already installed so all platforms are present in the packed
// bundle. Run during the CLI build, before npm pack.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "packages", "cli");
const piRoot = resolve(cli, "node_modules", "@earendil-works", "pi-coding-agent");
const bundleModules = resolve(piRoot, "node_modules");
const clipboardOrg = resolve(bundleModules, "@mariozechner");
const clipboardName = "@mariozechner/clipboard";
const lockPath = resolve(cli, "package-lock.json");

const piPackage = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8"));
if (!piPackage.optionalDependencies?.[clipboardName]) {
	throw new Error(`bundled Pi runtime does not declare ${clipboardName}; nothing to vendor`);
}

const clipboardPackagePath = join(clipboardOrg, "clipboard", "package.json");
if (!existsSync(clipboardPackagePath)) {
	throw new Error(
		`${clipboardName} is not installed under the bundled Pi runtime; run the release-extension install first`,
	);
}
const clipboardPackage = JSON.parse(readFileSync(clipboardPackagePath, "utf8"));
const variants = Object.entries(clipboardPackage.optionalDependencies ?? {});
if (variants.length === 0) {
	throw new Error(`${clipboardName}@${clipboardPackage.version} declares no platform binding variants`);
}

const lock = JSON.parse(readFileSync(lockPath, "utf8"));

function lockedVariant(variantName) {
	const entry = lock.packages?.[`node_modules/@earendil-works/pi-coding-agent/node_modules/${variantName}`];
	if (!entry?.resolved || !entry?.integrity) {
		throw new Error(`package-lock.json is missing a resolved entry for ${variantName}; refresh the lock`);
	}
	if (clipboardPackage.optionalDependencies[variantName] !== entry.version) {
		throw new Error(
			`package-lock.json records ${variantName}@${entry.version} but ${clipboardName}@${clipboardPackage.version} declares ${clipboardPackage.optionalDependencies[variantName]}`,
		);
	}
	return entry;
}

// Some upstream variants are placeholders without a binary (e.g. musl arm64
// currently ships only package.json), so verification is a version match on
// the integrity-checked extraction rather than a binary-presence check.
function variantIsVendored(variantName, version) {
	const target = resolve(bundleModules, variantName);
	const packagePath = join(target, "package.json");
	if (!existsSync(packagePath)) return false;
	try {
		return JSON.parse(readFileSync(packagePath, "utf8")).version === version;
	} catch {
		return false;
	}
}

function extract(tarball, destination) {
	const result = spawnSync("tar", ["-xzf", tarball, "-C", destination, "--strip-components=1"], {
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`tar extraction failed for ${tarball}: ${(result.stderr ?? "").trim()}`);
	}
}

function pruneStaleVariants(expectedNames) {
	let pruned = 0;
	for (const entry of readdirSync(clipboardOrg, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith("clipboard-")) continue;
		if (expectedNames.has(entry.name)) continue;
		rmSync(join(clipboardOrg, entry.name), { recursive: true, force: true });
		pruned += 1;
		console.log(`pruned stale clipboard binding ${entry.name}`);
	}
	return pruned;
}

const work = mkdtempSync(join(tmpdir(), "jouzu-clipboard-"));
try {
	let vendored = 0;
	let skipped = 0;
	for (const [variantName] of variants) {
		const entry = lockedVariant(variantName);
		if (variantIsVendored(variantName, entry.version)) {
			skipped += 1;
			continue;
		}
		const tarball = join(work, `${variantName.replace("/", "+")}.tgz`);
		const response = await fetch(entry.resolved);
		if (!response.ok) throw new Error(`download failed for ${variantName}: ${response.status} ${response.statusText}`);
		const body = Buffer.from(await response.arrayBuffer());
		const [, algorithm, expectedDigest] = /^(sha\d+)-(.+)$/.exec(entry.integrity) ?? [];
		if (algorithm !== "sha512" || createHash("sha512").update(body).digest("base64") !== expectedDigest) {
			throw new Error(`integrity mismatch for ${variantName}; refusing to vendor`);
		}
		writeFileSync(tarball, body);
		const target = resolve(bundleModules, variantName);
		rmSync(target, { recursive: true, force: true });
		mkdirSync(target, { recursive: true });
		extract(tarball, target);
		if (!variantIsVendored(variantName, entry.version)) {
			throw new Error(`vendored ${variantName} but verification failed`);
		}
		vendored += 1;
		console.log(`vendored ${variantName}@${entry.version}`);
	}
	const pruned = pruneStaleVariants(new Set(variants.map(([name]) => name.split("/").pop())));
	console.log(
		`clipboard bindings: ${vendored} vendored, ${skipped} already present, ${pruned} pruned (${variants.length} total)`,
	);
	if (vendored + skipped !== variants.length) {
		throw new Error("clipboard binding vendoring did not cover every variant");
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
