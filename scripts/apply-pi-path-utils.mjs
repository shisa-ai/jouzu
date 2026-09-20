#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, transform } from "./pi-path-utils-transform.mjs";

const root = resolve(import.meta.dirname, "..");
const sha = (text) => createHash("sha256").update(text).digest("hex");

/**
 * Keep file-tool paths exact, so a cwd or filename that contains a Unicode
 * space (for example U+3000) is never rewritten to a different ASCII-space
 * location. The normalized spelling remains a fallback only when that location
 * exists and the exact one does not.
 */
export async function applyPathUtils(packageRoot, checkOnly = false) {
	const manifestPath = "upstream/pi-path-utils/patch.lock.json";
	const manifest = await readFile(join(root, manifestPath), "utf8");
	const lock = JSON.parse(manifest);
	const pin = JSON.parse(await readFile(join(root, "upstream/pi.lock.json"), "utf8"));
	const records = pin.deviations?.filter((record) => record.path === manifestPath) ?? [];
	if (records.length !== 1 || records[0].sha256 !== sha(manifest))
		throw new Error("Pi path-utils manifest does not match the pinned deviation");
	const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	if (
		lock.schemaVersion !== 1 ||
		lock.package !== "@earendil-works/pi-coding-agent" ||
		pkg.name !== lock.package ||
		pkg.version !== lock.version ||
		lock.version !== pin.packages["@earendil-works/pi-coding-agent"]?.version
	)
		throw new Error("Pi path-utils package identity mismatch");
	if (JSON.stringify(Object.keys(lock.files).sort()) !== JSON.stringify([...paths].sort()))
		throw new Error("Pi path-utils path manifest mismatch");
	const writes = [];
	for (const path of paths) {
		const original = await readFile(join(packageRoot, path), "utf8");
		const hashes = lock.files[path];
		if (sha(original) === hashes.after) continue;
		if (checkOnly || sha(original) !== hashes.before) throw new Error(`Pi path-utils hash mismatch: ${path}`);
		const patched = transform(path, original);
		if (sha(patched) !== hashes.after) throw new Error(`Pi path-utils transformed hash mismatch: ${path}`);
		writes.push([join(packageRoot, path), patched]);
	}
	for (const [path, text] of writes) await writeFile(path, text);
	return writes.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const roots = new Set();
	for (const base of [root, join(root, "packages/cli")]) {
		try {
			roots.add(await realpath(join(base, "node_modules/@earendil-works/pi-coding-agent")));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	if (roots.size === 0) throw new Error("Pi package is missing; run npm ci first");
	let count = 0;
	for (const packageRoot of roots) {
		count += await applyPathUtils(packageRoot, process.argv.includes("--check"));
	}
	console.log(`Pi path-utils patch verified (${roots.size} package trees, ${count} files written)`);
}
