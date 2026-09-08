import type { PiFlowAttachment } from "./pi-attachment.js";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";
import type { FlowWaitExecutionSource } from "./wait-producers.js";

export interface BackgroundFlowSourceAPI {
	activate(
		scope: FlowScope,
		currentWork: () => { id: string; revision: number },
	): FlowWaitExecutionSource & { close(): void };
}

/** The caller loads this API from the same pinned package instance as the background extension. */
export function attachBackgroundWaitSource(
	attachment: PiFlowAttachment,
	api: BackgroundFlowSourceAPI,
	onError: (error: unknown) => void,
	currentWork: () => { id: string; revision: number } | undefined,
) {
	if (!api || typeof api.activate !== "function" || typeof currentWork !== "function")
		throw new FlowLedgerError("schema", "Background flow source is unavailable.");
	const source = api.activate({ ...attachment.ledger.scope }, () => {
		const work = currentWork();
		if (!work) throw new FlowLedgerError("identity", "Background execution requires current owning work.");
		return attachment.waits.captureExecutionWork(work.id, work.revision, "bg");
	});
	try {
		return attachment.waitProducers.register(source, onError);
	} catch (error) {
		source.close();
		throw error;
	}
}
