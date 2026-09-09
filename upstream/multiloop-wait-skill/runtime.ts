export interface FlowLane {
	lane: string;
	runTag: string;
}
export interface FlowContinuation {
	lane: FlowLane;
	reason: string;
	/** Read current lane state only after controller selection. */
	build(): string;
	/** Called at native admission, never when a blocked intent is submitted. */
	admitted(): void;
}
export interface MultiloopFlowHost {
	version: 1;
	submit(continuation: FlowContinuation): void;
	waiting(lane: FlowLane): boolean;
	changed(lanes: FlowLane[]): void;
}

const hosts = new Map<string, MultiloopFlowHost>();

/** The launcher and extension must load this API from the same package instance. */
export function attachMultiloopFlow(sessionId: string, host: MultiloopFlowHost): () => void {
	if (!sessionId || hosts.has(sessionId)) throw new Error("Multiloop flow session is missing or already attached.");
	if (host.version !== 1 || [host.submit, host.waiting, host.changed].some((fn) => typeof fn !== "function"))
		throw new Error("Invalid multiloop flow host.");
	const captured = Object.freeze({
		version: 1 as const,
		submit: host.submit.bind(host),
		waiting: host.waiting.bind(host),
		changed: host.changed.bind(host),
	});
	hosts.set(sessionId, captured);
	return () => {
		if (hosts.get(sessionId) === captured) hosts.delete(sessionId);
	};
}

export function multiloopFlow(sessionId: string): MultiloopFlowHost | undefined {
	return hosts.get(sessionId);
}
