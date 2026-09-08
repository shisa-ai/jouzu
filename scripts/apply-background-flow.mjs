import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { paths, transform } from "./background-flow-transform.mjs";

const root = resolve(import.meta.dirname, "..");
const sha = (text) => createHash("sha256").update(text).digest("hex");
export async function applyBackgroundFlow(packageRoot, checkOnly = false) {
	const manifest = await readFile(join(root, "upstream/background-flow/patch.lock.json"), "utf8");
	const lock = JSON.parse(manifest),
		pin = JSON.parse(await readFile(join(root, "upstream/pi.lock.json"), "utf8"));
	if (
		pin.deviations.filter(
			(record) => record.path === "upstream/background-flow/patch.lock.json" && record.sha256 === sha(manifest),
		).length !== 1
	)
		throw new Error("Background flow manifest differs from its pinned deviation.");
	const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	if (
		lock.schemaVersion !== 1 ||
		pkg.name !== lock.package ||
		pkg.version !== lock.version ||
		JSON.stringify(Object.keys(lock.files).sort()) !== JSON.stringify([...paths].sort())
	)
		throw new Error("Background flow package or path identity mismatch.");
	const runtime = await readFile(join(root, "upstream/background-flow/runtime.ts"), "utf8");
	if (sha(runtime) !== lock.runtime) throw new Error("Background flow runtime hash mismatch.");
	const writes = [];
	for (const path of paths) {
		const original = await readFile(join(packageRoot, path), "utf8"),
			hashes = lock.files[path];
		if (sha(original) === hashes.after) continue;
		if (checkOnly || sha(original) !== hashes.before) throw new Error(`Background flow hash mismatch: ${path}`);
		const changed = transform(path, original);
		if (sha(changed) !== hashes.after) throw new Error(`Background flow transform mismatch: ${path}`);
		writes.push([join(packageRoot, path), changed]);
	}
	const destination = join(packageRoot, "extensions/jouzu-flow.ts");
	const installed = await readFile(destination, "utf8").catch((error) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (installed !== runtime) {
		if (checkOnly || installed !== undefined) throw new Error("Background flow installed runtime mismatch.");
		writes.push([destination, runtime]);
	}
	for (const [path, text] of writes) await writeFile(path, text);
	return writes.length;
}
export async function applyInstalledBackgroundFlow(checkOnly = false) {
	const roots = new Set(
		await Promise.all(
			["node_modules", "packages/cli/node_modules"].map((path) =>
				realpath(join(root, path, "@vanillagreen/pi-background-tasks")),
			),
		),
	);
	for (const packageRoot of roots) await applyBackgroundFlow(packageRoot, checkOnly);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	await applyInstalledBackgroundFlow(process.argv.includes("--check"));
