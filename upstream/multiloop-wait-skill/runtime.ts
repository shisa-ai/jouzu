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
	transition?(lane: FlowLane, status: "active" | "paused" | "stopped" | "completed"): Promise<void>;
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
		transition: host.transition?.bind(host),
	});
	hosts.set(sessionId, captured);
	return () => {
		if (hosts.get(sessionId) === captured) hosts.delete(sessionId);
	};
}

export function multiloopFlow(sessionId: string): MultiloopFlowHost | undefined {
	return hosts.get(sessionId);
}

/** Exchange a host through Pi's event bus so the loaded extension supplies its own module instance. */
export function connectMultiloopFlow(events: { emit(channel: string, data: unknown): void }, sessionId: string): () => void {
	let detach: (() => void) | undefined;
	let failure: unknown;
	let accepting = true;
	events.emit("jouzu:multiloop-flow", {
		version: 1,
		sessionId,
		accept(host: MultiloopFlowHost) {
			if (!accepting || detach) throw new Error("Multiloop host handshake is closed or already accepted.");
			detach = attachMultiloopFlow(sessionId, host);
		},
		reject(error: unknown) { failure = error; },
	});
	accepting = false;
	if (failure) { detach?.(); throw failure; }
	return () => detach?.();
}
