#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveClipboardBindingRequirements } from "./clipboard-bindings.mjs";
import { isPrunedDependencyMetadata } from "./configure-release-packlists.mjs";

export function assertExternalWebTransport(files, packageJson, record) {
	if (
		record?.version !== "3.2.0" ||
		record.bundled !== false ||
		packageJson.dependencies?.["wreq-js"] !== record.version ||
		packageJson.bundleDependencies?.includes("wreq-js")
	) {
		throw new Error("jouzu must install the exact external wreq-js transport");
	}
	if (files.some(({ path }) => /(?:^|\/)node_modules\/(?:wreq-js|@wreq-js)(?:\/|$)/u.test(path))) {
		throw new Error("jouzu tarball contains platform-selected wreq-js transport files");
	}
}

export { deriveClipboardBindingRequirements } from "./clipboard-bindings.mjs";

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
 * Assert that every clipboard binding package is packed inside the bundled Pi
 * runtime and that each non-placeholder package includes its native entrypoint.
 */
export function assertClipboardBindingsPresent(packedFiles, requirements) {
	for (const requirement of requirements) {
		const base = `node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner/${requirement.packageName}`;
		if (!packedFiles.some((file) => file.path === `${base}/package.json`)) {
			throw new Error(`jouzu tarball is missing clipboard binding ${requirement.packageName}`);
		}
		if (!requirement.placeholder && !packedFiles.some((file) => file.path === `${base}/${requirement.entrypoint}`)) {
			throw new Error(
				`jouzu tarball clipboard binding ${requirement.packageName} is missing native entrypoint ${requirement.entrypoint}`,
			);
		}
	}
}

export function assertNoPrunedDependencyMetadata(packedFiles) {
	const deadWeight = packedFiles.find((file) => isPrunedDependencyMetadata(file.path));
	if (deadWeight) throw new Error(`jouzu tarball contains pruned dependency metadata ${deadWeight.path}`);
}

export function deriveRequiredLicenseFiles(packageDirectory, packedFiles) {
	const packageRoots = new Set(
		packedFiles
			.map((file) => file.path)
			.filter((path) => path.startsWith("node_modules/") && path.endsWith("/package.json"))
			.map(dirname),
	);
	const required = new Set();
	for (const packageRoot of packageRoots) {
		const pending = [join(packageDirectory, packageRoot)];
		while (pending.length > 0) {
			const directory = pending.pop();
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				if (entry.name === "node_modules") continue;
				const path = join(directory, entry.name);
				if (entry.isDirectory()) pending.push(path);
				else if (entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(entry.name)) {
					required.add(relative(packageDirectory, path).split(sep).join("/"));
				}
			}
		}
	}
	return [...required].sort();
}

export function assertLicenseFilesPresent(packedFiles, required) {
	const packedPaths = new Set(packedFiles.map((file) => file.path));
	for (const license of required) {
		if (!packedPaths.has(license)) throw new Error(`jouzu tarball is missing dependency license ${license}`);
	}
}

