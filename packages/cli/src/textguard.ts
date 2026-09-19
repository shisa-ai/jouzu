export const MAX_SCAN_BYTES = 256 * 1024;
export type UnavailableReason =
	| "input-limit"
	| "unsupported-content"
	| "finding-limit"
	| "decode-limit"
	| "scanner"
	| "output-limit"
	| "timeout"
	| "process"
	| "version"
	| "protocol"
	| "busy"
	| "closed"
	| "file"
	| "budget";
export interface ScanFinding {
	kind: string;
	severity: "info" | "warn" | "error";
	offset: number | null;
}
export interface ScanEvidence {
	status: "clear" | "findings" | "unavailable";
	findings: ScanFinding[];
	reason?: UnavailableReason;
	findingCount?: number;
	severityCounts?: Record<ScanFinding["severity"], number>;
}
export interface TextScanner {
	scan(text: string, timeoutMs?: number, signal?: AbortSignal): Promise<ScanEvidence>;
	close(): Promise<void>;
}
export const unavailable = (reason: UnavailableReason): ScanEvidence => ({
	status: "unavailable",
	findings: [],
	reason,
});

/** Why an incomplete check did not finish, in one clause a user can act on. */
export const UNAVAILABLE_TEXT: Record<UnavailableReason, string> = {
	"input-limit": "the content is larger than TextGuard can scan",
	"unsupported-content": "part of the content is something the scanner cannot check, such as an image",
	"finding-limit": "there were too many findings to report completely",
	"decode-limit": "the content has too many encoded layers to decode completely",
	"output-limit": "the scanner produced too much output",
	scanner: "the scanner could not run",
	timeout: "the scan ran out of time",
	process: "the scanner stopped unexpectedly",
	version: "the installed scanner version is not supported",
	protocol: "the scanner returned an unreadable result",
	busy: "the scanner was busy with other work",
	closed: "the review session ended",
	file: "the content could not be read",
	budget: "the time reserved for scanning ran out",
};

/** One short clause naming what the scan found, for a notification or a model-facing banner. */
export function describeEvidence(evidence: ScanEvidence): string {
	if (evidence.status === "unavailable")
		return `the check did not finish: ${UNAVAILABLE_TEXT[evidence.reason ?? "scanner"]}`;
	const counts = evidence.severityCounts ?? { info: 0, warn: 0, error: 0 };
	const errors = counts.error ?? 0;
	const kinds = [...new Set(evidence.findings.filter((item) => item.severity === "error").map((item) => item.kind))]
		.slice(0, 3)
		.join(", ");
	if (errors > 0) return `${errors} error-level finding${errors === 1 ? "" : "s"}${kinds ? ` (${kinds})` : ""}`;
	const warnings = counts.warn ?? 0;
	return warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "no findings";
}
