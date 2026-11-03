import { existsSync, lstatSync, readFileSync } from "node:fs";
import { heldCatalogCommand, heldCatalogSummary } from "./catalog-held.js";
import { catalogInsecureTransportWarning, resolveCatalogSources } from "./catalog-sources.js";
import {
	CATALOG_FIELD_LABEL_IDS,
	CatalogMessageId,
	type CatalogMessageRef,
	type CatalogRenderOptions,
	catalogMessage,
	catalogMessageText,
	catalogText,
	defaultCatalog,
} from "./cli-messages.js";
import {
	CommandReport,
	type CommandReportCount,
	type CommandReportEntry,
	type CommandReportField,
	type CommandReportStatus,
	pluralize,
} from "./command-report.js";
import { protectedCommand } from "./human-messages.js";
import type { CatalogBundle } from "./locale-catalog.js";
import {
	type CatalogConformanceResult,
	checkCatalogConformance,
	describeCatalogRegistrationEffect,
	describeCatalogRegistrationGap,
	describeCatalogRegistrationGaps,
} from "./model-catalog.js";
import {
	type CatalogStatuses,
	type CatalogSyncStatus,
	getCatalogSourceStatus,
	getCatalogStatuses,
} from "./model-catalog-sync.js";
import type { JouzuPaths } from "./paths.js";

export type CatalogStatus = CatalogStatuses;

/**
 * The state word a reader sees in the catalog report title. The value stays a
 * state identifier in `--json`, so only the title renders through the catalog.
 */
type CatalogStateWord = CatalogStatus["status"] | CatalogSyncStatus["status"];

const CATALOG_STATE_WORD_IDS: Record<CatalogStateWord, CatalogMessageId> = {
	unconfigured: CatalogMessageId.catalogStateUnconfigured,
	empty: CatalogMessageId.catalogStateEmpty,
	active: CatalogMessageId.catalogStateActive,
	stale: CatalogMessageId.catalogStateStale,
	degraded: CatalogMessageId.catalogStateDegraded,
};

type ConfiguredCatalogStatus = Extract<CatalogSyncStatus, { configured: true }>;

/** The closing counts, matching the notes above them. */
function noteCounts(notes: readonly CommandReportEntry[], catalog: CatalogBundle): CommandReportCount[] {
	const text = (id: CatalogMessageId): string => catalogText(catalog, id);
	const problems = notes.filter((note) => note.status === "problem").length;
	const warnings = notes.filter((note) => note.status === "warning").length;
	return [
		{
			status: problems > 0 ? "problem" : "ok",
			text: pluralize(problems, text(CatalogMessageId.catalogProblem), text(CatalogMessageId.catalogProblems)),
		},
		{
			status: warnings > 0 ? "warning" : "ok",
			text: pluralize(warnings, text(CatalogMessageId.catalogWarning), text(CatalogMessageId.catalogWarnings)),
		},
	];
}

export function catalogStatus(
	paths: JouzuPaths,
	env: NodeJS.ProcessEnv = process.env,
	sourceId?: string,
	catalog: CatalogBundle = defaultCatalog(),
): CatalogStatus | CatalogSyncStatus {
	if (!sourceId) return getCatalogStatuses(paths, env, new Date(), catalog);
	const source = resolveCatalogSources(paths, env, { includeDisabled: true }, catalog).find(
		(candidate) => candidate.id === sourceId,
	);
	if (!source) {
		throw new Error(catalogText(catalog, CatalogMessageId.catalogSourceNotFound, { id: sourceId }));
	}
	return getCatalogSourceStatus(paths, source, new Date(), env, catalog);
}

function sourceStatusWord(status: ConfiguredCatalogStatus, catalog: CatalogBundle): string {
	return status.enabled
		? catalogText(catalog, CATALOG_STATE_WORD_IDS[status.status])
		: catalogText(catalog, CatalogMessageId.catalogStatusDisabled);
}

function sourceMarker(status: ConfiguredCatalogStatus): CommandReportStatus {
	if (!status.enabled) return "idle";
	if (status.lastError) return "problem";
	if (status.status === "active") return "ok";
	if (status.status === "stale") return "warning";
	return "idle";
}

