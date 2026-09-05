import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const VARIANT_PATTERN = /^@mariozechner\/(clipboard-[a-z0-9]+(?:-[a-z0-9]+)*)$/u;
// These exact upstream packages publish metadata but no native file. Keeping
// the version in the exception forces a new release to be checked again.
const KNOWN_PLACEHOLDERS = new Map([
	["@mariozechner/clipboard-linux-arm64-musl", "0.3.9"],
	["@mariozechner/clipboard-linux-x64-musl", "0.3.9"],
]);

export function deriveClipboardBindingRequirements(clipboardPackageJson) {
	const variants = Object.entries(clipboardPackageJson?.optionalDependencies ?? {});
	if (variants.length === 0) {
		throw new Error("@mariozechner/clipboard declares no platform binding variants");
	}
	return variants.map(([name, version]) => {
		const match = VARIANT_PATTERN.exec(name);
		if (!match || typeof version !== "string" || !version) {
			throw new Error(`unexpected clipboard binding dependency ${name}`);
		}
		const packageName = match[1];
		return {
			name,
			packageName,
			version,
			entrypoint: `${packageName.replace(/^clipboard-/u, "clipboard.")}.node`,
			placeholder: KNOWN_PLACEHOLDERS.get(name) === version,
		};
	});
}

export function assertClipboardBindingDirectory(root, requirement) {
	const rootMetadata = lstatSync(root);
	if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
		throw new Error(`${requirement.name} is not a real package directory`);
	}
	const packagePath = join(root, "package.json");
	const packageMetadata = lstatSync(packagePath);
	if (!packageMetadata.isFile() || packageMetadata.isSymbolicLink()) {
		throw new Error(`${requirement.name} package.json is not a regular file`);
	}
	const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
	if (
		packageJson.name !== requirement.name ||
		packageJson.version !== requirement.version ||
		packageJson.main !== requirement.entrypoint
	) {
		throw new Error(`${requirement.name} package metadata does not match its locked binding requirement`);
	}
	const entrypoint = join(root, requirement.entrypoint);
	if (!existsSync(entrypoint)) {
		if (requirement.placeholder) return;
		throw new Error(
			`${requirement.name}@${requirement.version} is missing native entrypoint ${requirement.entrypoint}`,
		);
	}
	const entrypointMetadata = lstatSync(entrypoint);
	if (!entrypointMetadata.isFile() || entrypointMetadata.isSymbolicLink()) {
		throw new Error(`${requirement.name} native entrypoint is not a regular file`);
	}
}

export function clipboardBindingDirectoryIsComplete(root, requirement) {
	try {
		assertClipboardBindingDirectory(root, requirement);
		return true;
	} catch {
		return false;
	}
}
