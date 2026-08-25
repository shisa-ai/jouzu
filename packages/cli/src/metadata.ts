import { readFileSync } from "node:fs";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

interface PackageMetadata {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
}

export interface PiLock {
	schemaVersion: number;
	repository: string;
	tag: string;
	tagCommit: string;
	commit: string;
	packages: Record<string, { version: string; integrity: string }>;
	reviewedAt: string | null;
	compatibilityStatus: string;
	deviations: unknown[];
}

export interface JouzuBuildInfo {
	schemaVersion: 1;
	builtAt: string;
	gitCommit: string;
	gitDirty: boolean;
}

export interface JouzuMetadata {
	jouzuVersion: string;
	displayVersion: string;
	build: JouzuBuildInfo | undefined;
	piVersion: string;
	profileSchemaVersion: number;
	lock: PiLock;
}

function readJson<T>(url: URL): T {
	return JSON.parse(readFileSync(url, "utf8")) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBuildInfo(value: unknown): JouzuBuildInfo {
	if (!isRecord(value)) throw new Error("Jouzu build metadata must be an object");
	const keys = Object.keys(value).sort();
	if (keys.join(",") !== "builtAt,gitCommit,gitDirty,schemaVersion") {
		throw new Error("Jouzu build metadata has unsupported fields");
	}
	if (value.schemaVersion !== 1) throw new Error("unsupported Jouzu build metadata schema");
	if (
		typeof value.builtAt !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.builtAt) ||
		Number.isNaN(Date.parse(value.builtAt)) ||
		new Date(value.builtAt).toISOString() !== value.builtAt
	) {
		throw new Error("Jouzu build timestamp must be a canonical UTC instant");
	}
	if (typeof value.gitCommit !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value.gitCommit)) {
		throw new Error("Jouzu build commit must be a full Git object ID");
	}
	if (typeof value.gitDirty !== "boolean") throw new Error("Jouzu build dirty flag must be boolean");
	return {
		schemaVersion: 1,
		builtAt: value.builtAt,
		gitCommit: value.gitCommit,
		gitDirty: value.gitDirty,
	};
}

export function formatDisplayVersion(jouzuVersion: string, build: JouzuBuildInfo | undefined): string {
	if (!build) return jouzuVersion;
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(build.builtAt);
	if (!match) throw new Error("Jouzu build timestamp cannot be formatted");
	const [, year, month, day, hour, minute, second] = match;
	const stamp = `${year}${month}${day}-${hour}${minute}${second}`;
	const source = `g${build.gitCommit.slice(0, 8)}${build.gitDirty ? ".dirty" : ""}`;
	return `${jouzuVersion}-dev.${stamp}+${source}`;
}

function readBuildInfo(): JouzuBuildInfo | undefined {
	try {
		return parseBuildInfo(readJson<unknown>(new URL("./build-info.json", import.meta.url)));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export function loadMetadata(): JouzuMetadata {
	const packageMetadata = readJson<PackageMetadata>(new URL("../package.json", import.meta.url));
	const lock = readJson<PiLock>(new URL("./pi.lock.json", import.meta.url));
	const piRecord = lock.packages[PI_PACKAGE];
	if (!piRecord) throw new Error(`bundled Pi lock is missing ${PI_PACKAGE}`);
	if (packageMetadata.dependencies?.[PI_PACKAGE] !== piRecord.version) {
		throw new Error(
			`Jouzu runtime dependency ${packageMetadata.dependencies?.[PI_PACKAGE] ?? "(missing)"} does not match bundled Pi lock ${piRecord.version}`,
		);
	}
	const build = readBuildInfo();
	return {
		jouzuVersion: packageMetadata.version,
		displayVersion: formatDisplayVersion(packageMetadata.version, build),
		build,
		piVersion: piRecord.version,
		profileSchemaVersion: 1,
		lock,
	};
}
