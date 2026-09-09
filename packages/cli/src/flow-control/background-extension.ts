import type { ExtensionAPI, InlineExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { attachBackgroundWaitSource, type BackgroundFlowSourceAPI } from "./background-adapter.js";
import type { PiFlowAttachment } from "./pi-attachment.js";
import { FlowLedgerError } from "./receipt-ledger.js";

/** Query the loaded task owner before restoring waits, independent of extension factory order. */
export function createBackgroundControllerExtension(options: {
	currentWork(): { id: string; revision: number } | undefined;
	onError(error: unknown): void;
}): InlineExtension & {
	attach(attachment: PiFlowAttachment, sessionManager: SessionManager): void;
} {
	let events: ExtensionAPI["events"] | undefined;
	return {
		name: "jouzu-background-controller",
		factory(pi) {
			events = pi.events;
		},
		attach(attachment, sessionManager) {
			if (!events) throw new FlowLedgerError("stale", "Background controller extension is not loaded.");
			const scope = attachment.ledger.scope;
			if (scope.sessionId !== sessionManager.getSessionId())
				throw new FlowLedgerError("scope", "Background source session differs from its controller.");
			let source: BackgroundFlowSourceAPI | undefined;
			let failure: unknown;
			let accepting = true;
			events.emit("jouzu:background-flow-source", {
				version: 1,
				sessionId: scope.sessionId,
				context: { sessionManager },
				accept(candidate: BackgroundFlowSourceAPI) {
					if (!accepting || source)
						throw new FlowLedgerError("identity", "Background source handshake is closed or repeated.");
					source = candidate;
				},
				reject(error: unknown) {
					failure = error;
				},
			});
			accepting = false;
			if (failure) throw failure;
			if (!source) throw new FlowLedgerError("identity", "Loaded background execution source is unavailable.");
			attachBackgroundWaitSource(attachment, source, options.onError, options.currentWork);
		},
	};
}
