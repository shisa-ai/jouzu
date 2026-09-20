import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { applyPathUtils } from "./apply-pi-path-utils.mjs";

const IDEOGRAPHIC_SPACE = "\u3000";
const NO_BREAK_SPACE = "\u00A0";
const packageRoots = [
	resolve("node_modules/@earendil-works/pi-coding-agent"),
	resolve("packages/cli/node_modules/@earendil-works/pi-coding-agent"),
];

test("path deviation locks exact bytes and both installed host trees are idempotent", async () => {
	const pin = JSON.parse(await readFile(new URL("../upstream/pi.lock.json", import.meta.url)));
	const bytes = await readFile(new URL("../upstream/pi-path-utils/patch.lock.json", import.meta.url));
	assert.deepEqual(
		pin.deviations.filter((item) => item.path === "upstream/pi-path-utils/patch.lock.json"),
		[{ path: "upstream/pi-path-utils/patch.lock.json", sha256: createHash("sha256").update(bytes).digest("hex") }],
	);
	for (const packageRoot of packageRoots) {
		assert.equal(await applyPathUtils(packageRoot, true), 0);
		assert.equal(await applyPathUtils(packageRoot), 0);
	}
});

test("file tools preserve an exact cwd and filename containing U+3000", async (t) => {
	assert.equal(await applyPathUtils(packageRoots[0]), 0);
	const { createEditTool, createLsTool, createReadTool, createWriteTool } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const temp = await mkdtemp(join(tmpdir(), "jouzu-path-utils-"));
	t.after(() => rm(temp, { recursive: true, force: true }));
	const project = join(temp, `日本語${IDEOGRAPHIC_SPACE}project`);
	await mkdir(project);
	const exactPath = join(project, "確認-結果.txt");
	const asciiSiblingDir = join(temp, "日本語 project");
	const asciiSibling = join(asciiSiblingDir, "確認-結果.txt");
	const expected = "日本語のツール確認\n完了 🦁";
	const ctx = { cwd: project };
	const call = (tool, args) => tool.execute("call", args, undefined, undefined, ctx);

	const write = createWriteTool(project);
	await call(write, { path: exactPath, content: expected });
	assert.equal(await readFile(exactPath, "utf8"), expected, "absolute write did not use the exact path");
	assert.equal(existsSync(asciiSibling), false, "absolute write created an ASCII-space sibling");

	const read = createReadTool(project);
	assert.equal(
		(await call(read, { path: exactPath })).content[0].text,
		expected,
		"absolute read missed the exact file",
	);
	assert.equal(
		(await call(read, { path: "確認-結果.txt" })).content[0].text,
		expected,
		"relative read missed the exact file",
	);

	const edit = createEditTool(project);
	await call(edit, { path: exactPath, edits: [{ oldText: "完了 🦁", newText: "完了 🦁!" }] });
	assert.equal(await readFile(exactPath, "utf8"), "日本語のツール確認\n完了 🦁!", "edit did not use the exact path");
	await call(edit, { path: "確認-結果.txt", edits: [{ oldText: "🦁!", newText: "🦁!!" }] });
	assert.equal(
		await readFile(exactPath, "utf8"),
		"日本語のツール確認\n完了 🦁!!",
		"relative edit missed the exact file",
	);
	assert.equal(existsSync(asciiSibling), false, "edit created an ASCII-space sibling");

	await call(write, { path: "相対-結果.txt", content: "relative" });
	assert.equal(await readFile(join(project, "相対-結果.txt"), "utf8"), "relative");
	assert.equal(existsSync(asciiSiblingDir), false, "relative write created an ASCII-space sibling");

	const nested = join(project, `新規${IDEOGRAPHIC_SPACE}dir`, "ファイル.txt");
	await call(write, { path: nested, content: "nested" });
	assert.equal(await readFile(nested, "utf8"), "nested");
	assert.equal(existsSync(join(project, "新規 dir")), false, "nested write created an ASCII-space sibling");

	const listing = (await call(createLsTool(project), { path: "." })).content[0].text;
	assert.match(listing, /確認-結果\.txt/);
	assert.match(listing, /相対-結果\.txt/);
});

test("unicode-space normalization stays a fallback for an existing normalized path", async (t) => {
	assert.equal(await applyPathUtils(packageRoots[0]), 0);
	const { createReadTool, createWriteTool } = await import("@earendil-works/pi-coding-agent");
	const temp = await mkdtemp(join(tmpdir(), "jouzu-path-utils-fallback-"));
	t.after(() => rm(temp, { recursive: true, force: true }));
	await writeFile(join(temp, "file name.txt"), "legacy");
	const read = createReadTool(temp);
	const result = await read.execute("call", { path: `file${NO_BREAK_SPACE}name.txt` }, undefined, undefined, {
		cwd: temp,
	});
	assert.equal(result.content[0].text, "legacy");

	const write = createWriteTool(temp);
	await write.execute("call", { path: `paste${NO_BREAK_SPACE}name.txt`, content: "exact" }, undefined, undefined, {
		cwd: temp,
	});
	assert.equal(await readFile(join(temp, `paste${NO_BREAK_SPACE}name.txt`), "utf8"), "exact");
	assert.equal(existsSync(join(temp, "paste name.txt")), false, "write normalized a new filename");
});

test("unrecognized bytes are refused without overwriting them", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-path-utils-patch-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const packageRoot = join(directory, "node_modules/@earendil-works/pi-coding-agent");
	await mkdir(join(packageRoot, "dist/core/tools"), { recursive: true });
	await writeFile(
		join(packageRoot, "package.json"),
		JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.86.1" }),
	);
	await writeFile(join(packageRoot, "dist/core/tools/path-utils.js"), "unrecognized");
	await assert.rejects(applyPathUtils(packageRoot), /hash mismatch/);
	assert.equal(await readFile(join(packageRoot, "dist/core/tools/path-utils.js"), "utf8"), "unrecognized");
});
