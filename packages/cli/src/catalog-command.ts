import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolveCatalogSources } from "./catalog-sources.js";
import { type CatalogConformanceResult, checkCatalogConformance } from "./model-catalog.js";
import {
	type CatalogStatuses,
	type CatalogSyncStatus,
	getCatalogSourceStatus,
	getCatalogStatuses,
} from "./model-catalog-sync.js";
import type { JouzuPaths } from "./paths.js";

export type CatalogStatus = CatalogStatuses;

export function catalogStatus(
	paths: JouzuPaths,
	env: NodeJS.ProcessEnv = process.env,
	sourceId?: string,
): CatalogStatus | CatalogSyncStatus {
	if (!sourceId) return getCatalogStatuses(paths, env);
	const source = resolveCatalogSources(paths, env, { includeDisabled: true }).find(
		(candidate) => candidate.id === sourceId,
	);
	if (!source) throw new Error(`catalog source not found: ${sourceId}`);
	return getCatalogSourceStatus(paths, source, new Date(), env);
}

function formatOneCatalogStatus(status: CatalogSyncStatus): string[] {
	if (!status.configured) return [`Jouzu model catalog: ${status.status}`, status.message];
	const lines = [
		`${status.label} [${status.sourceId}]: ${status.enabled ? status.status : "disabled"}`,
		`  Endpoint: ${status.endpoint}`,
	];
	if (status.catalogId) lines.push(`  Catalog: ${status.catalogId}`);
	if (status.offeringCount !== undefined) lines.push(`  Models: ${status.offeringCount}`);
	if (status.revision) lines.push(`  Revision: ${status.revision} (sequence ${status.sequence})`);
	if (status.validatedAt) lines.push(`  Validated: ${status.validatedAt}`);
	if (status.credentialName) {
		lines.push(
			`  Credential: environment variable ${status.credentialName} (${status.credentialAvailable ? "set" : "not set"})`,
		);
	}
	if (status.conflict) lines.push(`  Warning: ${status.conflict}`);
	if (status.quarantined > 0) lines.push(`  Quarantined candidates: ${status.quarantined}`);
	if (status.lastError) lines.push(`  Last error: ${status.lastError.code}: ${status.lastError.message}`);
	return lines;
}

export function formatCatalogStatus(status: CatalogStatus | CatalogSyncStatus): string {
	if (!("sources" in status)) return formatOneCatalogStatus(status).join("\n");
	if (status.status === "unconfigured") {
		return "Jouzu model catalogs: unconfigured\nNo model catalog endpoint is configured. Jouzu continues using Pi and local model configuration.";
	}
	const lines = [`Jouzu model catalogs: ${status.status} (${status.active}/${status.configured} active)`];
	for (const source of status.sources) lines.push(...formatOneCatalogStatus(source));
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
