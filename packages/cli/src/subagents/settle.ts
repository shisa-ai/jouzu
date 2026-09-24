import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CompactionRequestController } from "../compaction-request.js";
import type { PiSessionFlowIngress } from "../flow-control/pi-session-ingress.js";

/** Subscribe to the producer-issued execution without creating a model dependency wait. */
export async function observeChildBackgroundExecution(ingress: PiSessionFlowIngress, details: unknown): Promise<void> {
	const task = (
		details as
			| {
					task?: {
						id?: string;
						flow?: {
							version?: number;
							execution?: string;
							scope?: { sessionId: string; branchId: string };
							work?: { id: string; revision: number };
						};
					};
			  }
			| undefined
	)?.task;
	if (!task?.flow) return;
	const { flow } = task;
	const branch = ingress.branch();
	const scope = branch.attachment.ledger.scope;
	if (
		flow.version !== 1 ||
		!task.id ||
		!flow.execution ||
		!flow.work ||
		flow.scope?.sessionId !== scope.sessionId ||
		flow.scope.branchId !== scope.branchId
	)
		throw new Error("Background execution does not belong to the child session.");
	await branch.attachment.waitProducers.bindForWait(
		"bg",
		{ handle: task.id, execution: flow.execution, workId: flow.work.id },
		flow.work.revision,
	);
}

/** A child result is terminal only after its admitted continuations and owned executions settle. */
export async function settleChildWork(
	session: AgentSession,
	ingress: PiSessionFlowIngress,
	compaction: CompactionRequestController,
	signal: AbortSignal,
): Promise<void> {
	const branch = ingress.branch();
	let changed = 0;
	let wake: (() => void) | undefined;
	const notify = () => {
		changed++;
		wake?.();
	};
	let rejectAbort: (reason: unknown) => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	// Install before the first asynchronous read so an execution cannot finish between
	// the snapshot and subscription. The signal also covers cancellation while idle.
	const abort = () => {
		notify();
		rejectAbort(signal.reason);
	};
	const unsubscribeWaits = branch.attachment.waits.onChanged(notify, rejectAbort);
	const unsubscribeProducers = branch.attachment.waitProducers.onChanged(notify, rejectAbort);
	const unsubscribeIdle = branch.host.onIdle((cause) => {
		if (cause === "operation") notify();
	});
	signal.addEventListener("abort", abort, { once: true });
	// A rejection while inspecting state must not become an unhandled rejection.
	void aborted.catch(() => {});
	try {
		for (;;) {
			signal.throwIfAborted();
			const version = changed;
			const next = new Promise<void>((resolve) => {
				wake = resolve;
			});
			await Promise.race([session.waitForIdle(), aborted]);
			await Promise.race([compaction.waitForIdle(), aborted]);
			await Promise.race([ingress.joinPendingOperations(), aborted]);
			await Promise.race([ingress.wakeProducers(), aborted]);
			await Promise.race([session.waitForIdle(), aborted]);
			signal.throwIfAborted();
			const [waits, authority] = await Promise.all([
				branch.attachment.waits.snapshot(),
				branch.attachment.waits.authoritySnapshot(),
			]);
			if (branch !== ingress.branch()) throw new Error("Child flow session changed while settling.");
			if (version !== changed || session.isStreaming || compaction.getState() !== "idle") continue;
			const pending =
				waits.some((wait) => wait.state === "waiting") ||
				authority.executions.some((execution) =>
					execution.predicates.some((predicate) => predicate.state === "pending"),
				);
			if (!pending) return;
			await Promise.race([next, aborted]);
		}
	} finally {
		wake = undefined;
		signal.removeEventListener("abort", abort);
		unsubscribeIdle();
		unsubscribeProducers();
		unsubscribeWaits();
	}
}