export function assertDefaultPackagesAbsent(packedFiles, packageJson, packageNames) {
	for (const name of packageNames) {
		if (packageJson.dependencies?.[name] !== undefined || packageJson.bundleDependencies?.includes(name)) {
			throw new Error(`jouzu must not install the first-use Camoufox package ${name} by default`);
		}
		const packagePath = `node_modules/${name}/`;
		if (packedFiles.some((file) => file.path.startsWith(packagePath) || file.path.includes(`/${packagePath}`))) {
			throw new Error(`jouzu tarball contains first-use Camoufox package ${name}`);
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

export function publicContentForScan(path, text) {
	if (path === "node_modules/pi-webaio/node_modules/pdf-parse/dist/worker/esm/index.js") {
		// The published PDF worker includes its upstream build location in this comment.
		return text.replace(
			/^\/\/ dataurl:\/home\/runner\/work\/pdf-parse\/pdf-parse\/node_modules\/pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs\r?$/gmu,
			"// dataurl:pdfjs-dist/legacy/build/pdf.worker.min.mjs",
		);
	}
	return text;
}
const piPackageName = "@earendil-works/pi-coding-agent";
const piServerPackageName = "@earendil-works/pi-server";
const externalPiRuntimePackageNames = [piServerPackageName];
const separatelyBundledPiRuntimePackageNames = ["@earendil-works/pi-ai", "@earendil-works/pi-telemetry"];
const piLock = JSON.parse(readFileSync(join("upstream", "pi.lock.json"), "utf8"));
const pinnedPiVersion = piLock.packages?.[piPackageName]?.version;
const pinnedPiServerVersion = piLock.packages?.[piServerPackageName]?.version;
if (!pinnedPiVersion) throw new Error(`upstream/pi.lock.json is missing ${piPackageName}`);
if (!pinnedPiServerVersion) throw new Error(`upstream/pi.lock.json is missing ${piServerPackageName}`);
const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmPrefixArguments = process.platform === "win32" ? ["/d", "/s", "/c", "npm"] : [];

const executedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
for (const directory of executedDirectly ? packageDirectories : []) {
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
		assertNoPrunedDependencyMetadata(packed.files);
		if (packageJson.dependencies?.[piPackageName] !== pinnedPiVersion) {
			throw new Error(`jouzu must ship exact Pi ${pinnedPiVersion}`);
		}
		for (const name of externalPiRuntimePackageNames) {
			if (
				packageJson.dependencies?.[name] !== pinnedPiServerVersion ||
				packageJson.bundleDependencies?.includes(name)
			) {
				throw new Error(`jouzu must install exact external Pi runtime package ${name}@${pinnedPiServerVersion}`);
			}
			if (packed.files.some((file) => file.path.startsWith(`node_modules/${name}/`))) {
				throw new Error(`jouzu tarball unexpectedly bundles external Pi runtime package ${name}`);
			}
		}
		for (const name of separatelyBundledPiRuntimePackageNames) {
			if (packageJson.dependencies?.[name] !== pinnedPiVersion || !packageJson.bundleDependencies?.includes(name)) {
				throw new Error(`jouzu must bundle exact Pi runtime package ${name}@${pinnedPiVersion}`);
			}
			if (!packed.bundled?.includes(name)) {
				throw new Error(`jouzu tarball is missing bundled Pi runtime package ${name}`);
			}
		}
		if (!packed.files.some((file) => file.path === "dist/pi.lock.json")) {
			throw new Error("jouzu tarball is missing dist/pi.lock.json");
		}
		if (packed.files.some((file) => file.path === "dist/build-info.json")) {
			throw new Error("jouzu tarball contains development build metadata");
		}
		const allowedTopLevel = new Set(["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "package.json"]);
		for (const file of packed.files) {
			if (
				!allowedTopLevel.has(file.path) &&
				!file.path.startsWith("camoufox-runtime/") &&
				!file.path.startsWith("dist/") &&
				!file.path.startsWith("node_modules/")
			) {
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
		assertClipboardBindingsPresent(packed.files, deriveClipboardBindingRequirements(clipboardPackage));
		if (!packed.files.some((file) => file.path === "dist/release-extensions.json")) {
			throw new Error("jouzu tarball is missing dist/release-extensions.json");
		}
		if (!packed.files.some((file) => file.path === "THIRD_PARTY_NOTICES.md")) {
			throw new Error("jouzu tarball is missing THIRD_PARTY_NOTICES.md");
		}
		const releaseManifest = JSON.parse(readFileSync(join(directory, "release-extensions.json"), "utf8"));
		const releaseLock = JSON.parse(readFileSync(join(directory, "package-lock.json"), "utf8"));
		const releasePackages = [...releaseManifest.packages, ...releaseManifest.compatibilityDependencies];
		assertExternalWebTransport(
			packed.files,
			packageJson,
			releaseManifest.compatibilityDependencies.find((record) => record.name === "wreq-js"),
		);
		const esbuildRecord = releaseManifest.compatibilityDependencies.find((record) => record.name === "esbuild");
		if (
			!esbuildRecord ||
			esbuildRecord.bundled !== false ||
			packageJson.dependencies?.esbuild !== esbuildRecord.version
		) {
			throw new Error("jouzu must install the exact external esbuild compatibility dependency");
		}
		if (
			packed.files.some(
				(file) =>
					file.path.startsWith("node_modules/@esbuild/") ||
					file.path.startsWith("node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild/"),
			)
		) {
			throw new Error("jouzu tarball contains platform-specific esbuild binaries");
		}
		const expectedBundles = releasePackages
			.filter((record) => record.bundled !== false && !record.adapter)
			.map((record) => record.name);
		for (const name of expectedBundles) {
			if (!packed.bundled?.includes(name)) throw new Error(`jouzu tarball does not bundle ${name}`);
			if (!packed.files.some((file) => file.path === `node_modules/${name}/package.json`)) {
				throw new Error(`jouzu tarball is missing bundled package ${name}`);
			}
		}
		assertLicenseFilesPresent(packed.files, deriveRequiredLicenseFiles(directory, packed.files));
		for (const record of releasePackages.filter((candidate) => candidate.bundled === false)) {
			if (packed.bundled?.includes(record.name)) throw new Error(`jouzu tarball unexpectedly bundles ${record.name}`);
			if (packed.files.some((file) => file.path.startsWith(`node_modules/${record.name}/`))) {
				throw new Error(`jouzu tarball contains platform-selected dependency ${record.name}`);
			}
		}
		for (const record of releaseManifest.packages) {
			for (const resource of [...record.extensions, ...record.skills]) {
				const resourcePath = record.adapter ? resource : `node_modules/${record.name}/${resource}`;
				if (!packed.files.some((file) => file.path === resourcePath)) {
					throw new Error(`jouzu tarball is missing release resource ${record.name}/${resource}`);
				}
			}
		}
		for (const runtimeInput of ["camoufox-runtime/package.json", "camoufox-runtime/package-lock.json"]) {
			if (!packed.files.some((file) => file.path === runtimeInput)) {
				throw new Error(`jouzu tarball is missing ${runtimeInput}`);
			}
		}
		const webaioRecord = releaseManifest.packages.find((record) => record.name === "pi-webaio");
		const webaioPackage = JSON.parse(
			readFileSync(join(directory, "node_modules", "pi-webaio", "package.json"), "utf8"),
		);
		if (
			webaioPackage.dependencies?.["wreq-js"] !== undefined ||
			!webaioRecord?.dependencyRemovals?.includes("wreq-js") ||
			webaioPackage.optionalDependencies?.playwright !== undefined ||
			!webaioRecord?.dependencyRemovals?.includes("playwright")
		) {
			throw new Error("bundled pi-webaio browser dependency removal differs from the release manifest");
		}
		const forbiddenRuntimePackages = [
			"@the-forge-flow/camoufox-pi",
			"better-sqlite3",
			"camoufox-js",
			"impit",
			"playwright",
			"playwright-core",
			"ua-parser-js",
		];
		assertDefaultPackagesAbsent(packed.files, packageJson, forbiddenRuntimePackages);
		if (packed.files.some((file) => file.path.startsWith("node_modules/@mariozechner/"))) {
			throw new Error("jouzu tarball contains a legacy Pi peer");
		}
		for (const record of releasePackages.filter((candidate) => !candidate.adapter)) {
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
			const text = publicContentForScan(file.path, readFileSync(join(directory, file.path), "utf8"));
			for (const entry of forbidden) {
				if (file.path.startsWith("node_modules/") && entry === "AWS_SECRET_ACCESS_KEY") continue;
				if (file.path.endsWith("/jose/dist/webapi/key/import.js") && entry === "BEGIN PRIVATE KEY") continue;
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
