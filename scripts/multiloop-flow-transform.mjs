export const extensionPath = "extensions/pi-multiloop/index.ts";
function replace(source, from, to) {
	if (source.split(from).length !== 2) throw new Error("Multiloop flow source anchor differs.");
	return source.replace(from, to);
}
export function reconnectMultiloopOnTree(source) {
	const anchor = '  pi.on("session_start", async (_event, ctx) => {';
	if (source.split(anchor).length !== 2) throw new Error("Multiloop tree lifecycle source anchor differs.");
	const marker = `  pi.on("session_start", async (_event, ctx) => {
    detachFlow?.();
    detachFlow = connectMultiloopFlow(pi.events, ctx.sessionManager.getSessionId());
    statusStates.clear();
    updateStatus(ctx);
    announceResumableLoops(pi, ctx);
  });`;
	if (source.split(marker).length !== 2) throw new Error("Multiloop tree lifecycle marker differs.");
	return source.replace(
		marker,
		`${marker}
  pi.on("session_tree", async (_event, ctx) => {
    detachFlow?.();
    detachFlow = connectMultiloopFlow(pi.events, ctx.sessionManager.getSessionId());
    updateStatus(ctx);
  });`,
	);
}

/**
 * Driving decisions ask the gated lookup, so flow control stops routing continuations while it is off;
 * lifecycle, status, and wait reporting keep using the host they already hold.
 */
export function gateMultiloopFlowDriving(source) {
	source = replace(
		source,
		'import { multiloopFlow, connectMultiloopFlow } from "./jouzu-flow.js";',
		'import { multiloopFlow, multiloopFlowDriving, connectMultiloopFlow } from "./jouzu-flow.js";',
	);
	source = replace(
		source,
		"function queueExplicitFlow(pi: ExtensionAPI, ctx: ExtensionContext, state: LoopState, reason: string, build: () => string): void {\n  const flow = multiloopFlow(ctx.sessionManager.getSessionId());",
		"function queueExplicitFlow(pi: ExtensionAPI, ctx: ExtensionContext, state: LoopState, reason: string, build: () => string): void {\n  const flow = multiloopFlowDriving(ctx.sessionManager.getSessionId());",
	);
	for (const [name, parameters] of [
		["queueCompactionResume", "  compactionEntryId?: string"],
		["queueLoopAutoContinue", "  reason: string"],
	]) {
		source = replace(
			source,
			`function ${name}(\n  pi: ExtensionAPI,\n  ctx: ExtensionContext,\n${parameters}\n): void {\n  const flow = multiloopFlow(ctx.sessionManager.getSessionId());`,
			`function ${name}(\n  pi: ExtensionAPI,\n  ctx: ExtensionContext,\n${parameters}\n): void {\n  const flow = multiloopFlowDriving(ctx.sessionManager.getSessionId());`,
		);
	}
	return replace(
		source,
		"    if (!multiloopFlow(ctx.sessionManager.getSessionId()) && cascadingTasksWillDrive(ctx)) return;",
		"    if (!multiloopFlowDriving(ctx.sessionManager.getSessionId()) && cascadingTasksWillDrive(ctx)) return;",
	);
}

