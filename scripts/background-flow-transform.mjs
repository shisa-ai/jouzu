export const paths = [
	"extensions/background-tasks.ts",
	"extensions/snapshot.ts",
	"extensions/types.ts",
	"extensions/wake-events.ts",
	"extensions/render.ts",
];
function replace(source, from, to) {
	if (source.split(from).length !== 2) throw new Error("Background flow source anchor changed.");
	return source.replace(from, to);
}
export function transform(path, source) {
	if (path === paths[0]) {
		source = replace(
			source,
			'import { spawn } from "node:child_process";',
			'import { spawn } from "node:child_process";\nimport { backgroundFlowSource } from "./snapshot.js";',
		);
		source = replace(
			source,
			"\t\tconst child = spawn(spawnPlan.file, spawnPlan.args, {",
			"\t\tconst flow = backgroundFlowSource.newExecution(activeSessionId);\n\t\tconst child = spawn(spawnPlan.file, spawnPlan.args, {",
		);
		source = replace(source, "\t\tconst task: ManagedTask = {\n", "\t\tconst task: ManagedTask = {\n\t\t\tflow,\n");
		return replace(
			source,
			'\tpi.on("session_start", (_event, ctx) => {',
			`
	pi.events.on("jouzu:background-flow-source", (data) => {
		const request = data as { version: number; context: ExtensionContext; sessionId: string; accept(source: typeof backgroundFlowSource): void; reject(error: unknown): void };
		if (request?.version !== 1 || typeof request.accept !== "function" || typeof request.reject !== "function") return;
		try {
			if (request.context?.sessionManager.getSessionId() !== request.sessionId) throw new Error("Background source session differs from its controller.");
			if (activeSessionId !== request.sessionId) restoreSnapshots(request.context);
			request.accept(backgroundFlowSource);
		} catch (error) { request.reject(error); }
	});
	pi.on("session_start", (_event, ctx) => {`,
		);
	}
	if (path === paths[1]) {
		source = replace(
			source,
			"const liveSnapshots = new Map<string, BackgroundTaskSnapshot>();",
			'import { createBackgroundFlowSource } from "./jouzu-flow.js";\n\nconst liveSnapshots = new Map<string, BackgroundTaskSnapshot>();\nexport const backgroundFlowSource = createBackgroundFlowSource(() => liveSnapshots.values());',
		);
		source = replace(
			source,
			"\t\tcommand: task.command,",
			"\t\tflow: task.flow ? structuredClone(task.flow) : undefined,\n\t\tcommand: task.command,",
		);
		return replace(
			source,
			"\tliveSnapshots.set(snapshot.id, snapshot);",
			"\tliveSnapshots.set(snapshot.id, snapshot);\n\tbackgroundFlowSource.publish(snapshot);",
		);
	}
	if (path === paths[2])
		return replace(
			source,
			"export interface BackgroundTaskSnapshot {",
			"export interface BackgroundTaskSnapshot {\n\tflow?: { version: 1; execution: string; scope?: { sessionId: string; branchId: string }; work?: { id: string; revision: number } };",
		);
	if (path === paths[3])
		return replace(
			source,
			'\t\tcommand: truncateField(snapshot.command, WAKE_MANIFEST_FIELD_MAX_CHARS) ?? "",',
			'\t\tflow: snapshot.flow ? structuredClone(snapshot.flow) : undefined,\n\t\tcommand: truncateField(snapshot.command, WAKE_MANIFEST_FIELD_MAX_CHARS) ?? "",',
		);
	if (path === paths[4])
		return replace(
			source,
			'\treturn { content: [{ type: "text", text }], details };',
			'\tconst task = details.task as BackgroundTaskSnapshot | undefined;\n\tif (task?.flow?.scope) text += "\\nWait dependency: " + JSON.stringify({ producer: "bg", handle: task.id, execution: task.flow.execution, until: "exit", scope: task.flow.scope, work: task.flow.work });\n\treturn { content: [{ type: "text", text }], details };',
		);
	throw new Error(`Unknown background flow path: ${path}`);
}
