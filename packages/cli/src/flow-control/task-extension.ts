import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { PiSessionFlowIngress } from "./pi-session-ingress.js";
import { type FlowAttempt, FlowLedgerError } from "./receipt-ledger.js";
import { installTaskContextGuard } from "./task-context-guard.js";
import { type FlowTask, TaskFlowProducer, taskWorkBinding } from "./task-producer.js";

export function createTaskControllerExtension(options: {
	ingress(): PiSessionFlowIngress;
	/** Flow control is on. Absent means on, so a host without the switch keeps its live producer. */
	enabled?(): boolean;
	onError(error: unknown): void;
}): InlineExtension & {
	consumedAttempt(attempt: FlowAttempt): void;
	unboundTasks(): FlowTask[];
	inventory(): FlowTask[];
} {
	let producer: TaskFlowProducer | undefined;
	let closeRegistration: (() => void) | undefined;
	let unsubscribe: (() => void) | undefined;
	const close = () => {
		closeRegistration?.();
		closeRegistration = undefined;
		producer?.close();
		producer = undefined;
	};
	return {
		name: "jouzu-task-controller",
		inventory() {
			return producer?.inventory() ?? [];
		},
		unboundTasks() {
			return producer?.unboundTasks() ?? [];
		},
		consumedAttempt(attempt) {
			if (attempt.admission?.choice.intent.producer !== "tasks") return;
			if (!producer) throw new FlowLedgerError("stale", "Task accounting attachment is unavailable.");
			producer.admitted(attempt);
		},
		factory(pi) {
			installTaskContextGuard(pi, {
				async activeAttempt() {
					const state = await options.ingress().branch().attachment.ledger.snapshot();
					return state.attempts.find((attempt) => attempt.id === state.activeAttemptId);
				},
				valid: (attempt) => producer?.validAttempt(attempt) ?? Promise.resolve(false),
				onError: options.onError,
			});
			unsubscribe?.();
			unsubscribe = pi.events.on("jouzu:task-flow", (data) => {
				const request = data as {
					version: number;
					sessionId: string;
					read(): FlowTask[];
					accept(host: unknown): void;
					reject(error: unknown): void;
				};
				if (
					request?.version !== 1 ||
					[request.read, request.accept, request.reject].some((fn) => typeof fn !== "function")
				)
					return;
				try {
					const ingress = options.ingress(),
						branch = ingress.branch();
					if (request.sessionId !== branch.scope.sessionId)
						throw new FlowLedgerError("scope", "Task attachment belongs to another session.");
					close();
					let registration: ReturnType<typeof branch.controller.register>;
					let active = true;
					const assertActive = () => {
						if (!active || ingress.branch() !== branch)
							throw new FlowLedgerError("stale", "Task branch attachment changed.");
					};
					const changed = () => {
						assertActive();
						void registration.changed().catch(options.onError);
					};
					const next = new TaskFlowProducer(
						branch.attachment,
						() => {
							assertActive();
							return request.read();
						},
						changed,
					);
					registration = branch.controller.register(next, async () => ingress.requestRelease());
					producer = next;
					closeRegistration = () => {
						active = false;
						registration.dispose();
					};
					request.accept({
						version: 1,
						submit: next.submit.bind(next),
						changed,
						// With flow control off, a task's own continuations and deliveries take over again.
						live: () => options.enabled?.() !== false,
						async ready() {
							assertActive();
							await next.synchronize();
							assertActive();
						},
						async tool<T>(
							name: string,
							args: { taskId?: string; status?: string; task_ids?: string[] },
							invoke: () => Promise<T>,
						): Promise<T> {
							assertActive();
							const origin = branch.workContext.current();
							const originCheck = origin && branch.workContext.authorize(origin.id);
							const before = next.inventory();
							let result: T;
							try {
								result = await invoke();
							} catch (error) {
								assertActive();
								await next.synchronize();
								changed();
								throw error;
							}
							originCheck?.assertActive();
							assertActive();
							const after = next.inventory();
							const selected =
								name === "TaskUpdate" && args.status === "in_progress"
									? [args.taskId]
									: name === "TaskExecute"
										? (args.task_ids ?? [])
										: [];
							const targets = after.filter(
								(task) =>
									(["TaskCreate", "TaskCreateMany"].includes(name) && !before.some((old) => old.key === task.key)) ||
									selected.includes(task.taskId),
							);
							if (targets.some((task) => !branch.attachment.waits.boundWork(taskWorkBinding(task.key))) && !origin)
								throw new FlowLedgerError("identity", "Starting task work requires an authorized invocation.");
							for (const task of targets) {
								if (task.state === "completed") continue;
								if (!branch.attachment.waits.boundWork(taskWorkBinding(task.key))) {
									if (!origin) throw new FlowLedgerError("identity", "Task origin is unavailable.");
									await branch.attachment.waits.deriveWorkBinding(
										taskWorkBinding(task.key),
										task.revision,
										origin,
										Date.now(),
										["bg", "tasks", "subagent", "schedule"],
									);
								}
							}
							await next.synchronize();
							assertActive();
							const target = selected.length === 1 ? after.find((task) => task.taskId === selected[0]) : undefined;
							const work = target && branch.attachment.waits.boundWork(taskWorkBinding(target.key));
							if (origin && work && target?.state === "active") {
								const source = (await branch.attachment.waits.authoritySnapshot()).work.find(
									(item) => item.id === origin.id,
								);
								if (source?.owner !== "host-user" && origin.id !== work.id && origin.id !== work.origin?.id)
									throw new FlowLedgerError("identity", "Task selection belongs to another work invocation.");
								await branch.workContext.selectToolWork({ id: work.id, actor: "tasks", revision: work.revision }, true);
							} else if (origin) {
								// Refresh this task's revision for following tools after its own metadata changes.
								const current = (await branch.attachment.waits.authoritySnapshot()).work.find(
									(item) => item.id === origin.id,
								);
								if (current?.owner === "tasks" && (current.lifecycle?.state ?? "active") === "active")
									await branch.workContext.selectToolWork(
										{
											id: current.id,
											actor: "tasks",
											revision: current.revision,
										},
										true,
									);
								else if (current?.owner === "tasks" && current.lifecycle?.state === "completed")
									await branch.workContext.returnFromToolWork();
							}
							changed();
							return result;
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
