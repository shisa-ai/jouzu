#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFlowControl } from "./apply-pi-flow-control.mjs";
import { paths, transform } from "./pi-content-policy-transform.mjs";

const root = resolve(import.meta.dirname, "..");
const sha = (text) => createHash("sha256").update(text).digest("hex");
export async function applyContentPolicy(packageRoot, checkOnly = false) {
	const manifestPath = "upstream/pi-content-policy/patch.lock.json";
	const manifest = await readFile(join(root, manifestPath), "utf8");
	const lock = JSON.parse(manifest);
	const pin = JSON.parse(await readFile(join(root, "upstream/pi.lock.json"), "utf8"));
	const records = pin.deviations?.filter((record) => record.path === manifestPath) ?? [];
	if (records.length !== 1 || records[0].sha256 !== sha(manifest))
		throw new Error("Pi content-policy manifest does not match the pinned deviation");
	if (
		lock.schemaVersion !== 1 ||
		lock.package !== "@earendil-works/pi-coding-agent" ||
		lock.version !== pin.packages[lock.package]?.version
	)
		throw new Error("Pi content-policy lock identity mismatch");
	const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	if (pkg.name !== lock.package || pkg.version !== lock.version)
		throw new Error("Pi content-policy package identity mismatch");
	if (JSON.stringify(Object.keys(lock.files).sort()) !== JSON.stringify([...paths].sort()))
		throw new Error("Pi content-policy path manifest mismatch");
	const writes = [];
	for (const path of paths) {
		const original = await readFile(join(packageRoot, path), "utf8");
		const hashes = lock.files[path];
		if (sha(original) === hashes.after) continue;
		if (checkOnly || sha(original) !== hashes.before) throw new Error(`Pi content-policy hash mismatch: ${path}`);
		const patched = transform(path, original);
		if (sha(patched) !== hashes.after) throw new Error(`Pi content-policy transformed hash mismatch: ${path}`);
		writes.push([join(packageRoot, path), patched]);
	}
	const types = await readFile(join(root, "upstream/pi-content-policy/types.d.ts"), "utf8");
	if (sha(types) !== lock.types) throw new Error("Pi content-policy types hash mismatch");
	const typesPath = join(packageRoot, "dist/core/jouzu-content-policy.d.ts");
	const installed = await readFile(typesPath, "utf8").catch((error) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (installed !== types) {
		if (checkOnly || installed !== undefined) throw new Error("Pi content-policy installed types mismatch");
		writes.push([typesPath, types]);
	}
	// Verify every input and output before changing any installed dependency file.
	for (const [path, text] of writes) await writeFile(path, text);
	return writes.length;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const roots = new Set();
	for (const base of [root, join(root, "packages/cli")]) {
		const path = join(base, "node_modules/@earendil-works/pi-coding-agent");
		try {
			roots.add(await realpath(path));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	if (roots.size === 0) throw new Error("Pi package is missing; run npm ci first");
	let count = 0;
	for (const packageRoot of roots) {
		count += await applyContentPolicy(packageRoot, process.argv.includes("--check"));
		count += await applyFlowControl(packageRoot, process.argv.includes("--check"));
	}
	for (const base of [root, join(root, "packages/cli")]) {
		count += await applyFlowControl(base, process.argv.includes("--check"));
	}
	console.log(`Pi content-policy patch verified (${roots.size} package trees, ${count} files written)`);
}
