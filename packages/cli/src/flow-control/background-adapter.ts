import type { PiFlowAttachment } from "./pi-attachment.js";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";
import type { FlowWaitExecutionSource } from "./wait-producers.js";

export interface BackgroundFlowSourceAPI {
	activate(scope: FlowScope): FlowWaitExecutionSource & { close(): void };
}

/** The caller loads this API from the same pinned package instance as the background extension. */
export function attachBackgroundWaitSource(
	attachment: PiFlowAttachment,
	api: BackgroundFlowSourceAPI,
	onError: (error: unknown) => void,
) {
	if (!api || typeof api.activate !== "function")
		throw new FlowLedgerError("schema", "Background flow source is unavailable.");
	const source = api.activate({ ...attachment.ledger.scope });
	try {
		return attachment.waitProducers.register(source, onError);
	} catch (error) {
		source.close();
		throw error;
	}
}
