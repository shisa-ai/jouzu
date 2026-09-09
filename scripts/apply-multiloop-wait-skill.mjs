import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, transformMultiloopFlow } from "./multiloop-flow-transform.mjs";

const root = resolve(import.meta.dirname, "..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
export const skillPath = "skills/multiloop/SKILL.md";
export function transformMultiloopWaitSkill(source) {
	const needle = "## Work accounting\n";
	if (source.split(needle).length !== 2) throw new Error("Multiloop wait skill source anchor differs.");
	return source.replace(
		needle,
		`## Asynchronous dependencies\n\nWhen agent_wait is among the active tools, these rules apply to goals, measured loops, and their task lists:\n\n- Continue useful work independent of live dependencies. Before ending a turn whose remaining work depends on asynchronous execution, call agent_wait with the owning work and exact producer, handle, execution, and predicate returned by its tools. Do not invent work IDs or infer completion from a display handle.\n- State the dependency in the reason and choose a mandatory hard deadline, such as 30m or 8h, with bounded slack. Deadline-only waits accept no checkAfter or health policy. Keep the effective expiresAt returned by the tool.\n- If agent_wait returns waiting and no independent work remains, end the turn. This is an exception to continuing immediately after decide/log: preserve the goal, iteration, and task state while the dependency gate holds them. Do not add polling, extra continuations, or unrelated tool calls to keep a lane active.\n- Status questions preserve the existing token and original expiry. Use the latest supplied wait state after user input or context restoration; do not redeclare or renew it to answer a status question.\n- If the user redirects work, cancel or explicitly replace the affected wait and update its owning work before ending the turn. Replacement requires replaceToken. At expiry or dependency failure, decide whether to repair, stop, or explicitly declare a new wait.\n- agent_wait_cancel removes only the gate. It does not stop the underlying process, complete a task, or retire the goal. A successful wait means the dependency predicate was satisfied; the ordinary completion audit still applies to the work.\n\n${needle}`,
	);
}
export async function applyMultiloopWaitSkill(packageRoot, checkOnly = false) {
	const manifest = await readFile(join(root, "upstream/multiloop-wait-skill/patch.lock.json"), "utf8");
	const lock = JSON.parse(manifest);
	const pin = JSON.parse(await readFile(join(root, "upstream/pi.lock.json"), "utf8"));
	if (
		pin.deviations.filter(
			(item) => item.path === "upstream/multiloop-wait-skill/patch.lock.json" && item.sha256 === sha(manifest),
		).length !== 1
	)
		throw new Error("Multiloop wait skill manifest differs from its pinned deviation.");
	const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	if (lock.schemaVersion !== 1 || pkg.name !== lock.package || pkg.version !== lock.version || lock.path !== skillPath)
		throw new Error("Multiloop wait skill package identity differs.");
	const path = join(packageRoot, skillPath),
		original = await readFile(path, "utf8");
	const writes = [];
	if (sha(original) !== lock.after) {
		if (checkOnly || sha(original) !== lock.before) throw new Error("Multiloop wait skill source hash differs.");
		const changed = transformMultiloopWaitSkill(original);
		if (sha(changed) !== lock.after) throw new Error("Multiloop wait skill transform differs.");
		writes.push([path, changed]);
	}
	const extension = await readFile(join(packageRoot, extensionPath), "utf8");
	if (sha(extension) !== lock.extension.after) {
		if (checkOnly || sha(extension) !== lock.extension.before)
			throw new Error("Multiloop extension source hash differs.");
		const changed = transformMultiloopFlow(extension);
		if (sha(changed) !== lock.extension.after) throw new Error("Multiloop extension transform differs.");
		writes.push([join(packageRoot, extensionPath), changed]);
	}
	const runtime = await readFile(join(root, "upstream/multiloop-wait-skill/runtime.ts"), "utf8");
	if (sha(runtime) !== lock.runtime) throw new Error("Multiloop flow runtime hash differs.");
	const destination = join(packageRoot, "extensions/pi-multiloop/jouzu-flow.ts");
	const installed = await readFile(destination, "utf8").catch((error) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (installed !== runtime) {
		if (checkOnly || installed !== undefined) throw new Error("Multiloop installed runtime differs.");
		writes.push([destination, runtime]);
	}
	for (const [destination, content] of writes) await writeFile(destination, content);
	return writes.length;
}
export async function applyInstalledMultiloopWaitSkill(checkOnly = false) {
	const packageRoot = await realpath(join(root, "packages/cli/node_modules/pi-multiloop"));
	await applyMultiloopWaitSkill(packageRoot, checkOnly);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	await applyInstalledMultiloopWaitSkill(process.argv.includes("--check"));
