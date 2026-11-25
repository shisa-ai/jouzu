import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { paths, transform } from "./background-flow-transform.mjs";
import { resourceHelpers, transformBackgroundResources } from "./background-resource-transform.mjs";
import { claimBackgroundWidget } from "./background-widget-transform.mjs";

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
	const store = await readFile(join(root, "upstream/background-flow/store.ts"), "utf8");
	if (sha(store) !== lock.store) throw new Error("Background flow store hash mismatch.");
	if (sha(await readFile(join(root, "upstream/background-flow/resource-edits.json"))) !== lock.resourceEdits)
		throw new Error("Background resource edits hash mismatch.");
	const writes = [];
	for (const path of paths) {
		const original = await readFile(join(packageRoot, path), "utf8"),
			hashes = lock.files[path];
		const digest = sha(original);
		if (digest === hashes.after) continue;
		const upgradeWidget = path === paths[0] && digest === hashes.previousAfter;
		const upgradeResources = digest === hashes.resourcePreviousAfter;
		if (checkOnly || (digest !== hashes.before && !upgradeWidget && !upgradeResources))
			throw new Error(`Background flow hash mismatch: ${path}`);
		const changed = upgradeWidget
			? transformBackgroundResources(path, claimBackgroundWidget(original))
			: upgradeResources
				? transformBackgroundResources(path, original)
				: transform(path, original);
		if (sha(changed) !== hashes.after) throw new Error(`Background flow transform mismatch: ${path}`);
		writes.push([join(packageRoot, path), changed]);
	}
	if (JSON.stringify(Object.keys(lock.helpers ?? {}).sort()) !== JSON.stringify([...resourceHelpers].sort()))
		throw new Error("Background resource helper identity mismatch.");
	for (const name of resourceHelpers) {
		const source = await readFile(join(root, "upstream/background-flow/resources", name), "utf8");
		if (sha(source) !== lock.helpers[name]) throw new Error(`Background resource helper hash mismatch: ${name}`);
		const destination = join(packageRoot, "extensions", name);
		const installed = await readFile(destination, "utf8").catch((error) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (installed === source) continue;
		if (checkOnly || installed !== undefined) throw new Error(`Background resource installed helper mismatch: ${name}`);
		writes.push([destination, source]);
	}
	const destination = join(packageRoot, "extensions/jouzu-flow.ts");
	const installed = await readFile(destination, "utf8").catch((error) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (installed !== runtime) {
		// An install from the previous runtime revision upgrades in place; anything else is unexpected.
		if (checkOnly || (installed !== undefined && sha(installed) !== lock.previousRuntime))
			throw new Error("Background flow installed runtime mismatch.");
		writes.push([destination, runtime]);
	}
	const storeDestination = join(packageRoot, "extensions/jouzu-store.ts");
	const installedStore = await readFile(storeDestination, "utf8").catch((error) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (installedStore !== store) {
		// An install from the previous store revision upgrades in place; anything else is unexpected.
		if (checkOnly || (installedStore !== undefined && sha(installedStore) !== lock.previousStore))
			throw new Error("Background flow installed store mismatch.");
		writes.push([storeDestination, store]);
	}
	for (const [path, text] of writes) await writeFile(path, text);
	return writes.length;
}
export async function applyInstalledBackgroundFlow(checkOnly = false) {
	const roots = new Set(
		(
			await Promise.all(
				["node_modules", "packages/cli/node_modules"].map(async (path) => {
					try {
						return await realpath(join(root, path, "@vanillagreen/pi-background-tasks"));
					} catch (error) {
						if (error.code === "ENOENT") return undefined;
						throw error;
					}
				}),
			)
		).filter(Boolean),
	);
	for (const packageRoot of roots) await applyBackgroundFlow(packageRoot, checkOnly);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	await applyInstalledBackgroundFlow(process.argv.includes("--check"));