function describeCredential(status: ConfiguredCatalogStatus, catalog: CatalogBundle): string | undefined {
	if (!status.credentialName) return undefined;
	const name = status.credentialName;
	if (status.credentialAvailable && status.credentialEnv) {
		return catalogText(catalog, CatalogMessageId.catalogCredentialEnvironmentSet, { name });
	}
	if (status.credentialAvailable) {
		return catalogText(catalog, CatalogMessageId.catalogCredentialSavedToken, { name });
	}
	return catalogText(catalog, CatalogMessageId.catalogCredentialEnvironmentNotSet, { name });
}

/** The recorded error only says a revision is held; the held-update note already covers it. */
function heldOnly(status: ConfiguredCatalogStatus): boolean {
	return status.lastError?.code === "quarantined" && (status.held?.length ?? 0) > 0;
}

/** Hoist every condition a user may need to act on, keyed by the source it came from. */
function sourceNotes(status: CatalogSyncStatus, catalog: CatalogBundle): CommandReportEntry[] {
	if (!status.configured) return [];
	const key = status.sourceId;
	const notes: CommandReportEntry[] = [];
	const transportWarning = catalogInsecureTransportWarning(status.endpoint, catalog);
	if (transportWarning) notes.push({ status: "warning", key, message: transportWarning });
	if (status.credentialName && !status.credentialAvailable) {
		notes.push({
			status: "warning",
			key,
			message: catalogText(catalog, CatalogMessageId.catalogNoteTokenMissing, { name: status.credentialName }),
		});
	}
	if (status.registrationGaps?.length) {
		const complete = (status.offeringCount ?? status.registrationGaps.length) - status.registrationGaps.length;
		notes.push({
			status: "warning",
			key,
			message: catalogText(catalog, CatalogMessageId.catalogNoteRegistrationGaps, {
				complete,
				total: status.offeringCount ?? "?",
				gaps: describeCatalogRegistrationGaps(status.registrationGaps, catalog),
				effect: describeCatalogRegistrationEffect(catalog),
			}),
		});
	}
	if (status.thinkingLevelGaps?.length) {
		notes.push({
			status: "warning",
			key,
			message: catalogText(catalog, CatalogMessageId.catalogNoteThinkingLevels, {
				count: status.thinkingLevelGaps.length,
				total: status.offeringCount ?? "?",
			}),
		});
	}
	if (status.conflict) notes.push({ status: "warning", key, message: status.conflict });
	for (const held of status.held ?? []) {
		notes.push({
			status: "warning",
			key,
			message: catalogText(catalog, CatalogMessageId.catalogNoteQuarantined, {
				summary: heldCatalogSummary(catalog, held),
				accept: protectedCommand(heldCatalogCommand("accept", status.sourceId, held)),
				reject: protectedCommand(heldCatalogCommand("reject", status.sourceId, held)),
			}),
		});
	}
	if (status.lastError && !heldOnly(status)) {
		notes.push({ status: "problem", key, message: `${status.lastError.code}: ${status.lastError.message}` });
	}
	return notes;
}

function sourceFields(status: ConfiguredCatalogStatus, catalog: CatalogBundle): CommandReportField[] {
	const label = (fallback: string): string => {
		const id = CATALOG_FIELD_LABEL_IDS[fallback];
		return id === undefined ? fallback : catalogText(catalog, id);
	};
	const fields: CommandReportField[] = [{ label: label("Endpoint"), value: status.endpoint }];
	if (status.catalogId) fields.push({ label: label("Catalog"), value: status.catalogId });
	if (status.offeringCount !== undefined) fields.push({ label: label("Models"), value: String(status.offeringCount) });
	if (status.registrationGaps?.length) {
		const complete = (status.offeringCount ?? status.registrationGaps.length) - status.registrationGaps.length;
		fields.push({
			label: label("Registration"),
			value: catalogText(catalog, CatalogMessageId.catalogFieldRegistrationValue, {
				complete,
				total: status.offeringCount ?? "?",
			}),
			details: status.registrationGaps.map((gap) =>
				catalogText(catalog, CatalogMessageId.catalogRegistrationGapDetail, {
					model: `${gap.providerId}/${gap.modelId}`,
					gap: describeCatalogRegistrationGap(gap, catalog),
				}),
			),
		});
	}
	if (status.thinkingLevelGaps?.length) {
		fields.push({
			label: label("Thinking levels"),
			value: catalogText(catalog, CatalogMessageId.catalogFieldThinkingLevelsValue, {
				count: status.thinkingLevelGaps.length,
				total: status.offeringCount ?? "?",
			}),
			details: status.thinkingLevelGaps.map((gap) => `${gap.providerId}/${gap.modelId}`),
		});
	}
	if (status.revision) fields.push({ label: label("Revision"), value: status.revision });
	if (status.sequence) fields.push({ label: label("Sequence"), value: status.sequence });
	if (status.validatedAt) fields.push({ label: label("Validated"), value: status.validatedAt });
	const credential = describeCredential(status, catalog);
	if (credential) fields.push({ label: label("Credential"), value: credential });
	if (status.held?.length)
		fields.push({
			label: label("Held updates"),
			value: String(status.held.length),
			details: status.held.map((held) => held.revision),
		});
	if (status.lastError && !heldOnly(status)) {
		fields.push({ label: label("Last error"), value: `${status.lastError.code}: ${status.lastError.message}` });
	}
	return fields;
}

