import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { MultiloopFlowProducer, type MultiloopLane, multiloopWorkBinding } from "./multiloop-producer.js";
import type { PiSessionFlowIngress } from "./pi-session-ingress.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowAuthorityWork } from "./wait-authority.js";

export interface MultiloopControllerOptions {
	ingress(): PiSessionFlowIngress;
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
	const close = () => {
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
							void registration.changed().catch(options.onError);
						},
					);
					registration = branch.controller.register(next, async () => {
						ingress.requestRelease();
					});
					producer = next;
					unregister = () => registration.dispose();
					request.accept({
						version: 1,
						submit: next.submit.bind(next),
						waiting: next.waiting.bind(next),
						changed: next.lanesChanged.bind(next),
						async transition(lane: MultiloopLane, status: "active" | "paused" | "stopped" | "completed") {
							assertBranch();
							// This adapter owns the producer-specific policy: lanes map to owner-scoped
							// bindings, and a live campaign shares its work with the background producer.
							if (status === "active") {
								const work = await branch.attachment.waits.activateWorkBinding(multiloopWorkBinding(lane), Date.now(), [
									"bg",
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
