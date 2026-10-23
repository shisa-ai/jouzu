import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

type FlowIngress = NonNullable<CreateAgentSessionOptions["flowIngress"]>;

/** Read shell activity from the attached host without changing queue or dispatch ownership. */
export function createScrollbackSessionObserver() {
	let current: AgentSession | undefined;
	return {
		isShellBusy: () => current?.isBashRunning ?? false,
		wrap(delegate?: FlowIngress): FlowIngress {
			let attached: AgentSession | undefined;
			return {
				version: 1,
				...(delegate?.registerUserInputAdapter
					? { registerUserInputAdapter: delegate.registerUserInputAdapter.bind(delegate) }
					: {}),
				...(delegate?.authorizeExternal ? { authorizeExternal: delegate.authorizeExternal.bind(delegate) } : {}),
				async attach(session) {
					await delegate?.attach?.(session);
					attached = session;
					current = session;
				},
				async dispose() {
					if (current === attached) current = undefined;
					attached = undefined;
					await delegate?.dispose?.();
				},
				async beforeBranchChange(previous) {
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
		},
	};
}
