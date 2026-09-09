import { createHash, randomUUID } from "node:crypto";

type Scope = { sessionId: string; branchId: string };
type Work = { id: string; revision: number };
type Identity = { scope: Scope; workId: string; handle: string; execution: string };
type Evidence = Identity & {
	revision: number;
	predicates: { until: string; state: "pending" | "satisfied" | "failed" | "cancelled" | "missing" }[];
};
export interface BackgroundTerminalResult {
	metadata: { id: string; producer: string; execution: string; revision: string; status: "success" | "failure" | "cancelled"; title: string; reference: string; warnings: string[] };
	delivered?: boolean;
	observed?: boolean;
	notify?: boolean;
	reads?: { id: string; revision: string; toolCallId: string; toolName: string; contentHash: string }[];
}
type Snapshot = {
	id: string;
	sessionId?: string;
	status: string;
	terminationReason?: string;
	title?: string;
	command?: string;
	logFile?: string;
	exitCode?: number | null;
	notifyOnExit?: boolean;
	exitNotified?: boolean;
	flow?: { version: 1; execution: string; scope?: Scope; work?: Work; result?: BackgroundTerminalResult };
};
const sameScope = (a: Scope | undefined, b: Scope) => a?.sessionId === b.sessionId && a?.branchId === b.branchId;

