import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiSessionFlowIngress } from "./pi-session-ingress.js";

/** Drain accepted flow waits before a single-shot host prints its final answer. */
export async function settlePrintWork(
	session: AgentSession,
	ingress: PiSessionFlowIngress,
	signal: AbortSignal,
): Promise<void> {
	if (!ingress.enabled()) return;
	signal.throwIfAborted();
	const branch = ingress.branch();
	// Wait deadline timers are unref'ed for interactive hosts. A print host must
	// stay alive even when its only dependency is an external producer or deadline.
	const keepAlive = setInterval(() => {}, 60_000);
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
	void aborted.catch(() => {});
	const abort = () => rejectAbort(signal.reason);
	let unsubscribeWaits: (() => void) | undefined;
	let unsubscribeProducers: (() => void) | undefined;
	let unsubscribeIdle: (() => void) | undefined;
	try {
		unsubscribeWaits = branch.attachment.waits.onChanged(notify, rejectAbort);
		unsubscribeProducers = branch.attachment.waitProducers.onChanged(notify, rejectAbort);
		unsubscribeIdle = branch.host.onIdle((cause) => {
			if (cause === "operation") notify();
		});
		signal.addEventListener("abort", abort, { once: true });
		for (;;) {
			signal.throwIfAborted();
			const version = changed;
			const next = new Promise<void>((resolve) => {
				wake = resolve;
			});
			await Promise.race([session.waitForIdle(), aborted]);
			await Promise.race([ingress.joinPendingOperations(), aborted]);
			await Promise.race([ingress.wakeProducers(), aborted]);
			await Promise.race([session.waitForIdle(), aborted]);
			signal.throwIfAborted();
			if (branch !== ingress.branch()) throw new Error("Print flow session changed while settling.");
			if (!ingress.enabled()) return;
			const pause = ingress.automatedPause();
			if (pause) throw new Error(`Print continuation is paused: ${pause}`);
			const waits = await Promise.race([branch.attachment.waits.snapshot(), aborted]);
			if (version !== changed || session.isStreaming) continue;
			// Only accepted waits retain this host. An unfinished task inventory or a
			// detached job without a wait must not turn a single-shot command into a daemon.
			if (!waits.some((wait) => wait.state === "waiting")) return;
			await Promise.race([next, aborted]);
		}
	} finally {
		clearInterval(keepAlive);
		wake = undefined;
		signal.removeEventListener("abort", abort);
		unsubscribeIdle?.();
		unsubscribeProducers?.();
		unsubscribeWaits?.();
	}
}
