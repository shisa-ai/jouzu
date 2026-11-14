import { catalogText, defaultCatalog } from "../cli-messages.js";
import type { CatalogBundle } from "../locale-catalog.js";
import { flowDiagnosticText } from "./diagnostic-text.js";

/**
 * Why the session's automated work is held as a whole.
 *
 * One component observes the cause and another explains it, so the reason strings and the tests for
 * them live together. A literal repeated on both sides would let a rename change the advice without
 * changing the cause.
 */
export const INTERRUPTED_PAUSE = "a turn was interrupted";
export const REOPENED_PAUSE = "the session was reopened";
export const COMMAND_PAUSE = "held from /flow";

const ADMISSION_PREFIX = "flow admission failed (";
const PROVIDER_PREFIX = "a provider request failed";

/** A flow invariant refused an input; the code names which one. */
export const admissionPause = (code: string): string => `${ADMISSION_PREFIX}${code})`;
export const isAdmissionPause = (reason: string): boolean => reason.startsWith(ADMISSION_PREFIX);

/**
 * A provider request ended the turn after host recovery stopped. Hold automated work until the
 * user chooses to retry, and include the provider's bounded, redacted message in the pause reason.
 */
export const providerPause = (detail: string): string =>
	detail ? `${PROVIDER_PREFIX} (${flowDiagnosticText(detail)})` : PROVIDER_PREFIX;
export const isProviderPause = (reason: string): boolean => reason.startsWith(PROVIDER_PREFIX);

const PAUSE_TEXT_ID = "jouzu.cli.flow.pause";

/**
 * The pause reason in the reader's language. Stored reasons stay English because observers compare
 * them; this maps each known shape to catalog text and keeps any embedded code or provider detail.
 * An unrecognized reason is shown as bounded diagnostic text.
 */
export function flowPauseText(reason: string, catalog: CatalogBundle = defaultCatalog(), limit?: number): string {
	const text = (key: string, args?: Record<string, string>) => catalogText(catalog, `${PAUSE_TEXT_ID}.${key}`, args);
	if (reason === INTERRUPTED_PAUSE) return text("interrupted");
	if (reason === REOPENED_PAUSE) return text("reopened");
	if (reason === COMMAND_PAUSE) return text("command", { command: "/flow" });
	if (isAdmissionPause(reason) && reason.endsWith(")"))
		return text("admission", { code: flowDiagnosticText(reason.slice(ADMISSION_PREFIX.length, -1), 64) });
	if (reason === PROVIDER_PREFIX) return text("provider");
	if (reason.startsWith(`${PROVIDER_PREFIX} (`) && reason.endsWith(")"))
		return text("providerDetail", {
			detail: flowDiagnosticText(reason.slice(PROVIDER_PREFIX.length + 2, -1), limit),
		});
	return flowDiagnosticText(reason, limit);
}
