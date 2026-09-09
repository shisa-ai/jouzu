export const extensionPath = "extensions/pi-multiloop/index.ts";
function replace(source, from, to) {
	if (source.split(from).length !== 2) throw new Error("Multiloop flow source anchor differs.");
	return source.replace(from, to);
}
export function transformMultiloopFlow(source) {
	source = replace(
		source,
		"import { Text }",
		'import { multiloopFlow, connectMultiloopFlow } from "./jouzu-flow.js";\nimport { Text }',
	);
	source = replace(
		source,
		'  pi.on("session_start", async (_event, ctx) => {\n    announceResumableLoops(pi, ctx);',
		'  let detachFlow: (() => void) | undefined;\n  pi.on("session_shutdown", async () => { detachFlow?.(); detachFlow = undefined; });\n  pi.on("session_start", async (_event, ctx) => {\n    detachFlow?.();\n    detachFlow = connectMultiloopFlow(pi.events, ctx.sessionManager.getSessionId());\n    updateStatus(ctx);\n    announceResumableLoops(pi, ctx);',
	);
	for (const [name, parameters, reason, build, accounting] of [
		[
			"queueCompactionResume",
			"  compactionEntryId?: string",
			'"compaction-resume"',
			"buildCompactionResumePrompt([current], compactionEntryId)",
			'markLoopTurn("compaction-resume");',
		],
		[
			"queueLoopAutoContinue",
			"  reason: string",
			"`auto-continue:${reason}`",
			"buildAutoContinuePrompt([current], taskSnapshotFor(ctx))",
			"markLoopTurn(`auto-continue:${reason}`); continuationsQueued += 1; toolCallsSinceContinuation = 0;",
		],
	]) {
		const signature = `function ${name}(\n  pi: ExtensionAPI,\n  ctx: ExtensionContext,\n${parameters}\n): void {\n`;
		source = replace(
			source,
			signature,
			`${signature}  const flow = multiloopFlow(ctx.sessionManager.getSessionId());\n  if (flow) {\n    for (const state of runningStates()) {\n      const lane = { lane: state.lane, runTag: state.runTag };\n      flow.submit({\n        lane, reason: ${reason},\n        build() {\n          const current = activeStates.get(stateKey(lane));\n          if (!current || current.status !== "running") throw new Error("Multiloop continuation is no longer active.");\n          return ${build};\n        },\n        admitted() {
          const current = activeStates.get(stateKey(lane));
          if (!current || current.status !== "running") throw new Error("Multiloop continuation is no longer active.");
          ${accounting}
        },\n      });\n    }\n    return;\n  }\n`,
		);
	}
	source = replace(
		source,
		"    if (cascadingTasksWillDrive(ctx)) return;",
		"    if (!multiloopFlow(ctx.sessionManager.getSessionId()) && cascadingTasksWillDrive(ctx)) return;",
	);
	source = replace(
		source,
		"      const stalled = runningStates();",
		"      const flow = multiloopFlow(ctx.sessionManager.getSessionId());\n      const stalled = runningStates().filter((state) => !flow?.waiting({ lane: state.lane, runTag: state.runTag }));",
	);
	source = replace(
		source,
		"  function updateStatus(ctx: ExtensionContext | ExtensionCommandContext) {",
		"  function updateStatus(ctx: ExtensionContext | ExtensionCommandContext) {\n    multiloopFlow(ctx.sessionManager.getSessionId())?.changed(runningStates().map((state) => ({ lane: state.lane, runTag: state.runTag })));",
	);
	return transformMultiloopLifecycle(source);
}

