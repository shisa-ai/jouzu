import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	DefaultPackageManager,
	DefaultResourceLoader,
	LoadExtensionsResult,
	ResolvedPaths,
	ResolvedResource,
} from "@earendil-works/pi-coding-agent";

export interface ReleaseExtensionPackage {
	name: string;
	version: string;
	source: string;
	integrity?: string;
	commit?: string;
	repository: string;
	license: string;
	licenseEvidence: string;
	extensions: string[];
	skills: string[];
	adapter?: "jouzu-lazy-camoufox";
	engineOverride?: string;
	dependencyOverrides?: Record<string, string>;
	peerDependenciesRemoved?: boolean;
}

export interface ReleaseCompatibilityDependency {
	name: string;
	version: string;
	integrity: string;
	repository: string;
	license: string;
	licenseEvidence: string;
}

export interface ReleaseExtensionManifest {
	schemaVersion: 1;
	packages: ReleaseExtensionPackage[];
	compatibilityDependencies: ReleaseCompatibilityDependency[];
}

export interface ReleaseExtensionStatus {
	manifest: ReleaseExtensionManifest;
	extensionCount: number;
	skillCount: number;
	resolvedExtensionPaths: string[];
	resolvedSkillPaths: string[];
	resolvedPackageRoots: Record<string, string>;
	errors: string[];
}

const require = createRequire(import.meta.url);
const PACKAGE_COMMANDS = new Set(["config", "install", "list", "remove", "uninstall", "update"]);
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]+$/u;

function readManifest(): ReleaseExtensionManifest {
	const path = new URL("./release-extensions.json", import.meta.url);
	const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ReleaseExtensionManifest>;
	if (value.schemaVersion !== 1 || !Array.isArray(value.packages) || !Array.isArray(value.compatibilityDependencies)) {
		throw new Error("release extension manifest is invalid");
	}
	return value as ReleaseExtensionManifest;
}

function packageRootFromEntry(name: string, entry: string): string {
	let current = dirname(entry);
	while (true) {
		const packageJson = join(current, "package.json");
		if (existsSync(packageJson)) {
			try {
				const metadata = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown };
				if (metadata.name === name) return current;
			} catch {
				// Continue toward the filesystem root and report one bounded error to the caller.
			}
		}
		const parent = dirname(current);
		if (parent === current) throw new Error(`could not locate package root from ${entry}`);
		current = parent;
	}
}

function resolvePackageRoot(name: string): string {
	try {
		return dirname(require.resolve(`${name}/package.json`));
	} catch {
		try {
			return packageRootFromEntry(name, require.resolve(name));
		} catch {
			return packageRootFromEntry(name, fileURLToPath(import.meta.resolve(name)));
		}
	}
}

function validatePackageRoot(record: Pick<ReleaseExtensionPackage, "name" | "version">, root: string): void {
	const packageJson = join(root, "package.json");
	const stat = lstatSync(packageJson);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("package.json is not a regular file");
	const metadata = JSON.parse(readFileSync(packageJson, "utf8")) as { name?: unknown; version?: unknown };
	if (metadata.name !== record.name || metadata.version !== record.version) {
		throw new Error(
			`resolved ${String(metadata.name)}@${String(metadata.version)} instead of ${record.name}@${record.version}`,
		);
	}
}

function resolveResource(root: string, resource: string): string {
	if (!SAFE_RELATIVE_PATH.test(resource) || isAbsolute(resource)) throw new Error(`unsafe resource path ${resource}`);
	const path = resolve(root, resource);
	const rel = relative(realpathSync(root), realpathSync(path));
	if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
		throw new Error(`resource escapes package root: ${resource}`);
	}
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`resource is not a regular file: ${resource}`);
	return path;
}

function resolveAdapter(adapter: ReleaseExtensionPackage["adapter"]): string {
	if (adapter !== "jouzu-lazy-camoufox") throw new Error(`unsupported release adapter: ${String(adapter)}`);
	const path = fileURLToPath(new URL("./camoufox-adapter.js", import.meta.url));
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("release adapter is not a regular file");
	return path;
}