/** Bind the existing task snapshot owner to Jouzu's execution subscription protocol. */
export function createBackgroundFlowSource(list: () => Iterable<Snapshot>) {
	const scopes = new Map<string, { scope: Scope; currentWork(): Work }>();
	const deliveries = new Map<string, { scope: Scope; changed(): void }>();
	const results = new Map<string, { scope: Scope; work?: Work; result: BackgroundTerminalResult }>();
	const listeners = new Set<{ identity: Identity; changed(evidence: Evidence): void; signature?: string }>();
	function evidence(task: Snapshot, identity: Identity): Evidence {
		if (
			task.sessionId !== identity.scope.sessionId ||
			!sameScope(task.flow?.scope, identity.scope) ||
			task.id !== identity.handle ||
			task.flow?.execution !== identity.execution ||
			task.flow.version !== 1 ||
			task.flow.work?.id !== identity.workId
		)
			throw new Error("Background execution does not belong to this session, branch, and work.");
		const state =
			task.status === "running"
				? "pending"
				: task.status === "completed"
					? "satisfied"
					: task.status === "failed" || task.status === "timed_out"
						? "failed"
						: task.status === "stopped"
							? ["extension-stop", "session-shutdown"].includes(task.terminationReason ?? "")
								? "cancelled"
								: "missing"
							: undefined;
		if (!state) throw new Error("Background execution has an unsupported status.");
		return {
			...structuredClone(identity),
			revision: state === "pending" ? 1 : 2,
			predicates: [{ until: "exit", state }],
		};
	}
	return {
		controls(task: Snapshot): boolean {
			return !!task.flow?.result || !!(task.flow?.scope && sameScope(deliveries.get(task.flow.scope.sessionId)?.scope, task.flow.scope));
		},
		prepareResult(task: Snapshot): void {
			const flow = task.flow;
			if (!flow?.scope || !flow.work || flow.result || !this.controls(task) || task.status === "running") return;
			const status = task.status === "completed" ? "success" : task.status === "stopped" ? "cancelled" : ["failed", "timed_out"].includes(task.status) ? "failure" : undefined;
			if (!status || !task.logFile) throw new Error("Terminal background result is incomplete.");
			flow.result = { notify: !!task.notifyOnExit && !task.exitNotified, metadata: {
				id: `bg-result:${flow.execution}`, producer: "bg", execution: flow.execution, revision: "1", status,
				title: `${(task.title || task.command || task.id).slice(0, 512)}: ${task.status} (exit ${task.exitCode ?? "unknown"})`,
				reference: task.logFile, warnings: [],
			} };
		},
		recordTerminalRead(task: Snapshot, toolCallId: string, toolName: string, content: unknown): boolean {
			const result = task.flow?.result;
			if (!result || result.observed || task.status === "running" || !task.flow?.scope || !sameScope(deliveries.get(task.flow.scope.sessionId)?.scope, task.flow.scope)) return false;
			if (!toolCallId || toolCallId.length > 512 || !["bg_task", "bg_status"].includes(toolName)) throw new Error("Invalid terminal read identity.");
			const receipt = { id: result.metadata.id, revision: result.metadata.revision, toolCallId, toolName,
				contentHash: createHash("sha256").update(JSON.stringify(content)).digest("hex") };
			const reads = result.reads ?? [];
			const prior = reads.find(read => read.toolCallId === toolCallId);
			if (prior) {
				if (JSON.stringify(prior) !== JSON.stringify(receipt)) throw new Error("Terminal read identity changed.");
				return false;
			}
			if (reads.length >= 128) throw new Error("Terminal read receipt capacity reached.");
			result.reads = [...reads, receipt];
			return true;
		},
		commitResults(tasks: Iterable<Snapshot>): void {
			const changed = new Set<string>();
			for (const task of tasks) {
				const flow = task.flow;
				if (!flow?.scope || !flow.result) continue;
				const key = JSON.stringify([flow.scope.sessionId, flow.scope.branchId, flow.execution]);
				const value = { scope: flow.scope, work: flow.work, result: flow.result };
				if (JSON.stringify(results.get(key)) === JSON.stringify(value)) continue;
				results.set(key, structuredClone(value));
				changed.add(flow.scope.sessionId);
			}
			for (const sessionId of changed) deliveries.get(sessionId)?.changed();
		},
		activateResults(scope: Scope, changed: () => void) {
			if (!sameScope(scopes.get(scope.sessionId)?.scope, scope) || deliveries.has(scope.sessionId)) throw new Error("Background result delivery requires its active wait source.");
			const lease = { scope: { ...scope }, changed };
			deliveries.set(scope.sessionId, lease);
			return {
				retainedWorkIds() {
					if (deliveries.get(scope.sessionId) !== lease) throw new Error("Background result source is detached.");
					const retained = new Set<string>();
					for (const task of list()) {
						if (!task.flow?.work || !sameScope(task.flow.scope, scope)) continue;
						const saved = results.get(JSON.stringify([scope.sessionId, scope.branchId, task.flow.execution]));
						if (task.status === "running" || !saved?.result.observed) retained.add(task.flow.work.id);
					}
					for (const saved of results.values()) if (sameScope(saved.scope, scope) && saved.work && !saved.result.observed) retained.add(saved.work.id);
					return [...retained];
				},
				readReceipts() {
					if (deliveries.get(scope.sessionId) !== lease) throw new Error("Background result source is detached.");
					return structuredClone([...results.values()].filter(value => sameScope(value.scope, scope) && !value.result.observed).flatMap(value => value.result.reads ?? []));
				},
				snapshot() {
					if (deliveries.get(scope.sessionId) !== lease) throw new Error("Background result source is detached.");
					return structuredClone([...results.values()].filter(value => sameScope(value.scope, scope) && value.result.notify !== false && !value.result.delivered && !value.result.observed).map(value => value.result.metadata));
				},
			};
		},
		newExecution(sessionId: string | null) {
			const lease = sessionId ? scopes.get(sessionId) : undefined;
			const work = lease?.currentWork();
			if (
				lease &&
				(!work ||
					typeof work.id !== "string" ||
					!work.id ||
					work.id.length > 512 ||
					!Number.isSafeInteger(work.revision) ||
					work.revision < 1)
			)
				throw new Error("Background execution requires a valid owning work revision.");
			return {
				version: 1 as const,
				execution: randomUUID(),
				...(lease && work ? { scope: { ...lease.scope }, work: { ...work } } : {}),
			};
		},
		publish(task: Snapshot) {
			for (const listener of listeners) {
				if (
					!sameScope(task.flow?.scope, listener.identity.scope) ||
					task.id !== listener.identity.handle ||
					task.flow?.execution !== listener.identity.execution ||
					task.flow.work?.id !== listener.identity.workId
				)
					continue;
				const current = evidence(task, listener.identity),
					signature = JSON.stringify(current);
				if (signature === listener.signature) continue;
				listener.signature = signature;
				listener.changed(current);
			}
		},
		activate(scope: Scope, currentWork: () => Work) {
			if (
				![scope.sessionId, scope.branchId].every(
					(value) => typeof value === "string" && value.length > 0 && value.length <= 512,
				)
			)
				throw new Error("Invalid background flow scope.");
			if (scopes.has(scope.sessionId)) throw new Error("Background flow session already has an active branch.");
			if (typeof currentWork !== "function") throw new Error("Background flow requires a current work callback.");
			const lease = { scope: { ...scope }, currentWork };
			scopes.set(scope.sessionId, lease);
			let closed = false;
			const owned = new Set<{ identity: Identity; changed(evidence: Evidence): void; signature?: string }>();
			const assertIdentity = (identity: Identity) => {
				if (closed || !sameScope(identity.scope, lease.scope))
					throw new Error("Background flow source is closed or foreign.");
			};
			return {
				version: 1 as const,
				namespace: "bg",
				subscribe(identity: Identity, changed: (evidence: Evidence) => void) {
					assertIdentity(identity);
					const listener = { identity: structuredClone(identity), changed };
					listeners.add(listener);
					owned.add(listener);
					return () => {
						listeners.delete(listener);
						owned.delete(listener);
					};
				},
				canRetireExecution(identity: Identity): boolean {
					assertIdentity(identity);
					const task = [...list()].find(task => task.id === identity.handle && task.flow?.execution === identity.execution && sameScope(task.flow.scope, identity.scope));
					if (!task || evidence(task, identity).predicates.some(predicate => predicate.state === "pending")) return false;
					const saved = results.get(JSON.stringify([scope.sessionId, scope.branchId, identity.execution]));
					return saved?.result.observed === true;
				},
				async snapshot(identity: Identity, signal: AbortSignal) {
					signal.throwIfAborted();
					assertIdentity(identity);
					const task = [...list()].find(
						(task) =>
							task.id === identity.handle &&
							task.flow?.execution === identity.execution &&
							sameScope(task.flow.scope, identity.scope),
					);
					if (!task) throw new Error("Exact background execution is unavailable; inspect the producer task.");
					return evidence(task, identity);
				},
				close() {
					closed = true;
					for (const listener of owned) listeners.delete(listener);
					owned.clear();
					if (scopes.get(lease.scope.sessionId) === lease) {
						scopes.delete(lease.scope.sessionId);
						deliveries.delete(lease.scope.sessionId);
					}
				},
			};
		},
	};
}
