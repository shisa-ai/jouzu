import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProfileId } from "./args.js";

const MANIFEST_FIELDS = new Set(["schemaVersion", "id", "version", "extends", "assets"]);
const ASSET_FIELDS = new Set(["source", "target", "sha256"]);
const SHA256_RE = /^[0-9a-f]{64}$/;

interface ProfileAssetManifest {
	source: string;
	target: string;
	sha256: string;
}

interface ProfileManifest {
	schemaVersion: number;
	id: ProfileId;
	version: number;
	extends?: "core";
	assets: ProfileAssetManifest[];
}

export interface ResolvedProfileAsset {
	target: string;
	sha256: string;
	bytes: Buffer;
}

export interface ResolvedProfile {
	id: ProfileId;
	version: number;
	manifestSha256: string;
	assets: ResolvedProfileAsset[];
}

export class ProfileManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProfileManifestError";
	}
}

function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertExactFields(value: Record<string, unknown>, fields: Set<string>, subject: string): void {
	const unknown = Object.keys(value).filter((key) => !fields.has(key));
	if (unknown.length > 0) throw new ProfileManifestError(`${subject} has unknown fields: ${unknown.sort().join(", ")}`);
}

function safeRelativePath(value: string, subject: string): string[] {
	if (!value || value.startsWith("/") || value.includes("\\")) {
		throw new ProfileManifestError(`${subject} must be a relative POSIX path`);
	}
	const parts = value.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) {
		throw new ProfileManifestError(`${subject} contains an unsafe path segment`);
	}
	return parts;
}

function validateTarget(target: string): void {
	const parts = safeRelativePath(target, `profile target ${target}`);
	if (target === "APPEND_SYSTEM.md") return;
	if (parts[0] === "skills" && parts.length >= 3 && parts[1].startsWith("jouzu-") && parts.at(-1) === "SKILL.md") {
		return;
	}
	if (parts[0] === "prompts" && parts.length === 2 && parts[1].startsWith("jouzu-") && parts[1].endsWith(".md")) {
		return;
	}
	throw new ProfileManifestError(`unsupported profile target: ${target}`);
}

function readManifest(root: string, id: ProfileId): ProfileManifest {
	const manifestPath = resolve(root, id, "manifest.json");
	let metadata: ReturnType<typeof lstatSync>;
	try {
		metadata = lstatSync(manifestPath);
	} catch {
		throw new ProfileManifestError(`profile ${id} manifest is missing`);
	}
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		throw new ProfileManifestError(`profile ${id} manifest must be a regular file`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		throw new ProfileManifestError(
			`profile ${id} manifest is invalid JSON: ${error instanceof Error ? error.message : error}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ProfileManifestError(`profile ${id} manifest must be an object`);
	}
	const value = parsed as Record<string, unknown>;
	assertExactFields(value, MANIFEST_FIELDS, `profile ${id} manifest`);
	if (value.schemaVersion !== 1 || value.id !== id || !Number.isInteger(value.version) || Number(value.version) < 1) {
		throw new ProfileManifestError(`profile ${id} manifest has invalid schema, id, or version`);
	}
	if ((id === "core" && value.extends !== undefined) || (id === "ja" && value.extends !== "core")) {
		throw new ProfileManifestError(`profile ${id} has invalid inheritance`);
	}
	if (!Array.isArray(value.assets)) throw new ProfileManifestError(`profile ${id} assets must be an array`);
	const assets = value.assets.map((entry, index): ProfileAssetManifest => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new ProfileManifestError(`profile ${id} asset ${index} must be an object`);
		}
		const asset = entry as Record<string, unknown>;
		assertExactFields(asset, ASSET_FIELDS, `profile ${id} asset ${index}`);
		if (typeof asset.source !== "string" || typeof asset.target !== "string" || typeof asset.sha256 !== "string") {
			throw new ProfileManifestError(`profile ${id} asset ${index} fields must be strings`);
		}
		const sourceParts = safeRelativePath(asset.source, `profile ${id} asset source`);
		if (sourceParts[0] !== "assets") throw new ProfileManifestError(`profile ${id} asset source must be below assets/`);
		validateTarget(asset.target);
		if (!SHA256_RE.test(asset.sha256)) throw new ProfileManifestError(`profile ${id} asset has invalid SHA-256`);
		return { source: asset.source, target: asset.target, sha256: asset.sha256 };
	});
	return {
		schemaVersion: 1,
		id,
		version: Number(value.version),
		...(value.extends === "core" ? { extends: "core" as const } : {}),
		assets,
	};
}

function loadOwnAssets(root: string, manifest: ProfileManifest): ResolvedProfileAsset[] {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	return manifest.assets.map((asset) => {
		const sourcePath = resolve(root, manifest.id, ...asset.source.split("/"));
		const expectedParent = resolve(root, manifest.id, dirname(asset.source));
		if (dirname(sourcePath) !== expectedParent)
			throw new ProfileManifestError(`profile ${manifest.id} asset escaped its root`);
		let metadata: ReturnType<typeof lstatSync>;
		try {
			metadata = lstatSync(sourcePath);
		} catch {
			throw new ProfileManifestError(`profile ${manifest.id} asset is missing: ${asset.source}`);
		}
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new ProfileManifestError(`profile ${manifest.id} asset must be a regular file: ${asset.source}`);
		}
		const bytes = readFileSync(sourcePath);
		try {
			decoder.decode(bytes);
		} catch {
			throw new ProfileManifestError(`profile ${manifest.id} asset is not valid UTF-8: ${asset.source}`);
		}
		if (bytes.includes(0))
			throw new ProfileManifestError(`profile ${manifest.id} asset contains NUL bytes: ${asset.source}`);
		if (sha256(bytes) !== asset.sha256) {
			throw new ProfileManifestError(`profile ${manifest.id} asset digest mismatch: ${asset.source}`);
		}
		return { target: asset.target, sha256: asset.sha256, bytes };
	});
}

export function loadProfileFromRoot(root: string, id: ProfileId): ResolvedProfile {
	const manifest = readManifest(root, id);
	const inherited = manifest.extends === "core" ? loadProfileFromRoot(root, "core").assets : [];
	const assets = [...inherited, ...loadOwnAssets(root, manifest)].sort((left, right) =>
		left.target.localeCompare(right.target),
	);
	const targets = new Set<string>();
	for (const asset of assets) {
		if (targets.has(asset.target)) throw new ProfileManifestError(`duplicate resolved profile target: ${asset.target}`);
		targets.add(asset.target);
	}
	const canonical = JSON.stringify({
		profile: id,
		profileVersion: manifest.version,
		targets: assets.map((asset) => ({ target: asset.target, sha256: asset.sha256 })),
	});
	return { id, version: manifest.version, manifestSha256: sha256(canonical), assets };
}

export function loadBundledProfile(id: ProfileId): ResolvedProfile {
	return loadProfileFromRoot(fileURLToPath(new URL("./profiles/", import.meta.url)), id);
}
