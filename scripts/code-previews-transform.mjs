// Exact-source changes for the bundled pi-code-previews extension. Hashes are checked by apply-code-previews.mjs.
function replace(text, before, after) {
	const parts = text.split(before);
	if (parts.length !== 2) throw new Error(`Code previews path contract mismatch: ${before.slice(0, 100)}`);
	return parts.join(after);
}

export function transform(path, source) {
	if (path !== "src/paths/resolve.ts") throw new Error(`Unknown patch path ${path}`);
	let text = source;
	text = replace(
		text,
		`import { homedir } from "node:os";`,
		`import { existsSync } from "node:fs";
import { homedir } from "node:os";`,
	);
	// Mutation paths stay exact: the Unicode-space spelling is only a fallback for an
	// existing normalized path, never a rewrite of the environment-provided cwd.
	text = replace(
		text,
		`export function resolvePreviewPath(path: string, cwd: string): string {
  let expanded = path.startsWith("@") ? path.slice(1) : path;
  expanded = expanded.replace(/[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]/g, " ");
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/")) expanded = \`\${homedir()}\${expanded.slice(1)}\`;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}`,
		`export function resolvePreviewPath(path: string, cwd: string): string {
  let expanded = path.startsWith("@") ? path.slice(1) : path;
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/")) expanded = \`\${homedir()}\${expanded.slice(1)}\`;
  const exact = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  const normalized = exact.replace(/[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]/g, " ");
  if (normalized === exact || existsSync(exact)) return exact;
  return existsSync(normalized) ? normalized : exact;
}`,
	);
	return text;
}
