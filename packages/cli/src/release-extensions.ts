import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	DefaultPackageManager,
	DefaultResourceLoader,
	InlineExtension,
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
	optional?: boolean;
	tools?: string[];
	adapter?: "jouzu-lazy-camoufox";
	engineOverride?: string;
	dependencyOverrides?: Record<string, string>;
	dependencyRemovals?: string[];
	peerDependenciesRemoved?: boolean;
}

export interface ReleaseCompatibilityDependency {
	name: string;
	version: string;
	bundled?: false;
	integrity: string;
	repository: string;
	license: string;
	licenseEvidence: string;
}

export interface ReleaseRuntimeDependencyRedirect {
	consumer: string;
	dependency: string;
	version: string;
}

export interface ReleaseExtensionManifest {
	schemaVersion: 1;
	packages: ReleaseExtensionPackage[];
	compatibilityDependencies: ReleaseCompatibilityDependency[];
	runtimeDependencyRedirects: ReleaseRuntimeDependencyRedirect[];
}

export interface ResolvedReleaseExtension {
	packageName: string;
	packageVersion: string;
	path: string;
	optional: boolean;
	tools: string[];
}

export interface ReleaseExtensionFailure {
	packageName: string;
	packageVersion: string;
	path?: string;
	tools: string[];
	error: string;
}

export interface ReleaseExtensionStatus {
	manifest: ReleaseExtensionManifest;
	extensionCount: number;
	skillCount: number;
	resolvedExtensions: ResolvedReleaseExtension[];
	resolvedExtensionPaths: string[];
	resolvedSkillPaths: string[];
	resolvedPackageRoots: Record<string, string>;
	degradedExtensions: ReleaseExtensionFailure[];
	errors: string[];
}

const require = createRequire(import.meta.url);
const PACKAGE_COMMANDS = new Set(["config", "install", "list", "remove", "uninstall", "update"]);
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]+$/u;

