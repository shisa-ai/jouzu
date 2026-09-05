import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JouzuPaths } from "./paths.js";
import { writeFilePrivateAtomic, writeFilePrivateExclusive } from "./private-fs.js";

const QUIET_STARTUP_ENTRY = '"quietStartup": true';

export function ensureQuietStartupDefault(paths: JouzuPaths): boolean {
	const path = join(paths.agentDir, "settings.json");
	if (!existsSync(path)) {
		writeFilePrivateExclusive(path, `{\n  ${QUIET_STARTUP_ENTRY}\n}\n`, paths.agentDir);
		return true;
	}

	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
	const contents = readFileSync(path, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || "quietStartup" in parsed) return false;

	const closingBrace = contents.search(/\}\s*$/u);
	if (closingBrace < 0) return false;
	const record = parsed as Record<string, unknown>;
	const separator = Object.keys(record).length === 0 ? "" : ",";
	const updated = `${contents.slice(0, closingBrace)}${separator}\n  ${QUIET_STARTUP_ENTRY}\n${contents.slice(closingBrace)}`;
	writeFilePrivateAtomic(path, updated, paths.agentDir);
	return true;
}

const CHANGELOG_VERSION_KEY = '"lastChangelogVersion"';

/**
 * Pin Pi's seen-changelog marker to the bundled Pi version so upstream Pi
 * release notes never appear at Jouzu startup. `/changelog` still shows the
 * full Pi changelog on demand.
 */
export function suppressPiReleaseNotes(paths: JouzuPaths, piVersion: string): boolean {
	if (!piVersion) return false;
	const versionJson = JSON.stringify(piVersion);
	const path = join(paths.agentDir, "settings.json");
	if (!existsSync(path)) {
		writeFilePrivateExclusive(path, `{\n  ${CHANGELOG_VERSION_KEY}: ${versionJson}\n}\n`, paths.agentDir);
		return true;
	}

	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
	const contents = readFileSync(path, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		return false;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	const record = parsed as Record<string, unknown>;
	if (!("lastChangelogVersion" in record)) {
		const closingBrace = contents.search(/\}\s*$/u);
		if (closingBrace < 0) return false;
		const separator = Object.keys(record).length === 0 ? "" : ",";
		const updated = `${contents.slice(0, closingBrace)}${separator}\n  ${CHANGELOG_VERSION_KEY}: ${versionJson}\n${contents.slice(closingBrace)}`;
		writeFilePrivateAtomic(path, updated, paths.agentDir);
		return true;
	}
	if (record.lastChangelogVersion === piVersion) return false;

	// Re-serialize the parsed top-level object instead of replacing text: the
	// same property name may also appear in nested extension settings.
	record.lastChangelogVersion = piVersion;
	writeFilePrivateAtomic(path, `${JSON.stringify(record, null, 2)}\n`, paths.agentDir);
	return true;
}
