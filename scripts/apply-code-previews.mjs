import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transform } from "./code-previews-transform.mjs";

const root = resolve(import.meta.dirname, "..");
const sha = (text) => createHash("sha256").update(text).digest("hex");
const LOCK_PATH = "upstream/code-previews/patch.lock.json";

export async function applyCodePreviews(packageRoot, checkOnly = false) {
	const manifest = await readFile(join(root, LOCK_PATH), "utf8");
	const lock = JSON.parse(manifest);
	const pin = JSON.parse(await readFile(join(root, "upstream/pi.lock.json"), "utf8"));
	if (pin.deviations.filter((record) => record.path === LOCK_PATH && record.sha256 === sha(manifest)).length !== 1)
		throw new Error("Code previews manifest differs from its pinned deviation.");
	const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	if (lock.schemaVersion !== 1 || pkg.name !== lock.package || pkg.version !== lock.version)
		throw new Error("Code previews package identity differs.");
	const writes = [];
	for (const [path, hashes] of Object.entries(lock.files)) {
		const original = await readFile(join(packageRoot, path), "utf8");
		const digest = sha(original);
		if (digest === hashes.after) continue;
		if (checkOnly || (digest !== hashes.before && digest !== hashes.previousAfter))
			throw new Error(`Code previews hash mismatch: ${path}`);
		const changed = transform(path, original);
		if (sha(changed) !== hashes.after) throw new Error(`Code previews transform mismatch: ${path}`);
		writes.push([join(packageRoot, path), changed]);
	}
	for (const [path, text] of writes) await writeFile(path, text);
	return writes.length;
}

export async function applyInstalledCodePreviews(checkOnly = false) {
	const roots = new Set();
	for (const path of ["node_modules", "packages/cli/node_modules"]) {
		const candidate = join(root, path, "pi-code-previews");
		try {
			roots.add(await realpath(candidate));
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	if (roots.size === 0) throw new Error("Code previews package is not installed");
	let writes = 0;
	for (const packageRoot of roots) writes += await applyCodePreviews(packageRoot, checkOnly);
	return writes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	await applyInstalledCodePreviews(process.argv.includes("--check"));
