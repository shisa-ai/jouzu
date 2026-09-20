import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { applyCodePreviews } from "./apply-code-previews.mjs";
import { transform } from "./code-previews-transform.mjs";

const IDEOGRAPHIC_SPACE = "\u3000";
const packageRoots = [resolve("node_modules/pi-code-previews"), resolve("packages/cli/node_modules/pi-code-previews")];
const PRISTINE_RESOLVE = `import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export function resolvePreviewPath(path: string, cwd: string): string {
  let expanded = path.startsWith("@") ? path.slice(1) : path;
  expanded = expanded.replace(/[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]/g, " ");
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/")) expanded = \`\${homedir()}\${expanded.slice(1)}\`;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
`;

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

test("code previews resolution keeps mutation paths exact and never selects an ASCII alias", async (t) => {
	const lock = JSON.parse(await readFile(new URL("../upstream/code-previews/patch.lock.json", import.meta.url)));
	const patched = transform("src/paths/resolve.ts", PRISTINE_RESOLVE);
	assert.equal(
		createHash("sha256").update(patched).digest("hex"),
		lock.files["src/paths/resolve.ts"].after,
		"the transform output must match the pinned after hash",
	);
	assert.equal(
		patched.includes("existsSync"),
		false,
		"the mutation resolver must not select aliases by filesystem state",
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
	const expected = "日本語のツール確認\n完了 🦁";

	const absoluteExact = join(project, "absolute　name.txt");
	const absoluteSentinel = join(asciiProject, "absolute name.txt");
	await writeFile(absoluteSentinel, "absolute sentinel");
	const absoluteTarget = resolvePreviewPath(absoluteExact, temp);
	assert.equal(absoluteTarget, absoluteExact, "an absent absolute U+3000 path must stay exact");
	await writeFile(absoluteTarget, expected);
	assert.equal(await readFile(absoluteExact, "utf8"), expected, "the exact absolute file must be created");
	assert.equal(
		await readFile(absoluteSentinel, "utf8"),
		"absolute sentinel",
		"the ASCII sibling sentinel must not change",
	);

	const relativeName = "relative　name.txt";
	const relativeSentinel = join(asciiProject, "relative name.txt");
	await writeFile(relativeSentinel, "relative sentinel");
	const relativeTarget = resolvePreviewPath(relativeName, project);
	assert.equal(
		relativeTarget,
		join(project, relativeName),
		"a relative U+3000 mutation path must resolve under the exact cwd",
	);
	await writeFile(relativeTarget, expected);
	assert.equal(
		await readFile(join(project, relativeName), "utf8"),
		expected,
		"the exact relative file must be created",
	);
	assert.equal(
		await readFile(relativeSentinel, "utf8"),
		"relative sentinel",
		"the ASCII sibling sentinel must not change",
	);

	const exactExisting = join(project, "existing.txt");
	await writeFile(exactExisting, "exact existing");
	await writeFile(join(asciiProject, "existing.txt"), "normalized existing");
	assert.equal(resolvePreviewPath(exactExisting, temp), exactExisting, "an existing exact file must still win");
	assert.equal(resolvePreviewPath(`@${relativeName}`, project), join(project, relativeName), "@ stripping must stay");
	assert.equal(resolvePreviewPath("~", temp), homedir(), "~ expansion must stay");
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

test("code previews migration removes the earlier fallback revision without touching other bytes", async () => {
	const lock = JSON.parse(await readFile(new URL("../upstream/code-previews/patch.lock.json", import.meta.url)));
	const fallback = PRISTINE_RESOLVE.replace(
		`import { homedir } from "node:os";`,
		`import { existsSync } from "node:fs";\nimport { homedir } from "node:os";`,
	)
		.replace(`  expanded = expanded.replace(/[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]/g, " ");\n`, "")
		.replace(
			`  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);`,
			`  const exact = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  const normalized = exact.replace(/[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]/g, " ");
  if (normalized === exact || existsSync(exact)) return exact;
  return existsSync(normalized) ? normalized : exact;`,
		);
	assert.equal(
		createHash("sha256").update(fallback).digest("hex"),
		lock.files["src/paths/resolve.ts"].previousAfter,
		"the migration fixture must match the earlier carried revision",
	);
	assert.equal(
		createHash("sha256").update(transform("src/paths/resolve.ts", fallback)).digest("hex"),
		lock.files["src/paths/resolve.ts"].after,
	);
});
