export const paths = [
	"extensions/background-tasks.ts",
	"extensions/snapshot.ts",
	"extensions/types.ts",
	"extensions/wake-events.ts",
	"extensions/render.ts",
	"extensions/registrations.ts",
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
		source = replace(
			source,
			"\tconst persistSnapshots = (): { appendEntry: boolean; sidecar: boolean } =>\n\t\tpersistenceLayer.persistSnapshots();",
			`	const persistSnapshots = (): { appendEntry: boolean; sidecar: boolean; appendReason?: string } => {
		for (const task of tasks.values()) backgroundFlowSource.prepareResult(task);
		const saved = persistenceLayer.persistSnapshots();
		if (saved.sidecar || (saved.appendEntry && saved.appendReason === "appended")) backgroundFlowSource.commitResults(tasks.values());
		return saved;
	};`,
		);
		source = replace(
			source,
			"pi, getActiveCtx: () => activeCtx, getTasks: () => tasks.values(), persist: () => persistenceLayer.persistSnapshots(),",
			"pi, getActiveCtx: () => activeCtx, getTasks: () => [...tasks.values()].filter(task => !backgroundFlowSource.controls(task)), persist: persistSnapshots,",
		);
		source = replace(
			source,
			"\tregisterAll(pi, {",
			`
	registerAll(pi, {
		recordTerminalRead(task, toolCallId, toolName, result) {
			const prior = task.flow?.result?.reads;
			if (!backgroundFlowSource.recordTerminalRead(task, toolCallId, toolName, result.content)) return;
			try {
				const saved = persistSnapshots();
				if (!saved.sidecar && !(saved.appendEntry && saved.appendReason === "appended")) throw new Error("Terminal read receipt could not be persisted.");
			} catch (error) { if (task.flow?.result) task.flow.result.reads = prior; throw error; }
		},`,
		);
		return replace(
			source,
			'\tpi.on("session_start", (_event, ctx) => {',
			`
	pi.events.on("jouzu:background-flow-source", (data) => {
		const request = data as { version: number; context: ExtensionContext; sessionId: string; accept(source: typeof backgroundFlowSource & { acknowledgeResult(id: string, revision: string): void; acknowledgeObservation(id: string, revision: string): void }): void; reject(error: unknown): void };
		if (request?.version !== 1 || typeof request.accept !== "function" || typeof request.reject !== "function") return;
		try {
			if (request.context?.sessionManager.getSessionId() !== request.sessionId) throw new Error("Background source session differs from its controller.");
			if (activeSessionId !== request.sessionId) restoreSnapshots(request.context);
			request.accept({
				...backgroundFlowSource,
				acknowledgeObservation(id: string, revision: string) {
					const task = [...tasks.values()].find(task => task.flow?.result?.metadata.id === id && task.flow.result.metadata.revision === revision);
					if (!task?.flow?.result) throw new Error("Exact background result is unavailable.");
					if (task.flow.result.observed) return;
					const prior = task.exitNotified;
					task.flow.result.observed = true;
					task.exitNotified = true;
					try {
						const saved = persistSnapshots();
						if (!saved.sidecar && !(saved.appendEntry && saved.appendReason === "appended")) throw new Error("Background observation could not be persisted.");
					} catch (error) { task.flow.result.observed = undefined; task.exitNotified = prior; throw error; }
				},
				acknowledgeResult(id: string, revision: string) {
					const task = [...tasks.values()].find(task => task.flow?.result?.metadata.id === id && task.flow.result.metadata.revision === revision);
					if (!task?.flow?.result) throw new Error("Exact background result is unavailable.");
					if (task.flow.result.delivered) return;
					const prior = task.exitNotified;
					task.flow.result.delivered = true;
					task.exitNotified = true;
					try {
						const saved = persistSnapshots();
						if (!saved.sidecar && !(saved.appendEntry && saved.appendReason === "appended")) throw new Error("Background result receipt could not be persisted.");
					} catch (error) {
						task.flow.result.delivered = undefined;
						task.exitNotified = prior;
						throw error;
					}
				},
			});
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
			"export interface BackgroundTaskSnapshot {\n\tflow?: { version: 1; execution: string; scope?: { sessionId: string; branchId: string }; work?: { id: string; revision: number }; result?: import('./jouzu-flow.js').BackgroundTerminalResult };",
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
			'\tconst task = details.task as BackgroundTaskSnapshot | undefined;\n\tif (task?.flow?.scope) {\n\t\tconst dependency: Record<string, unknown> = { producer: "bg", handle: task.id, execution: task.flow.execution, until: "exit", scope: task.flow.scope, work: task.flow.work };\n\t\tif (task.status === "running" && Number.isSafeInteger(task.pid) && task.pid > 0) dependency.health = "bg-process-alive-v1";\n\t\ttext += "\\nWait dependency: " + JSON.stringify(dependency);\n\t}\n\treturn { content: [{ type: "text", text }], details };',
		);
	if (path === paths[5]) {
		source = replace(
			source,
			"export interface RegistrationDeps {",
			"export interface RegistrationDeps {\n\trecordTerminalRead?(task: ManagedTask, toolCallId: string, toolName: string, result: AgentToolResult<unknown>): void;",
		);
		source = replace(
			source,
			"function taskLogResult(deps: RegistrationDeps, task: ManagedTask):",
			"function taskLogResult(deps: RegistrationDeps, task: ManagedTask, toolCallId: string, toolName: string):",
		);
		source = replace(
			source,
			"return makeToolResult(`${terminalSummary(task)}\\n\\n${formatTaskLog(output, task.logFile, cwd)}`, {",
			"const result = makeToolResult(`${terminalSummary(task)}\\n\\n${formatTaskLog(output, task.logFile, cwd)}`, {",
		);
		source = replace(
			source,
			"\t});\n}\n\nfunction registerTools",
			"\t});\n\tdeps.recordTerminalRead?.(task, toolCallId, toolName, result);\n\treturn result;\n}\n\nfunction registerTools",
		);
		const read = 'if (params.action === "log") return taskLogResult(deps, task);';
		if (source.split(read).length !== 3) throw new Error("Background log tool anchors changed.");
		source = source.replace(
			read,
			'if (params.action === "log") return taskLogResult(deps, task, _toolCallId, "bg_status");',
		);
		return source.replace(
			read,
			'if (params.action === "log") return taskLogResult(deps, task, _toolCallId, "bg_task");',
		);
	}
	throw new Error(`Unknown background flow path: ${path}`);
}
