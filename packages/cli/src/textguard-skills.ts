import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { MAX_SCAN_BYTES, type UnavailableReason } from "./textguard.js";
import { type ContentReview, reviewLabel, type TextGuardAdmission } from "./textguard-admission.js";

const MAX_SKILLS = 128;
const MAX_METADATA_BYTES = 16 * 1024;
export interface SkillScanNotice {
	source: string;
	reason: UnavailableReason;
}
type FileSnapshot = { text: string } | { reason: UnavailableReason };

/** Read one bounded regular-file snapshot. Never substitute decoded replacement characters. */
export async function readSkillSnapshot(path: string, signal?: AbortSignal): Promise<FileSnapshot> {
	if (signal?.aborted) return { reason: "timeout" };
	try {
		const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			const stat = await file.stat();
			if (!stat.isFile()) return { reason: "file" };
			if (stat.size > MAX_SCAN_BYTES) return { reason: "input-limit" };
			const buffer = Buffer.alloc(MAX_SCAN_BYTES + 1);
			let length = 0;
			while (length < buffer.length) {
				if (signal?.aborted) return { reason: "timeout" };
				const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
				if (!bytesRead) break;
				length += bytesRead;
			}
			if (signal?.aborted) return { reason: "timeout" };
			if (length > MAX_SCAN_BYTES) return { reason: "input-limit" };
			return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)) };
		} finally {
			await file.close();
		}
	} catch {
		return { reason: "file" };
	}
}

function snapshotMetadata(skill: Skill, cwd: string): Skill | undefined {
	// Copy only fields consumed by Pi; do not publish extra extension-supplied properties.
	const values = [
		skill.name,
		skill.description,
		skill.filePath,
		skill.baseDir,
		skill.sourceInfo?.path,
		skill.sourceInfo?.source,
		skill.sourceInfo?.baseDir ?? "",
	];
	if (
		values.some(
			(value) =>
				typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value) || Buffer.byteLength(value) > MAX_METADATA_BYTES,
		)
	)
		return;
	if (values.reduce((total, value) => total + Buffer.byteLength(value), 0) > MAX_METADATA_BYTES) return;
	if (
		typeof skill.disableModelInvocation !== "boolean" ||
		!["user", "project", "temporary"].includes(skill.sourceInfo.scope) ||
		!["package", "top-level"].includes(skill.sourceInfo.origin)
	)
		return;
	return {
		name: skill.name,
		description: skill.description,
		filePath: resolve(cwd, skill.filePath),
		baseDir: resolve(cwd, skill.baseDir),
		disableModelInvocation: skill.disableModelInvocation,
		sourceInfo: {
			path: skill.sourceInfo.path,
			source: skill.sourceInfo.source,
			scope: skill.sourceInfo.scope,
			origin: skill.sourceInfo.origin,
			...(skill.sourceInfo.baseDir === undefined ? {} : { baseDir: skill.sourceInfo.baseDir }),
		},
	};
}

/** Session-scoped inventory and expansion checks sharing the host's approval authority. */
export class TextGuardSkills {
	private generation = 0;
	private notices: SkillScanNotice[] = [];
	private reports: ContentReview[] = [];
	private paths = new Set<string>();
	private overflow = false;
	constructor(
		private admission: TextGuardAdmission,
		private cwd: string,
	) {}

	scanNotices(): SkillScanNotice[] {
		return structuredClone(this.notices);
	}
	scanReports(): ContentReview[] {
		return structuredClone(this.reports);
	}
	isSkillPath(path: string): boolean {
		return this.overflow || /(?:^|[/\\])SKILL\.md$/iu.test(path) || this.paths.has(resolve(this.cwd, path));
	}
	clear(): void {
		this.generation++;
		this.admission.clearApprovals();
		this.notices = [];
		this.reports = [];
		this.paths.clear();
		this.overflow = false;
	}

	async filterSkills(candidates: Skill[]): Promise<Skill[]> {
		const generation = ++this.generation;
		const notices: SkillScanNotice[] = [];
		const reports: ContentReview[] = [];
		const paths = new Set<string>();
		const admitted: Skill[] = [];
		this.overflow = candidates.length > MAX_SKILLS;
		this.paths = paths;
		this.notices = [];
		this.reports = [];
		const signal = AbortSignal.timeout(5000);
		// Register explicit .md paths even when their body is withheld. A direct read must still be checked.
		const snapshots = candidates.slice(0, MAX_SKILLS).map((candidate) => {
			try {
				if (typeof candidate.filePath === "string" && candidate.filePath.length <= MAX_METADATA_BYTES)
					paths.add(resolve(this.cwd, candidate.filePath));
				return snapshotMetadata(candidate, this.cwd);
			} catch {
				return undefined;
			}
		});
		for (const skill of snapshots) {
			if (generation !== this.generation) return [];
			if (!skill) {
				notices.push({ source: "skill metadata", reason: "protocol" });
				continue;
			}
			const text = await this.check(skill, generation, signal, notices, reports);
			if (text !== undefined) admitted.push(skill);
		}
		if (this.overflow) notices.push({ source: "skill inventory", reason: "budget" });
		if (generation !== this.generation) return [];
		this.notices = notices;
		this.reports = reports;
		return admitted;
	}

	async readSkill(candidate: Skill, signal?: AbortSignal): Promise<string | undefined> {
		const generation = this.generation;
		let skill: Skill | undefined;
		try {
			skill = snapshotMetadata(candidate, this.cwd);
		} catch {
			return undefined;
		}
		if (!skill) return;
		const notices: SkillScanNotice[] = [];
		const reports: ContentReview[] = [];
		const text = await this.check(skill, generation, signal, notices, reports);
		if (generation !== this.generation) return;
		this.notices = [...this.notices, ...notices].slice(-MAX_SKILLS);
		this.reports = [...this.reports, ...reports].slice(-MAX_SKILLS);
		return text;
	}

	private async check(
		skill: Skill,
		generation: number,
		signal: AbortSignal | undefined,
		notices: SkillScanNotice[],
		reports: ContentReview[],
	): Promise<string | undefined> {
		const snapshot = await readSkillSnapshot(skill.filePath, signal);
		if (generation !== this.generation) return;
		if ("reason" in snapshot) {
			notices.push({ source: reviewLabel(skill.filePath), reason: snapshot.reason });
			return;
		}
		// Framing binds all published metadata and the entire original body to one approval identity.
		const input = `${JSON.stringify(skill)}\n${snapshot.text}`;
		const decision = await this.admission.check(`skill:${skill.filePath}`, input, signal);
		// A withheld skill is already in the approval queue; only an admitted one needs a report.
		if (decision.allowed) {
			if (decision.review.evidence.status !== "clear") reports.push(decision.review);
		} else if (!this.admission.reviews().some((item) => item.id === decision.review.id))
			notices.push({ source: reviewLabel(skill.filePath), reason: decision.review.evidence.reason ?? "protocol" });
		if (generation === this.generation && decision.allowed) return snapshot.text;
	}
}
