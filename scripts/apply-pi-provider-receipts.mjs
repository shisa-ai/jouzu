import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { paths, transform } from "./pi-provider-receipts-transform.mjs";

const root = resolve(import.meta.dirname, "..");
const sha = (text) => createHash("sha256").update(text).digest("hex");

export async function applyProviderReceipts(codingAgentRoot, checkOnly = false) {
	const require = createRequire(join(codingAgentRoot, "package.json"));
	let packageRoot;
	for (const directory of require.resolve.paths("@earendil-works/pi-ai") ?? []) {
		const candidate = join(directory, "@earendil-works/pi-ai");
		try {
			await readFile(join(candidate, "package.json"));
			packageRoot = candidate;
			break;
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	if (!packageRoot) throw new Error("Pi provider package is missing.");
	const manifestPath = "upstream/pi-provider-receipts/patch.lock.json";
	const manifest = await readFile(join(root, manifestPath), "utf8");
	const lock = JSON.parse(manifest);
	const pin = JSON.parse(await readFile(join(root, "upstream/pi.lock.json"), "utf8"));
	const records = pin.deviations?.filter((record) => record.path === manifestPath) ?? [];
	if (records.length !== 1 || records[0].sha256 !== sha(manifest))
		throw new Error("Pi provider receipt manifest does not match the pinned deviation");
	const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	if (
		lock.schemaVersion !== 1 ||
		lock.package !== "@earendil-works/pi-ai" ||
		pkg.name !== lock.package ||
		pkg.version !== lock.version ||
		lock.version !== pin.packages["@earendil-works/pi-coding-agent"]?.version
	)
		throw new Error("Pi provider receipt package identity mismatch");
	if (JSON.stringify(Object.keys(lock.files).sort()) !== JSON.stringify([...paths].sort()))
		throw new Error("Pi provider receipt path manifest mismatch");
	const writes = [];
	for (const path of paths) {
		const original = await readFile(join(packageRoot, path), "utf8");
		const hashes = lock.files[path];
		if (sha(original) === hashes.after) continue;
		if (checkOnly || sha(original) !== hashes.before) throw new Error(`Pi provider receipt hash mismatch: ${path}`);
		const patched = transform(path, original);
		if (sha(patched) !== hashes.after) throw new Error(`Pi provider receipt transformed hash mismatch: ${path}`);
		writes.push([join(packageRoot, path), patched]);
	}
	for (const [path, text] of writes) await writeFile(path, text);
	return writes.length;
}
