import type { ExtensionAPI, InlineExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { attachBackgroundWaitSource, type BackgroundFlowSourceAPI } from "./background-adapter.js";
import { BackgroundResultProducer, type BackgroundResultSourceAPI } from "./background-results.js";
import type { PiFlowAttachment } from "./pi-attachment.js";
import type { PiSessionFlowIngress } from "./pi-session-ingress.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import { createFlowResultExtension } from "./result-tools.js";

/** Query the loaded task owner before restoring waits, independent of extension factory order. */
export function createBackgroundControllerExtension(options: {
	ingress?(): PiSessionFlowIngress;
	currentWork(): { id: string; revision: number } | undefined;
	onError(error: unknown): void;
}): InlineExtension & {
	attach(attachment: PiFlowAttachment, sessionManager: SessionManager): void;
} {
	let attached: PiFlowAttachment | undefined;
	let results: BackgroundResultProducer | undefined;
	let registration: ReturnType<PiSessionFlowIngress["registerProducer"]> | undefined;
	let installed: PiFlowAttachment | undefined;
	let events: ExtensionAPI["events"] | undefined;
	return {
		name: "jouzu-background-controller",
		factory(pi) {
			events = pi.events;
			const getIngress = options.ingress;
			if (getIngress) createFlowResultExtension({ attachment: () => getIngress().branch().attachment }).factory(pi);
			const install = () => {
				if (!options.ingress || !results || !attached || installed === attached) return;
				const ingress = options.ingress();
				if (ingress.branch().attachment !== attached)
					throw new FlowLedgerError("stale", "Background result branch changed.");
				registration = ingress.branch().controller.register(results, async () => ingress.requestRelease());
				installed = attached;
				ingress.requestRelease();
			};
			pi.on("session_start", async () => install());
			pi.on("session_tree", async () => install());
			pi.on("session_compact", async () => install());
		},
		attach(attachment, sessionManager) {
			if (!events) throw new FlowLedgerError("stale", "Background controller extension is not loaded.");
			const scope = attachment.ledger.scope;
			if (scope.sessionId !== sessionManager.getSessionId())
				throw new FlowLedgerError("scope", "Background source session differs from its controller.");
			let source: (BackgroundFlowSourceAPI & Partial<BackgroundResultSourceAPI>) | undefined;
			let failure: unknown;
			let accepting = true;
			events.emit("jouzu:background-flow-source", {
				version: 1,
				sessionId: scope.sessionId,
				context: { sessionManager },
				accept(candidate: BackgroundFlowSourceAPI & Partial<BackgroundResultSourceAPI>) {
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
			attached = attachment;
			registration = undefined;
			if (options.ingress) {
				if (typeof source.activateResults !== "function" || typeof source.acknowledgeResult !== "function")
					throw new FlowLedgerError("schema", "Background result delivery API is unavailable.");
				results = new BackgroundResultProducer(
					attachment,
					source as BackgroundFlowSourceAPI & BackgroundResultSourceAPI,
					() => {
						if (attached === attachment && registration) void registration.changed().catch(options.onError);
					},
				);
			}
		},
	};
}