function readManifest(): ReleaseExtensionManifest {
	const path = new URL("./release-extensions.json", import.meta.url);
	const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ReleaseExtensionManifest>;
	if (
		value.schemaVersion !== 1 ||
		!Array.isArray(value.packages) ||
		!Array.isArray(value.compatibilityDependencies) ||
		!Array.isArray(value.runtimeDependencyRedirects)
	) {
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

function messageFromError(error: unknown): string {
	const messages: string[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current);
		messages.push(current instanceof Error ? current.message : String(current));
		current = current instanceof Error ? current.cause : undefined;
	}
	return messages.map((message, index) => (index === 0 ? message : `Caused by: ${message}`)).join("\n");
}

export function markReleaseExtensionUnavailable(
	status: ReleaseExtensionStatus,
	packageName: string,
	error: unknown,
	path?: string,
): boolean {
	const record = status.manifest.packages.find((candidate) => candidate.name === packageName);
	if (!record) throw new Error(`unknown release extension ${packageName}`);
	const message = messageFromError(error);
	if (!record.optional) {
		const diagnostic = `${record.name}@${record.version}: ${message}`;
		if (!status.errors.includes(diagnostic)) status.errors.push(diagnostic);
		return false;
	}
	const existing = status.degradedExtensions.find((candidate) => candidate.packageName === record.name);
	if (existing) {
		if (!existing.error.split("; ").includes(message)) existing.error = `${existing.error}; ${message}`;
		if (!existing.path && path) existing.path = path;
	} else {
		status.degradedExtensions.push({
			packageName: record.name,
			packageVersion: record.version,
			...(path ? { path } : {}),
			tools: [...(record.tools ?? [])],
			error: message,
		});
	}
	const unavailablePaths = new Set(
		status.resolvedExtensions
			.filter((candidate) => candidate.packageName === record.name)
			.map((candidate) => candidate.path),
	);
	status.resolvedExtensionPaths = status.resolvedExtensionPaths.filter((candidate) => !unavailablePaths.has(candidate));
	const packageRoot = status.resolvedPackageRoots[record.name];
	if (packageRoot) {
		status.resolvedSkillPaths = status.resolvedSkillPaths.filter((candidate) => {
			const rel = relative(packageRoot, candidate);
			return rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
		});
	}
	return true;
}

export function inspectReleaseExtensions(): ReleaseExtensionStatus {
	const manifest = readManifest();
	const status: ReleaseExtensionStatus = {
		manifest,
		extensionCount: 0,
		skillCount: 0,
		resolvedExtensions: [],
		resolvedExtensionPaths: [],
		resolvedSkillPaths: [],
		resolvedPackageRoots: {},
		degradedExtensions: [],
		errors: [],
	};

	for (const record of manifest.packages) {
		status.extensionCount += record.extensions.length;
		status.skillCount += record.skills.length;
		try {
			let extensionPaths: string[];
			if (record.adapter) {
				if (record.skills.length > 0) throw new Error("release adapters cannot declare package skills");
				extensionPaths = [resolveAdapter(record.adapter)];
			} else {
				const root = resolvePackageRoot(record.name);
				validatePackageRoot(record, root);
				status.resolvedPackageRoots[record.name] = root;
				extensionPaths = record.extensions.map((resource) => resolveResource(root, resource));
				for (const resource of record.skills) status.resolvedSkillPaths.push(resolveResource(root, resource));
			}
			for (const path of extensionPaths) {
				status.resolvedExtensions.push({
					packageName: record.name,
					packageVersion: record.version,
					path,
					optional: record.optional === true,
					tools: [...(record.tools ?? [])],
				});
				status.resolvedExtensionPaths.push(path);
			}
		} catch (error) {
			markReleaseExtensionUnavailable(status, record.name, error);
		}
	}
	for (const record of manifest.compatibilityDependencies) {
		try {
			const root = resolvePackageRoot(record.name);
			validatePackageRoot(record, root);
			status.resolvedPackageRoots[record.name] = root;
		} catch (error) {
			status.errors.push(`${record.name}@${record.version}: ${messageFromError(error)}`);
		}
	}

	return status;
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

export function omitOptionalReleaseExtensionFailures(
	result: LoadExtensionsResult,
	status: ReleaseExtensionStatus,
): LoadExtensionsResult {
	const optionalByPath = new Map(
		status.resolvedExtensions
			.filter((record) => record.optional)
			.map((record) => [resolve(record.path), record] as const),
	);
	const errors: LoadExtensionsResult["errors"] = [];
	for (const diagnostic of result.errors) {
		const record = optionalByPath.get(resolve(diagnostic.path));
		if (!record) {
			errors.push(diagnostic);
			continue;
		}
		markReleaseExtensionUnavailable(status, record.packageName, diagnostic.error, diagnostic.path);
	}
	return errors.length === result.errors.length ? result : { ...result, errors };
}

export function formatReleaseExtensionFailure(failure: ReleaseExtensionFailure): string {
	const tools = failure.tools.length > 0 ? ` Disabled tools: ${failure.tools.join(", ")}.` : "";
	return `Optional extension ${failure.packageName}@${failure.packageVersion} is unavailable.${tools} ${failure.error} Run \`jz doctor\` for details.`;
}

export function createReleaseExtensionDiagnostics(status: ReleaseExtensionStatus): InlineExtension {
	return {
		name: "jouzu-release-extension-diagnostics",
		factory: (pi) => {
			pi.on("session_start", (_event, context) => {
				for (const failure of status.degradedExtensions) {
					const message = formatReleaseExtensionFailure(failure);
					if (context.hasUI) context.ui.notify(message, "warning");
					else console.error(`Jouzu warning: ${message}`);
				}
			});
		},
	};
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
		const consolidated = consolidateReleaseToolConflicts(
			originalGetExtensions.call(this),
			status.resolvedExtensionPaths,
		);
		return omitOptionalReleaseExtensionFailures(consolidated, status);
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

const PACKAGE_NAME = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/u;

function dependencyPath(root: string, name: string): string {
	if (!PACKAGE_NAME.test(name)) throw new Error(`unsafe package name ${name}`);
	return join(root, "node_modules", ...name.split("/"));
}

function resolveDependencyFromConsumer(consumerRoot: string, record: ReleaseRuntimeDependencyRedirect): string {
	const consumerRequire = createRequire(join(consumerRoot, "package.json"));
	let root: string;
	try {
		root = dirname(consumerRequire.resolve(`${record.dependency}/package.json`));
	} catch {
		root = packageRootFromEntry(record.dependency, consumerRequire.resolve(record.dependency));
	}
	validatePackageRoot({ name: record.dependency, version: record.version }, root);
	consumerRequire(record.dependency);
	return root;
}

/**
 * Remove one incompatible nested native package only after the exact compatible
 * direct dependency is present. The rename makes rollback possible if resolving
 * or loading the replacement fails.
 */
export function repairRuntimeDependencyRedirect(
	record: ReleaseRuntimeDependencyRedirect,
	packageRoots: Record<string, string>,
): boolean {
	const consumerRoot = packageRoots[record.consumer];
	const replacementRoot = packageRoots[record.dependency];
	if (!consumerRoot) throw new Error(`runtime compatibility consumer ${record.consumer} is unavailable`);
	if (!replacementRoot) throw new Error(`runtime compatibility dependency ${record.dependency} is unavailable`);
	validatePackageRoot({ name: record.dependency, version: record.version }, replacementRoot);

	const nestedRoot = dependencyPath(consumerRoot, record.dependency);
	if (!existsSync(nestedRoot)) {
		resolveDependencyFromConsumer(consumerRoot, record);
		return false;
	}
	const stat = lstatSync(nestedRoot);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`${record.consumer} has an unsafe nested ${record.dependency} entry`);
	}
	const nestedMetadata = JSON.parse(readFileSync(join(nestedRoot, "package.json"), "utf8")) as {
		name?: unknown;
		version?: unknown;
	};
	if (nestedMetadata.name !== record.dependency) {
		throw new Error(`${record.consumer} nested dependency identifies as ${String(nestedMetadata.name)}`);
	}
	if (nestedMetadata.version === record.version) {
		resolveDependencyFromConsumer(consumerRoot, record);
		return false;
	}

	const backupRoot = `${nestedRoot}.jouzu-compat-${process.pid}`;
	if (existsSync(backupRoot)) throw new Error(`stale compatibility backup exists at ${backupRoot}`);
	renameSync(nestedRoot, backupRoot);
	try {
		resolveDependencyFromConsumer(consumerRoot, record);
		rmSync(backupRoot, { recursive: true, force: true });
		return true;
	} catch (error) {
		if (existsSync(nestedRoot)) rmSync(nestedRoot, { recursive: true, force: true });
		renameSync(backupRoot, nestedRoot);
		throw error;
	}
}

function resolveOverriddenDependencyRoot(consumerRoot: string, name: string): string {
	if (!PACKAGE_NAME.test(name)) throw new Error(`unsafe package name ${name}`);
	const consumerRequire = createRequire(join(consumerRoot, "package.json"));
	try {
		return dirname(consumerRequire.resolve(`${name}/package.json`));
	} catch {
		return packageRootFromEntry(name, consumerRequire.resolve(name));
	}
}

export function probeReleaseRuntimeCompatibility(status = inspectReleaseExtensions()): void {
	for (const record of status.manifest.packages) {
		const root = status.resolvedPackageRoots[record.name];
		if (!root || status.degradedExtensions.some((failure) => failure.packageName === record.name)) continue;
		for (const [name, version] of Object.entries(record.dependencyOverrides ?? {})) {
			try {
				const dependencyRoot = resolveOverriddenDependencyRoot(root, name);
				validatePackageRoot({ name, version }, dependencyRoot);
				createRequire(join(root, "package.json"))(name);
			} catch (error) {
				markReleaseExtensionUnavailable(status, record.name, error);
			}
		}
	}
	for (const record of status.manifest.runtimeDependencyRedirects) {
		if (status.degradedExtensions.some((failure) => failure.packageName === record.consumer)) continue;
		try {
			const replacementRoot = status.resolvedPackageRoots[record.dependency];
			if (!replacementRoot) throw new Error(`runtime compatibility dependency ${record.dependency} is unavailable`);
			validatePackageRoot({ name: record.dependency, version: record.version }, replacementRoot);
			require(replacementRoot);
		} catch (error) {
			markReleaseExtensionUnavailable(status, record.consumer, error);
		}
	}
}

export function ensureReleaseRuntimeCompatibility(status = inspectReleaseExtensions()): string[] {
	const repaired: string[] = [];
	for (const record of status.manifest.runtimeDependencyRedirects) {
		if (status.degradedExtensions.some((failure) => failure.packageName === record.consumer)) continue;
		try {
			if (repairRuntimeDependencyRedirect(record, status.resolvedPackageRoots)) {
				repaired.push(`${record.consumer} -> ${record.dependency}@${record.version}`);
			}
		} catch (error) {
			markReleaseExtensionUnavailable(status, record.consumer, error);
		}
	}
	return repaired;
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