export function transformMultiloopLifecycle(source) {
	for (const [name, result] of [
		["startLoop", "LoopState"],
		["resumeLoop", "LoopState | null"],
		["pauseLoop", "string"],
		["stopLoop", "string"],
		["pauseAllActive", "string[]"],
		["stopAllActive", "string[]"],
		["startQuickGoal", "LoopState"],
		["completeGoal", "string"],
		["archiveLoopTarget", "string"],
	]) {
		const signature = new RegExp(
			`  function ${name}\\(([\\s\\S]*?)\\): ${result.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`,
		);
		if (!signature.test(source)) throw new Error(`Multiloop lifecycle signature differs: ${name}`);
		source = source.replace(signature, `  async function ${name}($1): Promise<${result}> {`);
		source = source.replace(new RegExp(`(?<!function )\\b${name}\\(`, "g"), `await ${name}(`);
	}
	source = replace(
		source,
		"    ensureLaneDir(ctx.cwd, id);\n",
		'    await multiloopFlow(ctx.sessionManager.getSessionId())?.transition?.(id, "active");\n    ensureLaneDir(ctx.cwd, id);\n',
	);
	source = replace(
		source,
		'    if (!state) return null;\n    state.status = "running";',
		'    if (!state) return null;\n    await multiloopFlow(ctx.sessionManager.getSessionId())?.transition?.(id, "active");\n    state.status = "running";',
	);
	for (const status of ["paused", "stopped"])
		source = replace(
			source,
			`    state.status = "${status}";\n    saveState(ctx.cwd, id, state);`,
			`    await multiloopFlow(ctx.sessionManager.getSessionId())?.transition?.(id, "${status}");\n    state.status = "${status}";\n    saveState(ctx.cwd, id, state);`,
		);
	source = replace(
		source,
		'    state.status = "completed";\n    saveState(ctx.cwd, id, state);',
		'    await multiloopFlow(ctx.sessionManager.getSessionId())?.transition?.(id, "completed");\n    state.status = "completed";\n    saveState(ctx.cwd, id, state);',
	);
	source = replace(
		source,
		'        lines.push("Loop has been stopped due to escalation exhaustion.");',
		'        await multiloopFlow(ctx.sessionManager.getSessionId())?.transition?.(id, "stopped");\n        lines.push("Loop has been stopped due to escalation exhaustion.");',
	);
	for (const anchor of [
		"    const summary = loopSummary(ctx.cwd, loop);\n    archiveLaneDirs(ctx.cwd, id);",
		"        try {\n          archiveLaneDirs(ctx.cwd, id);",
		"        activeStates.delete(stateKey(id));\n        deleteLaneDirs(ctx.cwd, id);",
	]) {
		const indent = anchor.match(/^ */)[0];
		source = replace(
			source,
			anchor,
			`${indent}await multiloopFlow(ctx.sessionManager.getSessionId())?.transition?.(id, "stopped");\n${anchor}`,
		);
	}
	source = replace(
		source,
		"          const id = goalId(goal);\n          activeStates.delete(stateKey(id));",
		'          const id = goalId(goal);\n          await multiloopFlow(ctx.sessionManager.getSessionId())?.transition?.(id, "paused");\n          activeStates.delete(stateKey(id));',
	);
	source = replace(
		source,
		"  /** The attached quick goal, if one is running or paused in this session. */",
		"  let pausedQuickGoal: LoopState | null = null;\n  /** The attached quick goal, if one is running or paused in this session. */",
	);
	source = replace(
		source,
		'    state.status = "paused";\n    saveState(ctx.cwd, id, state);',
		'    state.status = "paused";\n    if (isQuickGoal(state)) pausedQuickGoal = state;\n    saveState(ctx.cwd, id, state);',
	);
	source = replace(
		source,
		"    return null;\n  }\n\n  function goalId",
		'    return pausedQuickGoal?.status === "paused" ? pausedQuickGoal : null;\n  }\n\n  function goalId',
	);
	source = replace(
		source,
		"          await startQuickGoal(ctx, objective, command.tokenBudget);",
		"          await startQuickGoal(ctx, objective, command.tokenBudget);\n          pausedQuickGoal = null;",
	);
	source = replace(
		source,
		"          activeStates.delete(stateKey(id));\n          updateStatus(ctx);",
		"          activeStates.delete(stateKey(id));\n          pausedQuickGoal = null;\n          updateStatus(ctx);",
	);
	const helper = `function queueExplicitFlow(pi: ExtensionAPI, ctx: ExtensionContext, state: LoopState, reason: string, build: () => string): void {\n  const flow = multiloopFlow(ctx.sessionManager.getSessionId());\n  if (!flow) { pi.sendUserMessage(build(), { deliverAs: "followUp" }); return; }\n  const lane = { lane: state.lane, runTag: state.runTag };\n  const active = () => { if (activeStates.get(stateKey(lane))?.status !== "running") throw new Error("Multiloop lane is no longer active."); };\n  flow.submit({ lane, reason, build() { active(); return build(); }, admitted() { active(); markLoopTurn(reason); } });\n}\n\n`;
	source = replace(source, "function queueCompactionResume(\n", `${helper}function queueCompactionResume(\n`);
	source = replace(
		source,
		'    pi.sendUserMessage(\n      buildQuickGoalStartPrompt({ lane: state.lane, runTag: state.runTag, objective }),\n      { deliverAs: "followUp" }\n    );',
		'    queueExplicitFlow(pi, ctx, state, "goal-start", () => buildQuickGoalStartPrompt({ lane: state.lane, runTag: state.runTag, objective }));',
	);
	source = replace(
		source,
		'          pi.sendUserMessage(buildAutoContinuePrompt([resumed], taskSnapshotFor(ctx)), { deliverAs: "followUp" });',
		'          queueExplicitFlow(pi, ctx, resumed, "goal-resume", () => buildAutoContinuePrompt([resumed], taskSnapshotFor(ctx)));',
	);
	source = replace(
		source,
		'        pi.sendUserMessage(buildExplicitResumePrompt([state]), { deliverAs: "followUp" });',
		'        queueExplicitFlow(pi, ctx, state, "explicit-resume", () => buildExplicitResumePrompt([state]));',
	);
	source = source.replace(
		/^( +)(await multiloopFlow\(ctx.sessionManager.getSessionId\(\)\)\?\.transition\?\.\(id, "(?:active|stopped)"\);)$/gm,
		"$1$2\n$1if (pausedQuickGoal && stateKey(pausedQuickGoal) === stateKey(id)) pausedQuickGoal = null;",
	);
	return source;
}
