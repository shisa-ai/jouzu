// Exact-source changes for the pinned Pi package. Hashes are checked by apply-pi-path-utils.mjs.
function replace(text, before, after, count = 1) {
	const parts = text.split(before);
	if (parts.length !== count + 1) throw new Error(`Pi path-utils contract mismatch: ${before.slice(0, 100)}`);
	return parts.join(after);
}

export function transform(path, source) {
	if (path !== "dist/core/tools/path-utils.js") throw new Error(`Unknown patch path ${path}`);
	let text = source;
	// Mutating tools must resolve the exact path, never a Unicode-normalized sibling.
	text = replace(
		text,
		`export function resolveToCwd(filePath, cwd) {
    return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}`,
		`export function resolveToCwd(filePath, cwd) {
    return resolvePath(filePath, cwd, { stripAtPrefix: true });
}`,
	);
	// Reads keep a Unicode-space fallback, but only for an existing normalized file.
	text = replace(
		text,
		`    const resolved = resolveToCwd(filePath, cwd);
    if (fileExists(resolved)) {
        return resolved;
    }
    // Try macOS AM/PM variant (narrow no-break space before AM/PM)`,
		`    const resolved = resolveToCwd(filePath, cwd);
    if (fileExists(resolved)) {
        return resolved;
    }
    // Try the Unicode-space-normalized variant (spaces pasted from rich text).
    const unicodeSpaceVariant = resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
    if (unicodeSpaceVariant !== resolved && fileExists(unicodeSpaceVariant)) {
        return unicodeSpaceVariant;
    }
    // Try macOS AM/PM variant (narrow no-break space before AM/PM)`,
	);
	text = replace(
		text,
		`    const resolved = resolveToCwd(filePath, cwd);
    if (await pathExists(resolved)) {
        return resolved;
    }
    // Try macOS AM/PM variant (narrow no-break space before AM/PM)`,
		`    const resolved = resolveToCwd(filePath, cwd);
    if (await pathExists(resolved)) {
        return resolved;
    }
    // Try the Unicode-space-normalized variant (spaces pasted from rich text).
    const unicodeSpaceVariant = resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
    if (unicodeSpaceVariant !== resolved && (await pathExists(unicodeSpaceVariant))) {
        return unicodeSpaceVariant;
    }
    // Try macOS AM/PM variant (narrow no-break space before AM/PM)`,
	);
	return text.replace(/^\/\/# sourceMappingURL=.*\n?/m, "");
}

export const paths = ["dist/core/tools/path-utils.js"];
