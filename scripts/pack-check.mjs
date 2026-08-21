#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const packageDirectories = [join("packages", "cli")];

/**
 * Derive the bundled profile files that must ship in the tarball from the
 * profile manifests, instead of maintaining a second hand-written file list.
 *
 * Returns dist-relative paths (e.g. "dist/profiles/core/manifest.json" and
 * each manifest asset's source path) so callers can assert their presence in
 * the packed file listing.
 */
export function deriveRequiredProfileFiles(profilesSourceDir) {
	const required = [];
	for (const id of readdirSync(profilesSourceDir, { withFileTypes: true })) {
		if (!id.isDirectory()) continue;
		const manifestPath = join(profilesSourceDir, id.name, "manifest.json");
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		} catch (error) {
			throw new Error(`profile manifest is missing or invalid at ${manifestPath}: ${error.message}`);
		}
		required.push(`dist/profiles/${id.name}/manifest.json`);
		for (const asset of manifest.assets ?? []) {
			if (!asset?.source) throw new Error(`profile ${id.name} manifest has an asset without a source`);
			required.push(`dist/profiles/${id.name}/${asset.source}`);
		}
	}
	return required;
}

/**
 * Assert that every required profile file appears in a packed-file listing.
 * Throws with the first missing path so a manifest asset omitted from the
 * tarball fails the pack gate with a precise message.
 */
export function assertProfileFilesPresent(packedFiles, required) {
	for (const profileFile of required) {
		if (!packedFiles.some((file) => file.path === profileFile)) {
			throw new Error(`jouzu tarball is missing bundled profile file ${profileFile}`);
		}
	}
}

/**
 * Build the deny-list of content that must never appear in a published
 * tarball. Private repository markers are fixed; maintainer home paths are
 * generated at runtime from the building machine's home directory and from
 * optional release-runbook input rather than embedded in this public file.
 */
export function forbiddenPublicContent() {
	const entries = [
		"jouzu-dev",
		"worklog/entries",
		"planning/v0.1",
		homedir(),
		"BEGIN PRIVATE KEY",
		"AWS_SECRET_ACCESS_KEY",
	];
	const runbookInput =
		process.env.JOUZU_PRIVATE_HOME?.split(",")
			.map((value) => value.trim())
			.filter(Boolean) ?? [];
	return [...entries, ...runbookInput];
}
const piPackageName = "@earendil-works/pi-coding-agent";
const piLock = JSON.parse(readFileSync(join("upstream", "pi.lock.json"), "utf8"));
const pinnedPiVersion = piLock.packages?.[piPackageName]?.version;
if (!pinnedPiVersion) throw new Error(`upstream/pi.lock.json is missing ${piPackageName}`);
const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmPrefixArguments = process.platform === "win32" ? ["/d", "/s", "/c", "npm"] : [];

for (const directory of packageDirectories) {
	const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const result = spawnSync(npmCommand, [...npmPrefixArguments, "pack", "--dry-run", "--ignore-scripts", "--json"], {
		cwd: directory,
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		process.stderr.write(result.stderr ?? "npm pack failed without diagnostic output\n");
		process.exit(result.status ?? 1);
	}
	const [packed] = JSON.parse(result.stdout);
	if (!packed?.files?.length) {
		throw new Error(`${packageJson.name} would publish no files`);
	}
	if (packageJson.name === "jouzu") {
		if (packageJson.dependencies?.[piPackageName] !== pinnedPiVersion) {
			throw new Error(`jouzu must ship exact Pi ${pinnedPiVersion}`);
		}
		if (!packed.files.some((file) => file.path === "dist/pi.lock.json")) {
			throw new Error("jouzu tarball is missing dist/pi.lock.json");
		}
		const allowedTopLevel = new Set(["LICENSE", "README.md", "package.json"]);
		for (const file of packed.files) {
			if (!allowedTopLevel.has(file.path) && !file.path.startsWith("dist/")) {
				throw new Error(`jouzu tarball contains unexpected public file ${file.path}`);
			}
		}
		if (!packed.files.some((file) => file.path === "LICENSE")) throw new Error("jouzu tarball is missing LICENSE");
		const cliEntry = packed.files.find((file) => file.path === "dist/cli.js");
		if (!cliEntry || (cliEntry.mode & 0o111) === 0) throw new Error("jouzu dist/cli.js is not executable");
		if (!readFileSync(join(directory, "dist", "cli.js"), "utf8").startsWith("#!/usr/bin/env node\n")) {
			throw new Error("jouzu dist/cli.js is missing its Node shebang");
		}
		assertProfileFilesPresent(packed.files, deriveRequiredProfileFiles(join(directory, "profiles")));
		const forbidden = forbiddenPublicContent();
		for (const file of packed.files) {
			if (!/\.(?:js|json|md|txt)$/.test(file.path) && file.path !== "LICENSE") continue;
			const text = readFileSync(join(directory, file.path), "utf8");
			for (const entry of forbidden) {
				if (text.includes(entry)) throw new Error(`jouzu tarball ${file.path} contains forbidden public content`);
			}
		}
	}
	for (const [command, target] of Object.entries(packageJson.bin ?? {})) {
		if (target.startsWith("./")) {
			throw new Error(`${packageJson.name} bin ${command} must omit the leading ./ for npm compatibility`);
		}
		if (!packed.files.some((file) => file.path === target)) {
			throw new Error(`${packageJson.name} bin ${command} targets missing file ${target}`);
		}
	}
	console.log(`${packageJson.name}@${packageJson.version}: ${packed.files.length} files, ${packed.size} bytes`);
}
