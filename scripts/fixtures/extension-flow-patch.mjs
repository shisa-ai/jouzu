import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { transformBackgroundResources } from "../background-resource-transform.mjs";

const root = resolve(import.meta.dirname, "../..");
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Run the production installer in an isolated repository with its own deviation pin. */
export async function extensionPatchFixture(t, kind, sourceRoot) {
	const directory = await mkdtemp(join(tmpdir(), `jouzu-${kind}-patch-`));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const background = kind === "background";
	const patch = background ? "background-flow" : "multiloop-wait-skill";
	const script = background ? "apply-background-flow.mjs" : "apply-multiloop-wait-skill.mjs";
	const scripts = background
		? [script, "background-flow-transform.mjs", "background-widget-transform.mjs", "background-resource-transform.mjs"]
		: [script, "multiloop-flow-transform.mjs"];
	await mkdir(join(directory, "scripts"));
	for (const path of scripts) await cp(join(root, "scripts", path), join(directory, "scripts", path));
	await cp(join(root, "upstream", patch), join(directory, "upstream", patch), { recursive: true });
	const manifestPath = `upstream/${patch}/patch.lock.json`;
	const manifest = await readFile(join(directory, manifestPath), "utf8");
	await writeFile(
		join(directory, "upstream/pi.lock.json"),
		JSON.stringify({ deviations: [{ path: manifestPath, sha256: sha256(manifest) }] }),
	);
	const packageRoot = join(directory, "package");
	await cp(
		sourceRoot ??
			join(root, "packages/cli/node_modules", background ? "@vanillagreen/pi-background-tasks" : "pi-multiloop"),
		packageRoot,
		{ recursive: true, dereference: true },
	);
	const module = await import(pathToFileURL(join(directory, "scripts", script)).href);
	return {
		directory,
		packageRoot,
		lock: JSON.parse(manifest),
		apply: background ? module.applyBackgroundFlow : module.applyMultiloopWaitSkill,
	};
}

function replace(source, from, to) {
	if (source.split(from).length !== 2) throw new Error("Patch upgrade fixture anchor differs.");
	return source.replace(from, to);
}

/** The candidate with flow wiring but without the downstream widget guard. */
export function backgroundWidgetPredecessor(source) {
	source = transformBackgroundResources("extensions/background-tasks.ts", source, true);
	source = replace(
		source,
		"\tconst widgetClaims = createBackgroundWidgetClaims(() => {\n\t\tif (activeCtx && !shuttingDown) syncWidget(activeCtx);\n\t}, () => !!activeCtx?.hasUI && !shuttingDown);",
		"\tconst widgetClaims = createBackgroundWidgetClaims(() => {\n\t\tif (activeCtx) syncWidget(activeCtx);\n\t});",
	);
	source = replace(
		source,
		"\t\tactiveCtx = null;\n\t\twidgetClaims.releaseAll();\n\t\tshuttingDown = false;",
		"\t\tshuttingDown = false;\n\t\twidgetClaims.releaseAll();",
	);
	return replace(
		source,
		"\t\tpi.events?.emit?.(BACKGROUND_WIDGET_READY, { version: 1 });\n\t\tsyncWidget(ctx);",
		"\t\tsyncWidget(ctx);\n\t\tpi.events?.emit?.(BACKGROUND_WIDGET_READY, { version: 1 });",
	);
}

/** The store before a session with no background state stopped creating its file. */
export function backgroundStorePredecessor(source) {
	return replace(
		source,
		"\t\t// A session that never ran a background task has nothing to record. Creating its\n\t\t// store would leave files behind for every session that is opened and closed unused.\n\t\tif (!priorState() && deps.tasks().length === 0 && deps.results().length === 0) return;\n",
		"",
	);
}

/** Reconstruct each supported partial patch, preserving all fork-owned source bytes. */
export function multiloopPredecessors(source) {
	source = replace(source, "      if (flow.retained?.(lane)) continue;\n", "");
	let previous = replace(
		source,
		'    "Autonomous task policy: do not set TaskUpdate waitForUser or paused during this loop. Reconcile resolved task waits by clearing the flag and completing the task with a result summary.",\n',
		"",
	);
	previous = replace(
		previous,
		'    "Autonomous task policy: do not create user-wait or paused task gates; resolve routine ambiguity and continue.",\n',
		"",
	);
	previous = replace(
		previous,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture quotes patched TypeScript
		'      const flow = multiloopFlow(ctx.sessionManager.getSessionId());\n      const blocked = Array.from(statusStates.values()).filter((state) => state.status === "running" && flow?.waiting({ lane: state.lane, runTag: state.runTag })).length;\n      ctx.ui.setStatus("multiloop", `multiloop: ${summaries.join(", ")}${blocked ? ` · ${blocked} blocked (see /flow)` : ""}`);',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture quotes patched TypeScript
		'      ctx.ui.setStatus("multiloop", `multiloop: ${summaries.join(", ")}`);',
	);
	let continuation = replace(
		previous,
		'        loopTurnReason = "user-suppressed";',
		"        loopTurnReason = undefined;",
	);
	continuation = replace(
		continuation,
		'    if (!endedLoopTurn && (endedLoopReason === "user-suppressed" || !multiloopFlowDriving(ctx.sessionManager.getSessionId()))) return;',
		"    if (!endedLoopTurn) return;",
	);
	continuation = replace(
		continuation,
		"    if (endedLoopTurn && continuationsQueued > 0 && toolCallsSinceContinuation === 0) {",
		"    if (continuationsQueued > 0 && toolCallsSinceContinuation === 0) {",
	);
	const label =
		'    pi.events.emit("jouzu:workflow-start", { session: ctx.sessionManager.getSessionId(), objective: state.goal, identity: stateKey(state) });\n';
	if (continuation.split(label).length !== 3) throw new Error("Multiloop label upgrade fixture differs.");
	return {
		previousAfter: previous,
		continuationPreviousAfter: continuation,
		labelsPreviousAfter: continuation.replaceAll(label, ""),
	};
}
