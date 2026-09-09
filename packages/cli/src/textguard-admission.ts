import { createHash } from "node:crypto";
import { MAX_SCAN_BYTES, type ScanEvidence, type TextScanner, unavailable } from "./textguard.js";
import type { TextGuardApprovalStore } from "./textguard-approvals.js";
import { type NativeEvidence, parseNativeEvidence } from "./textguard-native.js";

export const ADMISSION_POLICY = "error-or-incomplete-v1";
const MAX_DECISIONS = 128;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
interface IdentifiedScanner extends TextScanner {
	initialize(): Promise<string | undefined>;
}
export interface ContentReview {
	id: string;
	source: string;
	/** Display-ready source label: readable CJK, escaped controls. */
	displaySource: string;
	contentDigest: string;
	scannerIdentity: string;
	policy: string;
	evidence: ScanEvidence;
}
export interface ContentDecision {
	allowed: boolean;
	approved: boolean;
	review: ContentReview;
}

/** Escape untrusted labels, including invisible Unicode, rather than displaying source snippets. */
export function reviewLabel(text: string): string {
	return JSON.stringify(text.slice(0, 256)).replace(
		/[\u007f-\uffff]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

const DISPLAY_ESCAPE = /[\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;

/**
 * Escape only the characters that are invisible or can reorder terminal display,
 * so a review label stays readable (including CJK) while controls stay visible.
 */
export function displayLabel(text: string): string {
	return escapeInvisible(JSON.stringify(text));
}

/** Apply the invisible-character escapes to text that is already quoted or otherwise safe. */
export function escapeInvisible(text: string): string {
	return text.replace(DISPLAY_ESCAPE, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Scanned text and its raw source label, retained only so the reviewer can view what was flagged. */
export interface ContentSnapshot {
	source: string;
	body?: string;
}

const MAX_SNAPSHOTS = 8;
const MAX_SNAPSHOT_SOURCE = 4096;

/** One instance per session. Only the host's user-confirmation path may call approve(). */
export class TextGuardAdmission {
	private pending = new Map<string, ContentReview>();
	private approvals = new Set<string>();
	private snapshots = new Map<string, ContentSnapshot>();
	private generation = 0;
	constructor(
		private scanner: IdentifiedScanner,
		private persistentApprovals?: TextGuardApprovalStore,
	) {}

	reviews(): ContentReview[] {
		return structuredClone([...this.pending.values()]);
	}
	approve(id: string, persist = false): boolean {
		const review = this.pending.get(id);
		if (!review) return false;
		this.pending.delete(id);
		this.approvals.add(id);
		while (this.approvals.size > MAX_DECISIONS) this.approvals.delete(this.approvals.values().next().value as string);
		if (persist) this.persistentApprovals?.add(review.contentDigest, review.scannerIdentity, review.policy);
		return true;
	}
	clearApprovals(): void {
		this.generation += 1;
		this.approvals.clear();
		this.pending.clear();
		this.snapshots.clear();
	}

	/** Access is bound to the exact reviewed identity; no source is ever re-read for the viewer. */
	snapshotFor(id: string): ContentSnapshot | undefined {
		const snapshot = this.snapshots.get(id);
		return snapshot ? structuredClone(snapshot) : undefined;
	}

	async check(source: string, text: string, signal?: AbortSignal): Promise<ContentDecision> {
		const generation = this.generation;
		let scannerIdentity = "unavailable";
		let evidence: ScanEvidence = unavailable("scanner");
		const contentDigest = digest(text);
		const validUnicode = !/[\uD800-\uDFFF]/u.test(text);
		try {
			await this.persistentApprovals?.ready();
		} catch {
			/* A store failure never grants or denies coverage by itself. */
		}
		try {
			const identity = await this.scanner.initialize();
			scannerIdentity = identity && /^[a-f0-9]{64}$/.test(identity) ? identity : "unavailable";
			if (signal?.aborted) evidence = unavailable("timeout");
			else if (scannerIdentity === "unavailable") evidence = unavailable("version");
			else if (!validUnicode) evidence = unavailable("protocol");
			else if (Buffer.byteLength(text) > MAX_SCAN_BYTES) evidence = unavailable("input-limit");
			else {
				const result = (await this.scanner.scan(text, 2000, signal)) as NativeEvidence;
				// Validate complete verdicts even when the injected scanner is not the native supervisor.
				evidence = parseNativeEvidence(
					Buffer.from(
						JSON.stringify({
							version: 1,
							id: "admission",
							input_sha256: contentDigest,
							status: result.status,
							findings: result.findings,
							finding_count: result.status === "unavailable" ? 0 : result.findingCount,
							severity_counts: result.status === "unavailable" ? { info: 0, warn: 0, error: 0 } : result.severityCounts,
							decode_reasons: result.status === "unavailable" ? [] : result.decodeReasons,
							reason: result.reason,
						}),
					),
					"admission",
					contentDigest,
				);
			}
		} catch {
			evidence = unavailable("scanner");
		}
		return this.decide(source, contentDigest, validUnicode, scannerIdentity, evidence, generation, signal, text);
	}

	/** The host must hash the complete payload; truncated or invalid snapshots cannot be approved. */
	async checkUnavailableSnapshot(
		source: string,
		contentDigest: string,
		reason: "input-limit" | "unsupported-content",
		signal?: AbortSignal,
	): Promise<ContentDecision> {
		if (!/^[a-f0-9]{64}$/.test(contentDigest)) throw new Error("Invalid TextGuard content identity");
		const generation = this.generation;
		let scannerIdentity = "unavailable";
		try {
			await this.persistentApprovals?.ready();
			const identity = await this.scanner.initialize();
			if (identity && /^[a-f0-9]{64}$/.test(identity)) scannerIdentity = identity;
		} catch {
			/* Coverage remains unavailable. */
		}
		return this.decide(source, contentDigest, true, scannerIdentity, unavailable(reason), generation, signal);
	}

	private decide(
		source: string,
		contentDigest: string,
		validUnicode: boolean,
		scannerIdentity: string,
		evidence: ScanEvidence,
		generation: number,
		signal?: AbortSignal,
		body?: string,
	): ContentDecision {
		if (signal?.aborted) evidence = unavailable("timeout");
		const active = generation === this.generation && !signal?.aborted;
		if (generation !== this.generation) evidence = unavailable("closed");
		// Invalid Unicode has no exact UTF-8 identity and therefore cannot be approved.
		const id = digest(JSON.stringify([source, contentDigest, scannerIdentity, ADMISSION_POLICY, validUnicode]));
		const review: ContentReview = {
			id,
			source: reviewLabel(source),
			displaySource: displayLabel(source.slice(0, MAX_SNAPSHOT_SOURCE)),
			contentDigest,
			scannerIdentity,
			policy: ADMISSION_POLICY,
			evidence,
		};
		const blocked = evidence.status === "unavailable" || (evidence.severityCounts?.error ?? 0) > 0;
		if (blocked) {
			// Retain the exact scanned text for the review viewer, in bounded session memory only.
			this.snapshots.delete(id);
			this.snapshots.set(id, {
				source: source.slice(0, MAX_SNAPSHOT_SOURCE),
				...(validUnicode && body !== undefined ? { body } : {}),
			});
			while (this.snapshots.size > MAX_SNAPSHOTS) this.snapshots.delete(this.snapshots.keys().next().value as string);
		}
		const approved =
			validUnicode &&
			active &&
			(this.approvals.has(id) ||
				(this.persistentApprovals?.has(contentDigest, scannerIdentity, ADMISSION_POLICY) ?? false));
		if (blocked && !approved && validUnicode && active) {
			this.pending.delete(id);
			this.pending.set(id, review);
			while (this.pending.size > MAX_DECISIONS) this.pending.delete(this.pending.keys().next().value as string);
		} else if (active) {
			this.pending.delete(id);
		}
		return { allowed: active && (!blocked || approved), approved, review: structuredClone(review) };
	}
}
