import { existsSync, lstatSync, readFileSync } from "node:fs";
import { type CatalogConformanceResult, checkCatalogConformance } from "./model-catalog.js";
import type { JouzuPaths } from "./paths.js";

export interface CatalogStatus {
	schemaVersion: 1;
	status: "unconfigured";
	configured: false;
	message: string;
}

export function catalogStatus(_paths: JouzuPaths, _env: NodeJS.ProcessEnv = process.env): CatalogStatus {
	return {
		schemaVersion: 1,
		status: "unconfigured",
		configured: false,
		message: "No model catalog endpoint is configured. Jouzu continues using Pi and local model configuration.",
	};
}

export function formatCatalogStatus(status: CatalogStatus): string {
	return `Jouzu model catalog: ${status.status}\n${status.message}`;
}

export function validateCatalogFile(path: string, remote: boolean): CatalogConformanceResult {
	if (!existsSync(path)) {
		return {
			valid: false,
			error: { code: "invalid_json", path: "$", message: `catalog file does not exist: ${path}` },
		};
	}
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		return {
			valid: false,
			error: { code: "invalid_json", path: "$", message: `catalog path must be a regular file: ${path}` },
		};
	}
	return checkCatalogConformance(readFileSync(path, "utf8"), { remote });
}
