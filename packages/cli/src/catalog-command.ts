import { existsSync, lstatSync, readFileSync } from "node:fs";
import { type CatalogConformanceResult, checkCatalogConformance } from "./model-catalog.js";
import { type CatalogSyncStatus, getCatalogStatus } from "./model-catalog-sync.js";
import type { JouzuPaths } from "./paths.js";

export type CatalogStatus = CatalogSyncStatus;

export function catalogStatus(paths: JouzuPaths, env: NodeJS.ProcessEnv = process.env): CatalogStatus {
	return getCatalogStatus(paths, env);
}

export function formatCatalogStatus(status: CatalogStatus): string {
	if (!status.configured) return `Jouzu model catalog: ${status.status}\n${status.message}`;
	const lines = [`Jouzu model catalog: ${status.status}`, `Endpoint: ${status.endpoint}`];
	if (status.catalogId) lines.push(`Catalog: ${status.catalogId}`);
	if (status.revision) lines.push(`Revision: ${status.revision} (sequence ${status.sequence})`);
	if (status.validatedAt) lines.push(`Validated: ${status.validatedAt}`);
	if (status.quarantined > 0) lines.push(`Quarantined candidates: ${status.quarantined}`);
	if (status.lastError) lines.push(`Last error: ${status.lastError.code}: ${status.lastError.message}`);
	return lines.join("\n");
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
