import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { paths, transform } from "./pi-flow-control-transform.mjs";

const root = resolve(import.meta.dirname, "..");
const sha = (text) => createHash("sha256").update(text).digest("hex");

export async function applyFlowControl(codingAgentRoot, checkOnly = false) {
	const require = createRequire(join(codingAgentRoot, "package.json"));
	const packageRoot = dirname(require.resolve("@earendil-works/pi-agent-core/package.json"));
	const manifestPath = "upstream/pi-flow-control/patch.lock.json";
	const manifest = await readFile(join(root, manifestPath), "utf8");
	const lock = JSON.parse(manifest);
	const pin = JSON.parse(await readFile(join(root, "upstream/pi.lock.json"), "utf8"));
	const records = pin.deviations?.filter((record) => record.path === manifestPath) ?? [];
	if (records.length !== 1 || records[0].sha256 !== sha(manifest))
		throw new Error("Pi flow manifest does not match the pinned deviation");
	const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	if (
		lock.schemaVersion !== 1 ||
		lock.package !== "@earendil-works/pi-agent-core" ||
		pkg.name !== lock.package ||
		pkg.version !== lock.version ||
		lock.version !== pin.packages["@earendil-works/pi-coding-agent"]?.version
	)
		throw new Error("Pi flow package identity mismatch");
	if (JSON.stringify(Object.keys(lock.files).sort()) !== JSON.stringify([...paths].sort()))
		throw new Error("Pi flow path manifest mismatch");
	const writes = [];
	for (const path of paths) {
		const original = await readFile(join(packageRoot, path), "utf8");
		const hashes = lock.files[path];
		if (sha(original) === hashes.after) continue;
		if (checkOnly || sha(original) !== hashes.before) throw new Error(`Pi flow hash mismatch: ${path}`);
		const patched = transform(path, original);
		if (sha(patched) !== hashes.after) throw new Error(`Pi flow transformed hash mismatch: ${path}`);
		writes.push([join(packageRoot, path), patched]);
	}
	const types = await readFile(join(root, "upstream/pi-flow-control/types.d.ts"), "utf8");
	if (sha(types) !== lock.types) throw new Error("Pi flow types hash mismatch");
	const typesPath = join(packageRoot, "dist/jouzu-flow.d.ts");
	const installed = await readFile(typesPath, "utf8").catch((error) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (installed !== types) {
		if (checkOnly || installed !== undefined) throw new Error("Pi flow installed types mismatch");
		writes.push([typesPath, types]);
	}
	for (const [path, text] of writes) await writeFile(path, text);
	return writes.length;
}
