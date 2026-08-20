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
	commit: string;
	packages: Record<string, { version: string; integrity: string }>;
	reviewedAt: string | null;
	compatibilityStatus: string;
	deviations: unknown[];
}

export interface JouzuMetadata {
	jouzuVersion: string;
	piVersion: string;
	profileSchemaVersion: number;
	productLabel: string;
	lock: PiLock;
}

function readJson<T>(url: URL): T {
	return JSON.parse(readFileSync(url, "utf8")) as T;
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
	return {
		jouzuVersion: packageMetadata.version,
		piVersion: piRecord.version,
		profileSchemaVersion: 1,
		productLabel: "Agentic AI environment",
		lock,
	};
}