export function inspectReleaseExtensions(): ReleaseExtensionStatus {
	const manifest = readManifest();
	const resolvedExtensionPaths: string[] = [];
	const resolvedSkillPaths: string[] = [];
	const resolvedPackageRoots: Record<string, string> = {};
	const errors: string[] = [];
	let extensionCount = 0;
	let skillCount = 0;

	for (const record of manifest.packages) {
		extensionCount += record.extensions.length;
		skillCount += record.skills.length;
		try {
			const root = resolvePackageRoot(record.name);
			validatePackageRoot(record, root);
			resolvedPackageRoots[record.name] = root;
			if (record.adapter) {
				resolvedExtensionPaths.push(resolveAdapter(record.adapter));
			} else {
				for (const resource of record.extensions) resolvedExtensionPaths.push(resolveResource(root, resource));
			}
			for (const resource of record.skills) resolvedSkillPaths.push(resolveResource(root, resource));
		} catch (error) {
			errors.push(`${record.name}@${record.version}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	for (const record of manifest.compatibilityDependencies) {
		try {
			const root = resolvePackageRoot(record.name);
			validatePackageRoot(record, root);
			resolvedPackageRoots[record.name] = root;
		} catch (error) {
			errors.push(`${record.name}@${record.version}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return {
		manifest,
		extensionCount,
		skillCount,
		resolvedExtensionPaths,
		resolvedSkillPaths,
		resolvedPackageRoots,
		errors,
	};
}

function releaseResourceIndex(
	manifest: ReleaseExtensionManifest,
): Map<string, { extensions: Set<string>; skills: Set<string> }> {
	return new Map(
		manifest.packages.map((record) => [
			record.name,
			{
				extensions: new Set(record.extensions.map((path) => path.replaceAll("\\", "/"))),
				skills: new Set(record.skills.map((path) => path.replaceAll("\\", "/"))),
			},
		]),
	);
}

function configuredPackageName(resource: ResolvedResource, cache: Map<string, string | undefined>): string | undefined {
	const baseDir = resource.metadata.baseDir;
	if (resource.metadata.origin !== "package" || !baseDir) return undefined;
	if (cache.has(baseDir)) return cache.get(baseDir);
	let name: string | undefined;
	try {
		const metadata = JSON.parse(readFileSync(join(baseDir, "package.json"), "utf8")) as { name?: unknown };
		if (typeof metadata.name === "string") name = metadata.name;
	} catch {
		// Pi reports unreadable package metadata; this filter leaves that diagnostic unchanged.
	}
	cache.set(baseDir, name);
	return name;
}

function suppressMatchingPackageResources(
	resources: ResolvedResource[],
	type: "extensions" | "skills",
	index: ReturnType<typeof releaseResourceIndex>,
	packageNames: Map<string, string | undefined>,
): ResolvedResource[] {
	return resources.map((resource) => {
		const baseDir = resource.metadata.baseDir;
		const name = configuredPackageName(resource, packageNames);
		const selected = name ? index.get(name)?.[type] : undefined;
		if (!baseDir || !selected || selected.size === 0) return resource;
		const relativePath = relative(resolve(baseDir), resolve(resource.path)).replaceAll("\\", "/");
		if (!selected.has(relativePath)) return resource;
		return resource.enabled ? { ...resource, enabled: false } : resource;
	});
}

export function suppressConfiguredReleaseResources(
	paths: ResolvedPaths,
	manifest: ReleaseExtensionManifest,
): ResolvedPaths {
	const index = releaseResourceIndex(manifest);
	const packageNames = new Map<string, string | undefined>();
	return {
		...paths,
		extensions: suppressMatchingPackageResources(paths.extensions, "extensions", index, packageNames),
		skills: suppressMatchingPackageResources(paths.skills, "skills", index, packageNames),
	};
}

export function consolidateReleaseToolConflicts(
	result: LoadExtensionsResult,
	releaseExtensionPaths: string[],
): LoadExtensionsResult {
	const releasePaths = new Set(releaseExtensionPaths.map((path) => resolve(path)));
	const errors: LoadExtensionsResult["errors"] = [];
	const grouped = new Map<string, { index: number; tools: Set<string> }>();
	for (const diagnostic of result.errors) {
		const match = /^Tool "([^"]+)" conflicts with (.+)$/u.exec(diagnostic.error);
		if (!match?.[1] || !match[2] || !releasePaths.has(resolve(match[2]))) {
			errors.push(diagnostic);
			continue;
		}
		let group = grouped.get(diagnostic.path);
		if (!group) {
			group = { index: errors.length, tools: new Set() };
			grouped.set(diagnostic.path, group);
			errors.push({ path: diagnostic.path, error: "" });
		}
		group.tools.add(match[1]);
	}
	for (const [path, group] of grouped) {
		const tools = [...group.tools].sort();
		const label = tools.length === 1 ? `tool "${tools[0]}"` : `tools ${tools.map((tool) => `"${tool}"`).join(", ")}`;
		errors[group.index] = {
			path,
			error: `conflicts with Jouzu release-owned ${label}; disable this extension or its package with \`jz config\``,
		};
	}
	return errors.length === result.errors.length && errors.every((error, index) => error === result.errors[index])
		? result
		: { ...result, errors };
}

export interface ReleaseConflictRuntime {
	DefaultPackageManager: typeof DefaultPackageManager;
	DefaultResourceLoader: typeof DefaultResourceLoader;
}

export async function withReleaseExtensionConflictPolicy<T>(
	runtime: ReleaseConflictRuntime,
	status: ReleaseExtensionStatus,
	operation: () => Promise<T>,
): Promise<T> {
	const packagePrototype = runtime.DefaultPackageManager.prototype;
	const resourcePrototype = runtime.DefaultResourceLoader.prototype;
	const originalResolve = packagePrototype.resolve;
	const originalGetExtensions = resourcePrototype.getExtensions;
	const filteredResolve: DefaultPackageManager["resolve"] = async function (this: DefaultPackageManager, onMissing) {
		const paths = await originalResolve.call(this, onMissing);
		return suppressConfiguredReleaseResources(paths, status.manifest);
	};
	const filteredGetExtensions: DefaultResourceLoader["getExtensions"] = function (this: DefaultResourceLoader) {
		return consolidateReleaseToolConflicts(originalGetExtensions.call(this), status.resolvedExtensionPaths);
	};
	packagePrototype.resolve = filteredResolve;
	resourcePrototype.getExtensions = filteredGetExtensions;
	try {
		return await operation();
	} finally {
		if (packagePrototype.resolve === filteredResolve) packagePrototype.resolve = originalResolve;
		if (resourcePrototype.getExtensions === filteredGetExtensions) {
			resourcePrototype.getExtensions = originalGetExtensions;
		}
	}
}

export function usesReleaseExtensions(args: string[]): boolean {
	return !(args[0] && PACKAGE_COMMANDS.has(args[0]));
}

export function withReleaseExtensionArguments(args: string[], status = inspectReleaseExtensions()): string[] {
	if (!usesReleaseExtensions(args)) return args;
	if (status.errors.length > 0) {
		throw new Error(`release-owned extensions are unavailable: ${status.errors.join("; ")}`);
	}
	const resourceArguments = [
		...status.resolvedExtensionPaths.flatMap((path) => ["--extension", path]),
		...status.resolvedSkillPaths.flatMap((path) => ["--skill", path]),
	];
	return [...resourceArguments, ...args];
}
