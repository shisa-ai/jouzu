export const extensionPath = "extensions/pi-multiloop/index.ts";
function replace(source, from, to) {
	if (source.split(from).length !== 2) throw new Error("Multiloop flow source anchor differs.");
	return source.replace(from, to);
}
export function transformMultiloopFlow(source) {
	source = replace(source, "import { Text }", 'import { multiloopFlow } from "./jouzu-flow.js";\nimport { Text }');
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
	return source;
}
