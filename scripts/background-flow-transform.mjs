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
			'import { spawn, spawnSync } from "node:child_process";\nimport { backgroundFlowSource } from "./snapshot.js";\nimport { BG_CANONICAL_STORE_MARKER_TYPE, canonicalMarkerData, canonicalStorePath, createCanonicalBackgroundStore } from "./jouzu-store.js";\nimport type { CanonicalStoreDiagnostic } from "./jouzu-store.js";',
		);
		source = replace(
			source,
			"\t\t\t\tprocess.kill(task.pid, signal);",
			`				// A Windows shell can own children that retain pipes and the working directory.
				// Stop the tree before its root disappears, for both stop and session shutdown.
				process.kill(task.pid, 0);
				const stopped = spawnSync("taskkill.exe", ["/PID", String(task.pid), "/T", "/F"], {
					windowsHide: true, encoding: "utf8", timeout: 10000,
				});
				if (stopped.error) throw stopped.error;
				if (stopped.status !== 0) throw new Error(stopped.stderr || "Windows process-tree termination failed.");`,
		);
		source = replace(
			source,
			"\t\tconst child = spawn(spawnPlan.file, spawnPlan.args, {",
			"\t\tconst flow = backgroundFlowSource.newExecution(activeSessionId);\n\t\tconst child = spawn(spawnPlan.file, spawnPlan.args, {",
		);
		source = replace(source, "\t\tconst task: ManagedTask = {\n", "\t\tconst task: ManagedTask = {\n\t\t\tflow,\n");
		source = replace(
			source,
			"\tlet taskCounter = 0;\n\tlet shuttingDown = false;",
			"\tlet taskCounter = 0;\n\tconst wakeDiagnostics: CanonicalStoreDiagnostic[] = [];\n\tlet shuttingDown = false;",
		);
		source = replace(
			source,
			`	const persistenceLayer = createPersistence({
		pi,
		customType: BG_STATE_TYPE,
		getActiveCtx: () => activeCtx,
		listSnapshots: () => sortedTasks().map((task) => rememberSnapshot(task)),
		notify: (where) => activeCtx?.ui.notify?.(
			\`Background task state persistence failed (\${where}). Recent task transitions may not survive a restart.\`,
			"warning",
		),
	});`,
			`	const canonical = createCanonicalBackgroundStore({
		sessionId: () => activeSessionId,
		storePath: (context) => {
			const target = (context ?? activeCtx) as ExtensionContext | null | undefined;
			if (!target) return undefined;
			try {
				return canonicalStorePath(sidecarStatePath(target));
			} catch (error) {
				// A terminal callback may race session replacement. The old context is
				// stale and must not be used to write into the new session's store.
				if (error instanceof Error && /stale|session replacement|reload/i.test(error.message)) return undefined;
				throw error;
			}
		},
		tasks: () => sortedTasks().map((task) => rememberSnapshot(task)),
		results: () => backgroundFlowSource.snapshotResults(tasks.values()),
		nextTaskId: () => taskCounter,
		diagnostics: () => wakeDiagnostics,
		prepareResults: () => { for (const task of tasks.values()) backgroundFlowSource.prepareResult(task); },
		commitResults: () => backgroundFlowSource.commitResults(tasks.values()),
		applyTask: (snapshot) => rememberRestoredSnapshot(snapshot),
		setNextTaskId: (value) => { taskCounter = Math.max(taskCounter, value); },
		restoreResults: (records) => backgroundFlowSource.restoreResults(records),
		markerPresent: (context) => {
			const target = (context ?? activeCtx) as ExtensionContext | null | undefined;
			return !!target && target.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === BG_CANONICAL_STORE_MARKER_TYPE);
		},
		appendMarker: (context) => {
			if ((!context && !activeCtx) || !activeSessionId) return;
			pi.appendEntry(BG_CANONICAL_STORE_MARKER_TYPE, canonicalMarkerData(activeSessionId));
		},
		reportProblem: (where, message) => activeCtx?.ui.notify?.(\`Background task state persistence failed (\${where}): \${message}\`, "warning"),
	});`,
		);
		source = replace(
			source,
			"\tconst persistSnapshots = (): { appendEntry: boolean; sidecar: boolean } =>\n\t\tpersistenceLayer.persistSnapshots();",
			'\tconst persistSnapshots = (mode: "force" | "progress" = "force"): { appendEntry: boolean; sidecar: boolean; appendReason?: string } =>\n\t\tcanonical.persist(mode);',
		);
		source = replace(
			source,
			"\tconst restoreSnapshots = (ctx: ExtensionContext) => {\n\t\ttasks.clear();\n\t\ttaskCounter = 0;\n\t\tactiveSessionId = sessionIdForContext(ctx);\n\t\tlet sidecarLoaded = false;",
			"\tconst restoreLegacySnapshots = (ctx: ExtensionContext): boolean => {\n\t\ttasks.clear();\n\t\ttaskCounter = 0;\n\t\tactiveSessionId = sessionIdForContext(ctx);\n\t\tlet legacyFound = false;\n\t\tlet sidecarLoaded = false;",
		);
		source = replace(
			source,
			'\t\t\tif (existsSync(file)) {\n\t\t\t\tconst data = JSON.parse(readFileSync(file, "utf8")) as { tasks?: unknown; updatedAt?: number };',
			'\t\t\tif (existsSync(file)) {\n\t\t\t\tlegacyFound = true;\n\t\t\t\tconst data = JSON.parse(readFileSync(file, "utf8")) as { tasks?: unknown; updatedAt?: number };',
		);
		source = replace(
			source,
			'\t\t\tif (entry.type === "custom" && entry.customType === BG_STATE_TYPE) {\n\t\t\t\tapplyCustomEntryWithBarrier({',
			'\t\t\tif (entry.type === "custom" && entry.customType === BG_STATE_TYPE) {\n\t\t\t\tlegacyFound = true;\n\t\t\t\tapplyCustomEntryWithBarrier({',
		);
		source = replace(
			source,
			'\t\t\tif (entry.type === "message" && entry.message.role === "toolResult" && (entry.message.toolName === "bg_task" || entry.message.toolName === "bg_status")) {\n\t\t\t\tconst details = entry.message.details as { task?: unknown; tasks?: unknown } | undefined;',
			'\t\t\tif (entry.type === "message" && entry.message.role === "toolResult" && (entry.message.toolName === "bg_task" || entry.message.toolName === "bg_status")) {\n\t\t\t\tlegacyFound = true;\n\t\t\t\tconst details = entry.message.details as { task?: unknown; tasks?: unknown } | undefined;',
		);
		source = replace(
			source,
			"\t\tif (tasks.size > 0) persistSnapshots();\n\t};",
			`		return legacyFound;
	};

	const restoreSnapshots = (ctx: ExtensionContext) => {
		tasks.clear();
		taskCounter = 0;
		activeSessionId = sessionIdForContext(ctx);
		if (canonical.restoreFromStore(ctx)) return;
		if (restoreLegacySnapshots(ctx)) canonical.adopt(ctx);
	};`,
		);
		source = replace(
			source,
			'\tconst logWakeDiagnostic = (diagnostic: WakeDiagnostic) => {\n\t\tlogBackgroundDiagnostic("wake diagnostic", diagnostic);\n\t};',
			`	const logWakeDiagnostic = (diagnostic: WakeDiagnostic) => {
		logBackgroundDiagnostic("wake diagnostic", diagnostic);
		wakeDiagnostics.push({
			at: diagnostic.timestamp ?? Date.now(),
			message: "wake diagnostic",
			...(diagnostic.reason ? { reason: diagnostic.reason } : {}),
			...(diagnostic.taskId ? { taskId: diagnostic.taskId } : {}),
		});
		if (wakeDiagnostics.length > 100) wakeDiagnostics.splice(0, wakeDiagnostics.length - 100);
	};`,
		);
		source = replace(
			source,
			"\t\trememberSnapshot(task);\n\t\tpersistSnapshots();\n\t};\n\n\tconst wakeBudgetLimits",
			'\t\trememberSnapshot(task);\n\t\tpersistSnapshots("progress");\n\t};\n\n\tconst wakeBudgetLimits',
		);
		source = replace(
			source,
			"\t\tif (announced) {\n\t\t\trememberSnapshot(task);\n\t\t\tpersistSnapshots();\n\t\t}",
			'\t\tif (announced) {\n\t\t\trememberSnapshot(task);\n\t\t\tpersistSnapshots("progress");\n\t\t}',
		);
		source = replace(
			source,
			"\t\trememberSnapshot(task);\n\t\tpersistSnapshots();\n\t\treturn sent;",
			'\t\trememberSnapshot(task);\n\t\tpersistSnapshots("progress");\n\t\treturn sent;',
		);
		source = replace(
			source,
			"\t\tconst id = `bg-${++taskCounter}`;\n\t\tconst now = Date.now();",
			"\t\tconst id = `bg-${++taskCounter}`;\n\t\t// Reserve the allocation before the external spawn so a crash cannot reuse the id.\n\t\tpersistSnapshots();\n\t\tconst now = Date.now();",
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
					if (!backgroundFlowSource.setResultReceipt(id, revision, "observed", true)) return;
					const task = [...tasks.values()].find(task => task.flow?.result?.metadata.id === id && task.flow.result.metadata.revision === revision);
					const prior = task?.exitNotified;
					if (task?.flow?.result) { task.flow.result.observed = true; task.exitNotified = true; }
					try {
						const saved = persistSnapshots();
						if (!saved.sidecar && !(saved.appendEntry && saved.appendReason === "appended")) throw new Error("Background observation could not be persisted.");
					} catch (error) {
						backgroundFlowSource.setResultReceipt(id, revision, "observed", undefined);
						if (task?.flow?.result) { task.flow.result.observed = undefined; task.exitNotified = prior; }
						throw error;
					}
				},
				acknowledgeResult(id: string, revision: string) {
					if (!backgroundFlowSource.setResultReceipt(id, revision, "delivered", true)) return;
					const task = [...tasks.values()].find(task => task.flow?.result?.metadata.id === id && task.flow.result.metadata.revision === revision);
					const prior = task?.exitNotified;
					if (task?.flow?.result) { task.flow.result.delivered = true; task.exitNotified = true; }
					try {
						const saved = persistSnapshots();
						if (!saved.sidecar && !(saved.appendEntry && saved.appendReason === "appended")) throw new Error("Background result receipt could not be persisted.");
					} catch (error) {
						backgroundFlowSource.setResultReceipt(id, revision, "delivered", undefined);
						if (task?.flow?.result) { task.flow.result.delivered = undefined; task.exitNotified = prior; }
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
			'import { bgToolResultTasks } from "./tool-result-details.js";',
			'import { boundedPresentationTasks } from "./jouzu-store.js";',
		);
		const toolResultTasks = "tasks: bgToolResultTasks(tasks)";
		if (source.split(toolResultTasks).length !== 3) throw new Error("Background tool result task anchors changed.");
		source = source.replaceAll(toolResultTasks, "tasks: boundedPresentationTasks(tasks)");
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
