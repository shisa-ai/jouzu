import type { ExtensionAPI, InlineExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { attachBackgroundWaitSource, type BackgroundFlowSourceAPI } from "./background-adapter.js";
import { BackgroundResultProducer, type BackgroundResultSourceAPI } from "./background-results.js";
import type { SessionFlowController } from "./controller.js";
import type { PiFlowAttachment } from "./pi-attachment.js";
import type { PiSessionFlowIngress } from "./pi-session-ingress.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import { createFlowResultExtension } from "./result-tools.js";

/** Query the loaded task owner before restoring waits, independent of extension factory order. */
export function createBackgroundControllerExtension(options: {
	ingress?(): PiSessionFlowIngress;
	enabled?(): boolean;
	currentWork(): { id: string; revision: number } | undefined;
	onError(error: unknown): void;
}): InlineExtension & {
	attach(attachment: PiFlowAttachment, sessionManager: SessionManager): "attached" | "unavailable";
	/** Register the current producer on the branch's controller; safe to call again after `detach`. */
	install(): void;
	/** Release the delivery lease so the task extension delivers its own completion batches. */
	detach(): Promise<void>;
} {
	let attached: PiFlowAttachment | undefined;
	let results: BackgroundResultProducer | undefined;
	let registration: ReturnType<PiSessionFlowIngress["registerProducer"]> | undefined;
	let controller: SessionFlowController | undefined;
	let installed: PiFlowAttachment | undefined;
	let waitRegistration: ReturnType<typeof attachBackgroundWaitSource> | undefined;
	let events: ExtensionAPI["events"] | undefined;
	const install = () => {
		if (!options.ingress || !results || !attached || installed === attached) return;
		const ingress = options.ingress();
		if (ingress.branch().attachment !== attached)
			throw new FlowLedgerError("stale", "Background result branch changed.");
		controller = ingress.branch().controller;
		registration = controller.register(results, async () => ingress.requestRelease());
		installed = attached;
		ingress.requestRelease();
	};
	return {
		name: "jouzu-background-controller",
		factory(pi) {
			events = pi.events;
			const getIngress = options.ingress;
			if (getIngress)
				createFlowResultExtension({
					attachment: () => getIngress().branch().attachment,
					enabled: options.enabled ?? (() => true),
				}).factory(pi);
			pi.on("session_start", async () => install());
			pi.on("session_tree", async () => install());
			pi.on("session_compact", async () => install());
		},
		install,
		async detach() {
			// Closing the wait registration closes the source, which is what releases the extension's
			// delivery lease: `controls()` then answers false and its own completion batch runs. The
			// controller registration has to go too, or the next attach finds its namespace taken.
			const current = waitRegistration;
			const producer = registration;
			waitRegistration = undefined;
			registration = undefined;
			installed = undefined;
			attached = undefined;
			controller = undefined;
			results = undefined;
			producer?.dispose();
			await current?.close();
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
			// A rejected handshake is a real failure; no responder means the task extension is not loaded,
			// which leaves background waits unavailable rather than blocking session creation.
			if (failure) throw failure;
			if (!source) return "unavailable";
			waitRegistration = attachBackgroundWaitSource(attachment, source, options.onError, options.currentWork);
			attached = attachment;
			registration = undefined;
			controller = undefined;
			if (options.ingress) {
				if (typeof source.activateResults !== "function" || typeof source.acknowledgeResult !== "function")
					throw new FlowLedgerError("schema", "Background result delivery API is unavailable.");
				results = new BackgroundResultProducer(
					attachment,
					source as BackgroundFlowSourceAPI & BackgroundResultSourceAPI,
					() => {
						if (attached !== attachment || !registration || !controller) return;
						const owner = controller;
						const current = registration;
						const report = (error: unknown) => {
							if (attached === attachment && registration === current && owner.view().state !== "closed")
								options.onError(error);
						};
						// Child exit callbacks can arrive while the controller is closed but its source is draining.
						if (owner.view().state === "closed") return;
						try {
							void current.changed().catch(report);
						} catch (error) {
							report(error);
						}
					},
				);
			}
			return "attached";
		},
	};
}
