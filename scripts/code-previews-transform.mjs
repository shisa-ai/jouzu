// Exact-source changes for the bundled pi-code-previews extension. Hashes are checked by apply-code-previews.mjs.
function replace(text, before, after) {
	const parts = text.split(before);
	if (parts.length !== 2) throw new Error(`Code previews path contract mismatch: ${before.slice(0, 100)}`);
	return parts.join(after);
}

const PRISTINE_BLOCK = `  let expanded = path.startsWith("@") ? path.slice(1) : path;
  expanded = expanded.replace(/[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]/g, " ");
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/")) expanded = \`\${homedir()}\${expanded.slice(1)}\`;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);`;

const EXACT_BLOCK = `  let expanded = path.startsWith("@") ? path.slice(1) : path;
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/")) expanded = \`\${homedir()}\${expanded.slice(1)}\`;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);`;

// The earlier carried revision normalized the path and selected an existing alias. Migration
// removes that tail and the existsSync import without touching any other bytes.
const FALLBACK_TAIL = `  const exact = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  const normalized = exact.replace(/[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]/g, " ");
  if (normalized === exact || existsSync(exact)) return exact;
  return existsSync(normalized) ? normalized : exact;`;

const EXACT_TAIL = `  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);`;

export function transform(path, source) {
	if (path !== "src/paths/resolve.ts") throw new Error(`Unknown patch path ${path}`);
	// The write tool resolves mutation paths exactly: no Unicode-space aliasing and no
	// filesystem-based alias selection. Only @ stripping and ~ expansion remain.
	if (source.includes(FALLBACK_TAIL)) {
		const migrated = replace(source, `import { existsSync } from "node:fs";\n`, "");
		return replace(migrated, FALLBACK_TAIL, EXACT_TAIL);
	}
	return replace(source, PRISTINE_BLOCK, EXACT_BLOCK);
}
