import { randomUUID } from "node:crypto";

type Scope = { sessionId: string; branchId: string };
type Identity = { scope: Scope; workId: string; handle: string; execution: string };
type Evidence = Identity & {
	revision: number;
	predicates: { until: string; state: "pending" | "satisfied" | "failed" | "cancelled" | "missing" }[];
};
type Snapshot = {
	id: string;
	sessionId?: string;
	status: string;
	terminationReason?: string;
	flow?: { version: 1; execution: string; scope?: Scope };
};
const sameScope = (a: Scope | undefined, b: Scope) => a?.sessionId === b.sessionId && a?.branchId === b.branchId;

/** Bind the existing task snapshot owner to Jouzu's execution subscription protocol. */
export function createBackgroundFlowSource(list: () => Iterable<Snapshot>) {
	const scopes = new Map<string, { scope: Scope }>();
	const listeners = new Set<{ identity: Identity; changed(evidence: Evidence): void; signature?: string }>();
	function evidence(task: Snapshot, identity: Identity): Evidence {
		if (
			task.sessionId !== identity.scope.sessionId ||
			!sameScope(task.flow?.scope, identity.scope) ||
			task.id !== identity.handle ||
			task.flow?.execution !== identity.execution ||
			task.flow.version !== 1
		)
			throw new Error("Background execution does not belong to this session and branch.");
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
		newExecution(sessionId: string | null) {
			const scope = sessionId ? scopes.get(sessionId)?.scope : undefined;
			return { version: 1 as const, execution: randomUUID(), ...(scope ? { scope: { ...scope } } : {}) };
		},
		publish(task: Snapshot) {
			for (const listener of listeners) {
				if (
					!sameScope(task.flow?.scope, listener.identity.scope) ||
					task.id !== listener.identity.handle ||
					task.flow?.execution !== listener.identity.execution
				)
					continue;
				const current = evidence(task, listener.identity),
					signature = JSON.stringify(current);
				if (signature === listener.signature) continue;
				listener.signature = signature;
				listener.changed(current);
			}
		},
		activate(scope: Scope) {
			if (
				![scope.sessionId, scope.branchId].every(
					(value) => typeof value === "string" && value.length > 0 && value.length <= 512,
				)
			)
				throw new Error("Invalid background flow scope.");
			if (scopes.has(scope.sessionId)) throw new Error("Background flow session already has an active branch.");
			const lease = { scope: { ...scope } };
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
					if (scopes.get(lease.scope.sessionId) === lease) scopes.delete(lease.scope.sessionId);
				},
			};
		},
	};
}