function renderSource(out: CommandReport, status: ConfiguredCatalogStatus, catalog: CatalogBundle): void {
	const word = sourceStatusWord(status, catalog);
	out.section(status.label, sourceFields(status, catalog), {
		status: sourceMarker(status),
		detail: status.label === status.sourceId ? word : `[${status.sourceId}] · ${word}`,
	});
}

export function formatCatalogStatus(
	status: CatalogStatus | CatalogSyncStatus,
	options: CatalogRenderOptions = {},
): string {
	const catalog = options.catalog ?? defaultCatalog();
	const text = (id: CatalogMessageId, args?: Readonly<Record<string, string | number>>): string =>
		catalogText(catalog, id, args);
	const out = new CommandReport(options);
	const single = !("sources" in status);
	if (single && !status.configured) {
		return out
			.title(text(CatalogMessageId.catalogTitle), text(CATALOG_STATE_WORD_IDS[status.status]))
			.paragraph(status.message)
			.toString();
	}
	const sources = single ? [status] : status.sources;
	if (single) out.title(text(CatalogMessageId.catalogTitle));
	else {
		out.title(
			text(CatalogMessageId.catalogTitlePlural),
			text(CATALOG_STATE_WORD_IDS[status.status]),
			text(CatalogMessageId.catalogSourcesActive, { active: status.active, configured: status.configured }),
		);
		if (status.status === "unconfigured") return out.paragraph(text(CatalogMessageId.catalogUnconfigured)).toString();
	}
	const notes = sources.flatMap((source) => sourceNotes(source, catalog));
	out.entries(text(CatalogMessageId.catalogNotes), notes);
	if (notes.length > 0) out.rule();
	for (const source of sources) {
		if (source.configured) renderSource(out, source, catalog);
	}
	out.blank().rule();
	out.tally(noteCounts(notes, catalog));
	out.paragraph(text(CatalogMessageId.catalogHint));
	return out.toString();
}

function withValidationMessageRef(
	result: CatalogConformanceResult,
	messageRef: CatalogMessageRef,
): CatalogConformanceResult {
	if (result.error) {
		Object.defineProperty(result.error, "messageRef", { value: messageRef, enumerable: false });
	}
	return result;
}

/** The human text of a validation error, resolved from the catalog when it has an ID. */
export function catalogValidationMessage(result: CatalogConformanceResult, catalog: CatalogBundle): string {
	const ref = result.error ? (result.error as { messageRef?: CatalogMessageRef }).messageRef : undefined;
	return ref === undefined ? (result.error?.message ?? "") : catalogMessageText(catalog, ref);
}

export function validateCatalogFile(path: string, remote: boolean): CatalogConformanceResult {
	if (!existsSync(path)) {
		const messageRef = catalogMessage(CatalogMessageId.catalogFileNotFound, { path });
		return withValidationMessageRef(
			{
				valid: false,
				error: { code: "invalid_json", path: "$", message: catalogMessageText(defaultCatalog(), messageRef) },
			},
			messageRef,
		);
	}
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		const messageRef = catalogMessage(CatalogMessageId.catalogFileNotRegular, { path });
		return withValidationMessageRef(
			{
				valid: false,
				error: { code: "invalid_json", path: "$", message: catalogMessageText(defaultCatalog(), messageRef) },
			},
			messageRef,
		);
	}
	return checkCatalogConformance(readFileSync(path, "utf8"), { remote });
}
