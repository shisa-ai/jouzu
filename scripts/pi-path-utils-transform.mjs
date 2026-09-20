// Exact-source changes for the pinned Pi package. Hashes are checked by apply-pi-path-utils.mjs.
function replace(text, before, after, count = 1) {
	const parts = text.split(before);
	if (parts.length !== count + 1) throw new Error(`Pi path-utils contract mismatch: ${before.slice(0, 100)}`);
	return parts.join(after);
}

export function transform(path, source) {
	if (path !== "dist/core/tools/path-utils.js") throw new Error(`Unknown patch path ${path}`);
	let text = source;
	text = replace(
		text,
		`/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath, cwd) {
    return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}`,
		`/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 * The exact path wins whenever it exists. Unicode-space normalization stays a
 * fallback for a path that exists under the normalized spelling.
 */
export function resolveToCwd(filePath, cwd) {
    const exact = resolvePath(filePath, cwd, { stripAtPrefix: true });
    const normalized = resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
    if (exact === normalized || fileExists(exact)) {
        return exact;
    }
    return fileExists(normalized) ? normalized : exact;
}`,
	);
	return text.replace(/^\/\/# sourceMappingURL=.*\n?/m, "");
}

export const paths = ["dist/core/tools/path-utils.js"];
