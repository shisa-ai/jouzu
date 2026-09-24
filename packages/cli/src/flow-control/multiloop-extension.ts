import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { MultiloopFlowProducer, type MultiloopLane, multiloopWorkBinding } from "./multiloop-producer.js";
import type { PiSessionFlowIngress } from "./pi-session-ingress.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowAuthorityWork } from "./wait-authority.js";

export interface MultiloopControllerOptions {
	ingress(): PiSessionFlowIngress;
	/** Flow control is on. Absent means on, so a host without the switch keeps its live producer. */
	enabled?(): boolean;
	work?(lane: MultiloopLane): Promise<FlowAuthorityWork | undefined>;
	waitingWork?(lane: MultiloopLane): string | undefined;
	onError(error: unknown): void;
}
/** Bind the actual loaded multiloop instance to this session's controller using Pi's event bus. */
export function createMultiloopControllerExtension(options: MultiloopControllerOptions): InlineExtension & {
	consumedAttempt: MultiloopFlowProducer["admitted"];
	unboundLanes: MultiloopFlowProducer["unboundLanes"];
} {
	let producer: MultiloopFlowProducer | undefined;
	let unregister: (() => void) | undefined;
	let unsubscribeBus: (() => void) | undefined;
	let unsubscribeGateChanges: (() => void) | undefined;
	const close = () => {
		unsubscribeGateChanges?.();
		unsubscribeGateChanges = undefined;
		unregister?.();
		unregister = undefined;
		producer?.close();
		producer = undefined;
	};
	return {
		name: "jouzu-multiloop-controller",
		unboundLanes() {
			return producer?.unboundLanes() ?? [];
		},
		consumedAttempt(attempt) {
			if (!producer && attempt.admission?.choice.intent.producer === "multiloop")
				throw new FlowLedgerError("stale", "Multiloop accounting attachment is unavailable.");
			producer?.admitted(attempt);
		},
		factory(pi) {
			unsubscribeBus?.();
			unsubscribeBus = pi.events.on("jouzu:multiloop-flow", (data) => {
				const request = data as {
					version: number;
					sessionId: string;
					accept(host: unknown): void;
					reject(error: unknown): void;
				};
				if (request?.version !== 1 || typeof request.accept !== "function" || typeof request.reject !== "function")
					return;
				try {
					const ingress = options.ingress(),
						branch = ingress.branch();
					if (request.sessionId !== branch.scope.sessionId)
						throw new FlowLedgerError("scope", "Multiloop attachment belongs to another session.");
					close();
					let registration: ReturnType<typeof branch.controller.register>;
					const assertBranch = () => {
						if (ingress.branch() !== branch) throw new FlowLedgerError("stale", "Multiloop branch attachment changed.");
					};
					const next = new MultiloopFlowProducer(
						branch.attachment,
						async (lane) => {
							assertBranch();
							const work = options.work
								? await options.work(lane)
								: branch.attachment.waits.boundWork(multiloopWorkBinding(lane));
							assertBranch();
							return work;
						},
						(lane) => {
							assertBranch();
							return options.waitingWork
								? options.waitingWork(lane)
								: branch.attachment.waits.boundWork(multiloopWorkBinding(lane))?.id;
						},
						() => {
							assertBranch();
							// A lane the extension reports while its work already waits is observed here, so the
							// clear that follows is still a transition the listeners hear about.
							refreshGates();
							void registration.changed().catch(options.onError);
						},
					);
					registration = branch.controller.register(next, async () => {
						ingress.requestRelease();
					});
					producer = next;
					unregister = () => registration.dispose();
					const gateListeners = new Set<(lane: MultiloopLane) => void>();
					const observedGates = new Map<string, boolean>();
					// A lane whose gate clears while nothing is retained has no release coming, so the
					// loaded extension is the only thing left that can drive it again.
					const refreshGates = () => {
						const known = new Set<string>();
						for (const lane of next.lanes()) {
							const id = JSON.stringify([lane.lane, lane.runTag]);
							known.add(id);
							const waiting = next.waiting(lane);
							const was = observedGates.get(id);
							observedGates.set(id, waiting);
							if (was !== true || waiting || next.retained(lane)) continue;
							for (const listener of gateListeners) listener(lane);
						}
						for (const id of observedGates.keys()) if (!known.has(id)) observedGates.delete(id);
					};
					const stopWaits = branch.attachment.waits.onChanged(refreshGates, options.onError);
					const stopProducers = branch.attachment.waitProducers.onChanged(refreshGates, options.onError);
					unsubscribeGateChanges = () => {
						stopWaits();
						stopProducers();
						gateListeners.clear();
						observedGates.clear();
					};
					refreshGates();
					request.accept({
						version: 1,
						submit: next.submit.bind(next),
						waiting: next.waiting.bind(next),
						retained: next.retained.bind(next),
						onGateChange(listener: (lane: MultiloopLane) => void) {
							gateListeners.add(listener);
							return () => {
								gateListeners.delete(listener);
							};
						},
						changed: next.lanesChanged.bind(next),
						// With flow control off, lanes report and continue through multiloop's own paths.
						live: () => options.enabled?.() !== false,
						async transition(lane: MultiloopLane, status: "active" | "paused" | "stopped" | "completed") {
							assertBranch();
							// This adapter owns the producer-specific policy: lanes map to owner-scoped
							// bindings, and a live campaign shares its work with the background producer.
							if (status === "active") {
								const work = await branch.attachment.waits.activateWorkBinding(multiloopWorkBinding(lane), Date.now(), [
									"bg",
									"subagent",
									"schedule",
									"tasks",
								]);
								assertBranch();
								await branch.workContext?.selectToolWork({ id: work.id, actor: "multiloop", revision: work.revision });
							} else {
								const work = branch.attachment.waits.boundWork(multiloopWorkBinding(lane));
								if (work)
									await branch.attachment.waits.changeWork(
										work.id,
										work.owner,
										work.revision,
										status,
										`Lane ${status}`,
										Date.now(),
									);
							}
							assertBranch();
						},
					});
				} catch (error) {
					close();
					request.reject(error);
				}
			});
			pi.on("session_shutdown", async () => close());
		},
	};
}
