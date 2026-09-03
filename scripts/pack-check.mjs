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
 * Derive the platform-specific clipboard binding variants that must ship in
 * the tarball from the installed @mariozechner/clipboard package's own
 * optionalDependencies, so the gate tracks the pinned Pi runtime's dependency
 * instead of a hand-written list. Returns unqualified variant package names
 * (e.g. "clipboard-win32-x64-msvc").
 */
export function deriveClipboardBindingVariants(clipboardPackageJson) {
	const variants = Object.keys(clipboardPackageJson?.optionalDependencies ?? {});
	if (variants.length === 0) {
		throw new Error("@mariozechner/clipboard declares no platform binding variants");
	}
	return variants.map((name) => {
		if (!name.startsWith("@mariozechner/clipboard-")) {
			throw new Error(`unexpected clipboard binding dependency ${name}`);
		}
		return name.replace("@mariozechner/", "");
	});
}

/**
 * Assert that every clipboard binding variant is packed inside the bundled Pi
 * runtime so Windows and macOS installs load native clipboard support instead
 * of silently degrading.
 */
export function assertClipboardBindingsPresent(packedFiles, variants) {
	for (const variant of variants) {
		const path = `node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner/${variant}/package.json`;
		if (!packedFiles.some((file) => file.path === path)) {
			throw new Error(`jouzu tarball is missing clipboard binding ${variant}`);
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
	let packed;
	if (process.env.JOUZU_PACK_METADATA) {
		[packed] = JSON.parse(readFileSync(process.env.JOUZU_PACK_METADATA, "utf8"));
	} else {
		const result = spawnSync(npmCommand, [...npmPrefixArguments, "pack", "--dry-run", "--ignore-scripts", "--json"], {
			cwd: directory,
			encoding: "utf8",
			maxBuffer: 128 * 1024 * 1024,
		});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			process.stderr.write(result.stderr ?? "npm pack failed without diagnostic output\n");
			process.exit(result.status ?? 1);
		}
		[packed] = JSON.parse(result.stdout);
	}
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
		if (packed.files.some((file) => file.path === "dist/build-info.json")) {
			throw new Error("jouzu tarball contains development build metadata");
		}
		const allowedTopLevel = new Set(["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "package.json"]);
		for (const file of packed.files) {
			if (!allowedTopLevel.has(file.path) && !file.path.startsWith("dist/") && !file.path.startsWith("node_modules/")) {
				throw new Error(`jouzu tarball contains unexpected public file ${file.path}`);
			}
		}
		if (!packed.files.some((file) => file.path === "LICENSE")) throw new Error("jouzu tarball is missing LICENSE");
		const cliEntry = packed.files.find((file) => file.path === "dist/cli.js");
		if (!cliEntry) throw new Error("jouzu tarball is missing dist/cli.js");
		if (process.platform !== "win32" && (cliEntry.mode & 0o111) === 0) {
			throw new Error("jouzu dist/cli.js is not executable");
		}
		if (!readFileSync(join(directory, "dist", "cli.js"), "utf8").startsWith("#!/usr/bin/env node\n")) {
			throw new Error("jouzu dist/cli.js is missing its Node shebang");
		}
		assertProfileFilesPresent(packed.files, deriveRequiredProfileFiles(join(directory, "profiles")));
		const clipboardPackage = JSON.parse(
			readFileSync(
				join(
					directory,
					"node_modules",
					"@earendil-works",
					"pi-coding-agent",
					"node_modules",
					"@mariozechner",
					"clipboard",
					"package.json",
				),
				"utf8",
			),
		);
		assertClipboardBindingsPresent(packed.files, deriveClipboardBindingVariants(clipboardPackage));
		if (!packed.files.some((file) => file.path === "dist/release-extensions.json")) {
			throw new Error("jouzu tarball is missing dist/release-extensions.json");
		}
		if (!packed.files.some((file) => file.path === "THIRD_PARTY_NOTICES.md")) {
			throw new Error("jouzu tarball is missing THIRD_PARTY_NOTICES.md");
		}
		const releaseManifest = JSON.parse(readFileSync(join(directory, "release-extensions.json"), "utf8"));
		const releaseLock = JSON.parse(readFileSync(join(directory, "package-lock.json"), "utf8"));
		const releasePackages = [...releaseManifest.packages, ...releaseManifest.compatibilityDependencies];
		const expectedBundles = releasePackages.filter((record) => record.bundled !== false).map((record) => record.name);
		for (const name of expectedBundles) {
			if (!packed.bundled?.includes(name)) throw new Error(`jouzu tarball does not bundle ${name}`);
			if (!packed.files.some((file) => file.path === `node_modules/${name}/package.json`)) {
				throw new Error(`jouzu tarball is missing bundled package ${name}`);
			}
		}
		for (const record of releasePackages.filter((candidate) => candidate.bundled === false)) {
			if (packed.bundled?.includes(record.name)) throw new Error(`jouzu tarball unexpectedly bundles ${record.name}`);
			if (packed.files.some((file) => file.path.startsWith(`node_modules/${record.name}/`))) {
				throw new Error(`jouzu tarball contains platform-selected dependency ${record.name}`);
			}
		}
		for (const record of releaseManifest.packages) {
			for (const resource of [...record.extensions, ...record.skills]) {
				if (!packed.files.some((file) => file.path === `node_modules/${record.name}/${resource}`)) {
					throw new Error(`jouzu tarball is missing release resource ${record.name}/${resource}`);
				}
			}
		}
		const camoufoxRecord = releaseManifest.packages.find((record) => record.name === "@the-forge-flow/camoufox-pi");
		const camoufoxPackage = JSON.parse(
			readFileSync(join(directory, "node_modules", "@the-forge-flow", "camoufox-pi", "package.json"), "utf8"),
		);
		if (
			camoufoxPackage.dependencies?.["camoufox-js"] !== undefined ||
			camoufoxPackage.dependencies?.["playwright-core"] !== undefined ||
			!camoufoxRecord?.dependencyRemovals?.includes("camoufox-js") ||
			!camoufoxRecord?.dependencyRemovals?.includes("playwright-core") ||
			camoufoxPackage.peerDependencies !== undefined
		) {
			throw new Error("bundled Camoufox dependency and peer repair differs from the release manifest");
		}
		const smartFetchRecord = releaseManifest.packages.find((record) => record.name === "pi-smart-fetch");
		const smartFetchPackage = JSON.parse(
			readFileSync(join(directory, "node_modules", "pi-smart-fetch", "package.json"), "utf8"),
		);
		if (smartFetchPackage.engines?.node !== smartFetchRecord?.engineOverride) {
			throw new Error("bundled smart-fetch engine repair differs from the release manifest");
		}
		for (const [name, version] of Object.entries(smartFetchRecord?.dependencyOverrides ?? {})) {
			if (smartFetchPackage.dependencies?.[name] !== version) {
				throw new Error(`bundled smart-fetch ${name} override differs from the release manifest`);
			}
			const dependencyPackage = JSON.parse(
				readFileSync(join(directory, "node_modules", "pi-smart-fetch", "node_modules", name, "package.json"), "utf8"),
			);
			if (dependencyPackage.version !== version) {
				throw new Error(`bundled smart-fetch resolved ${name}@${dependencyPackage.version} instead of ${version}`);
			}
		}
		if (
			packed.files.some(
				(file) =>
					file.path.startsWith("node_modules/@mariozechner/") ||
					file.path.startsWith("node_modules/@the-forge-flow/camoufox-pi/node_modules/camoufox-js/"),
			)
		) {
			throw new Error("jouzu tarball contains a superseded Camoufox runtime or legacy Pi peer");
		}
		for (const record of releasePackages) {
			const locked = releaseLock.packages?.[`node_modules/${record.name}`];
			if (locked?.version !== record.version) {
				throw new Error(`release bundle lock differs for ${record.name}@${record.version}`);
			}
			if (record.integrity && locked.integrity !== record.integrity) {
				throw new Error(`release bundle integrity differs for ${record.name}@${record.version}`);
			}
			if (record.commit && !locked.resolved?.endsWith(`#${record.commit}`)) {
				throw new Error(`release bundle commit differs for ${record.name}@${record.commit}`);
			}
		}
		const forbidden = forbiddenPublicContent();
		for (const file of packed.files) {
			if (!/\.(?:js|json|md|txt)$/.test(file.path) && file.path !== "LICENSE") continue;
			const text = readFileSync(join(directory, file.path), "utf8");
			for (const entry of forbidden) {
				if (file.path.startsWith("node_modules/") && entry === "AWS_SECRET_ACCESS_KEY") continue;
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
