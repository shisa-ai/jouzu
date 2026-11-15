import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { PiHostHooks } from "./flow-control/pi-host-hooks.js";

type FlowIngress = NonNullable<CreateAgentSessionOptions["flowIngress"]>;

/** Order native and extension model choices after an in-flight first-use selection. */
export function wrapModelSelectionIngress(
	delegate: FlowIngress | undefined,
	selection: {
		enteringAutomaticSelection(): boolean;
		beforeSelection(): Promise<void>;
		automaticSelectionSignal?(): AbortSignal | undefined;
	},
): FlowIngress {
	const hooks = new PiHostHooks();
	return {
		version: 1,
		...(delegate?.registerUserInputAdapter
			? { registerUserInputAdapter: delegate.registerUserInputAdapter.bind(delegate) }
			: {}),
		...(delegate?.authorizeExternal ? { authorizeExternal: delegate.authorizeExternal.bind(delegate) } : {}),
		async attach(session) {
			// Reject an aborted automatic choice before Pi mutates the selected model.
			if (selection.automaticSelectionSignal) {
				const runtime = session.modelRuntime;
				const checkAuth = runtime.checkAuth.bind(runtime);
				hooks.set(runtime, "checkAuth", async (provider, options) => {
					const signal = selection.automaticSelectionSignal?.();
					signal?.throwIfAborted();
					const result = await checkAuth(
						provider,
						signal
							? { ...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal }
							: options,
					);
					signal?.throwIfAborted();
					return result;
				});
			}
			// Session-lifetime hooks must sit below the delegate's branch-owned hooks.
			const setModel = session.setModel.bind(session);
			hooks.set(session, "setModel", async (...args) => {
				// Exempt the automatic call's async context, never unrelated concurrent choices.
				if (!selection.enteringAutomaticSelection()) await selection.beforeSelection();
				return setModel(...args);
			});
			const cycleModel = session.cycleModel.bind(session);
			hooks.set(session, "cycleModel", async (...args) => {
				if (!selection.enteringAutomaticSelection()) await selection.beforeSelection();
				return cycleModel(...args);
			});
			try {
				await delegate?.attach?.(session);
			} catch (error) {
				hooks.close();
				throw error;
			}
		},
		async settlePrint(signal) {
			await delegate?.settlePrint?.(signal);
		},
		async dispose() {
			try {
				await selection.beforeSelection();
			} finally {
				try {
					await delegate?.dispose?.();
				} finally {
					hooks.close();
				}
			}
		},
		async beforeBranchChange(previous) {
			await selection.beforeSelection();
			await delegate?.beforeBranchChange?.(previous);
		},
		async branchChanged(next) {
			await delegate?.branchChanged?.(next);
		},
		async runCommand(submission, run) {
			if (delegate?.runCommand) await delegate.runCommand(submission, run);
			else await run();
		},
		async submit(submission, dispatch) {
			if (delegate) await delegate.submit(submission, dispatch);
			else await dispatch();
		},
	};
}