export function transformMultiloopFlow(source) {
	source = replace(
		source,
		"import { Text }",
		'import { multiloopFlow, connectMultiloopFlow } from "./jouzu-flow.js";\nimport { Text }',
	);
	source = replace(
		source,
		'  pi.on("session_start", async (_event, ctx) => {\n    announceResumableLoops(pi, ctx);\n  });',
		'  let detachFlow: (() => void) | undefined;\n  pi.on("session_shutdown", async () => { detachFlow?.(); detachFlow = undefined; });\n  pi.on("session_start", async (_event, ctx) => {\n    detachFlow?.();\n    detachFlow = connectMultiloopFlow(pi.events, ctx.sessionManager.getSessionId());\n    updateStatus(ctx);\n    announceResumableLoops(pi, ctx);\n  });\n  pi.on("session_tree", async (_event, ctx) => {\n    detachFlow?.();\n    detachFlow = connectMultiloopFlow(pi.events, ctx.sessionManager.getSessionId());\n    updateStatus(ctx);\n  });',
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
	return gateMultiloopFlowDriving(transformMultiloopStatus(transformGoalResume(transformMultiloopLifecycle(source))));
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
	source = replace(
		source,
		'        pi.sendUserMessage(buildAutoContinuePrompt([resumed], taskSnapshotFor(ctx)), { deliverAs: "followUp" });',
		'        queueExplicitFlow(pi, ctx, resumed, "goal-resume", () => buildAutoContinuePrompt([resumed], taskSnapshotFor(ctx)));',
	);
	return source;
}

function transformGoalResume(source) {
	source = replace(
		source,
		"const implicit = (attached && eligible.find((loop) => stateKey(loop) === stateKey(attached)))",
		'const implicit = (operation !== "resume" && attached && eligible.find((loop) => stateKey(loop) === stateKey(attached)))',
	);
	source = replace(
		source,
		'        if (resolution.status !== "resolved") {\n          ctx.ui.notify([',
		`        if (resolution.status !== "resolved") {
          if (operation === "resume") {
            ctx.ui.notify("Finding the goal to resume…", "info");
            pi.sendUserMessage([
              "Resume the user's saved goal. Resolve the target from the conversation and the saved goals below.",
              "Only resume a goal from this list. If the intended goal is still unclear, ask the user which goal to resume. Do not create a new goal.",
              ...eligible.map((loop) => formatGoalStatus(activeStates.get(stateKey(loop)) ?? loadState(ctx.cwd, loop)!)),
              buildTargetDisambiguationPrompt("resume", target, resolution, eligible),
            ].join("\\n"), { deliverAs: "followUp" });
            return;
          }
          ctx.ui.notify([`,
	);
	source = source.replaceAll(
		"() => buildAutoContinuePrompt([resumed], taskSnapshotFor(ctx))",
		'() => "Resume the selected goal.\\n\\n" + buildAutoContinuePrompt([resumed], taskSnapshotFor(ctx))',
	);
	source = replace(
		source,
		'      markLoopTurn("tool-resume");',
		`      if (isQuickGoal(state)) {
        queueExplicitFlow(pi, ctx, state, "goal-resume", () => "Resume the selected goal.\\n\\n" + buildAutoContinuePrompt([state], taskSnapshotFor(ctx)));
        return textResult("Resumed goal " + formatLaneId(resolution.id) + ".\\n\\n" + buildAutoContinuePrompt([state], taskSnapshotFor(ctx)));
      }
      markLoopTurn("tool-resume");`,
	);
	source = replace(
		source,
		'"Without a target, use the attached goal or the only matching goal.",',
		'"Resume selects the only goal or asks the agent to find it. Pause and stop use the attached goal or the only matching goal.",',
	);
	return source;
}

function transformMultiloopStatus(source) {
	source = replace(
		source,
		"  let pausedQuickGoal: LoopState | null = null;",
		"  const statusStates = new Map<string, LoopState>();\n  let pausedQuickGoal: LoopState | null = null;",
	);
	source = replace(
		source,
		"    updateStatus(ctx);\n    announceResumableLoops(pi, ctx);",
		"    statusStates.clear();\n    updateStatus(ctx);\n    announceResumableLoops(pi, ctx);",
	);
	for (const name of ["startLoop", "resumeLoop", "pauseLoop", "stopLoop", "completeGoal"]) {
		const start = source.indexOf(`  async function ${name}(`);
		const end = source.indexOf("\n  }", start);
		if (start < 0 || end < 0) throw new Error(`Multiloop status function differs: ${name}`);
		const body = source.slice(start, end);
		source =
			source.slice(0, start) +
			replace(body, "    updateStatus(ctx);", "    updateStatus(ctx, state);") +
			source.slice(end);
	}
	source = replace(
		source,
		"  function updateStatus(ctx: ExtensionContext | ExtensionCommandContext) {",
		"  function updateStatus(ctx: ExtensionContext | ExtensionCommandContext, changedState?: LoopState) {\n    if (changedState) statusStates.set(stateKey(changedState), changedState);\n    for (const state of activeStates.values()) statusStates.set(stateKey(state), state);",
	);
	source = replace(
		source,
		`    if (activeStates.size > 0) {
      const summaries = Array.from(activeStates.values()).map(
        (s) => \`\${s.lane}#\${s.iteration}\`
      );`,
		`    if (statusStates.size > 0) {
      const summaries = ["running", "paused", "stopped", "completed"].flatMap((status) => {
        const count = Array.from(statusStates.values()).filter((state) => state.status === status).length;
        return count ? [\`\${count} \${status}\`] : [];
      });`,
	);
	for (const anchor of [
		"    archiveLaneDirs(ctx.cwd, id);",
		"          archiveLaneDirs(ctx.cwd, id);",
		"        deleteLaneDirs(ctx.cwd, id);",
		"          pausedQuickGoal = null;\n          updateStatus(ctx);",
	]) {
		const indent = anchor.match(/^ */)[0];
		source = replace(source, `\n${anchor}`, `\n${indent}statusStates.delete(stateKey(id));\n${anchor}`);
	}
	return source;
}
