import { createHash } from "node:crypto";

/**
 * Digest used as one path component.
 *
 * 128 bits is ample for identity here, and it keeps paths short enough for
 * SQLite on Windows. `node:fs` reaches long paths through `\\?\`, but SQLite's
 * own file APIs fail with SQLITE_CANTOPEN once a path reaches roughly 250
 * characters. A 256-bit digest pushed child flow storage under
 * `subagents/<key>/<run>/flow/session-registry-v1/<key>/owner.sqlite` past
 * that limit, so no child agent could start.
 */
export function pathDigest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}
