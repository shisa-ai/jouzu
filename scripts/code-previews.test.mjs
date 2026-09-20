import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { applyCodePreviews } from "./apply-code-previews.mjs";
import { transform } from "./code-previews-transform.mjs";

const IDEOGRAPHIC_SPACE = "\u3000";
const packageRoots = [resolve("node_modules/pi-code-previews"), resolve("packages/cli/node_modules/pi-code-previews")];

test("code previews deviation locks exact bytes and both installed host trees are idempotent", async () => {
	const pin = JSON.parse(await readFile(new URL("../upstream/pi.lock.json", import.meta.url)));
	const bytes = await readFile(new URL("../upstream/code-previews/patch.lock.json", import.meta.url));
	assert.deepEqual(
		pin.deviations.filter((item) => item.path === "upstream/code-previews/patch.lock.json"),
		[{ path: "upstream/code-previews/patch.lock.json", sha256: createHash("sha256").update(bytes).digest("hex") }],
	);
	for (const packageRoot of packageRoots) {
		assert.equal(await applyCodePreviews(packageRoot, true), 0);
		assert.equal(await applyCodePreviews(packageRoot), 0);
	}
});

test("code previews resolution keeps exact paths and falls back only to an existing normalized path", async (t) => {
	const lock = JSON.parse(await readFile(new URL("../upstream/code-previews/patch.lock.json", import.meta.url)));
	const before = `import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export function resolvePreviewPath(path: string, cwd: string): string {
  let expanded = path.startsWith("@") ? path.slice(1) : path;
  expanded = expanded.replace(/[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]/g, " ");
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/")) expanded = \`\${homedir()}\${expanded.slice(1)}\`;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
`;
	const patched = transform("src/paths/resolve.ts", before);
	assert.equal(
		createHash("sha256").update(patched).digest("hex"),
		lock.files["src/paths/resolve.ts"].after,
		"the transform output must match the pinned after hash",
	);
	const temp = await mkdtemp(join(tmpdir(), "jouzu-code-previews-"));
	t.after(() => rm(temp, { recursive: true, force: true }));
	const modulePath = join(temp, "resolve.mjs");
	await writeFile(modulePath, patched.replace("(path: string, cwd: string): string", "(path, cwd)"));
	const { resolvePreviewPath } = await import(pathToFileURL(modulePath).href);
	const project = join(temp, `日本語${IDEOGRAPHIC_SPACE}project`);
	const asciiProject = join(temp, "日本語 project");
	await mkdir(project);
	await mkdir(asciiProject);
	const exact = join(project, "exact.txt");
	await writeFile(exact, "exact");
	await writeFile(join(asciiProject, "exact.txt"), "normalized");
	await writeFile(join(asciiProject, "fallback.txt"), "normalized");
	assert.equal(resolvePreviewPath(exact, temp), exact, "an existing exact file must win over a normalized sibling");
	assert.equal(
		resolvePreviewPath(join(project, "relative.txt"), project),
		join(project, "relative.txt"),
		"a relative path must resolve under the exact cwd",
	);
	assert.equal(
		resolvePreviewPath(join(project, "fallback.txt"), temp),
		join(asciiProject, "fallback.txt"),
		"a missing exact file must fall back to an existing normalized file",
	);
	assert.equal(
		resolvePreviewPath(join(project, "new.txt"), temp),
		join(project, "new.txt"),
		"a new file must keep the exact path when no normalized file exists",
	);
});

test("code previews patch preserves unrecognized installed source", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-code-previews-patch-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, "src", "paths"), { recursive: true });
	await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-code-previews", version: "0.1.36" }));
	const path = join(root, "src", "paths", "resolve.ts");
	await writeFile(path, "unrecognized");
	await assert.rejects(applyCodePreviews(root), /hash mismatch/);
	assert.equal(await readFile(path, "utf8"), "unrecognized");
});
