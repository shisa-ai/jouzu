import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PiHostHooks } from "./pi-host-hooks.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowWorkContext } from "./work-context.js";

/** Scope actual Pi tool execution after its existing validation and interception hooks. */
export class PiWorkTools {
	private readonly hooks = new PiHostHooks();
	private readonly wrapped = new WeakSet<AgentTool>();
	private readonly pending = new Map<
		string,
		{ tool: AgentTool; args: unknown; signal?: AbortSignal; matches(): boolean }
	>();
	private closed = false;
	private readonly unsubscribe: () => void;

	constructor(session: AgentSession, work: FlowWorkContext) {
		this.unsubscribe = session.agent.subscribe((event) => {
			if (event.type === "turn_end" || event.type === "agent_end") this.pending.clear();
		});
		const previous = session.agent.beforeToolCall;
		this.hooks.set(session.agent, "beforeToolCall", async (input, signal) => {
			if (this.closed) throw new FlowLedgerError("stale", "Tool work attachment is closed.");
			const result = await previous?.(input, signal);
			if (result?.block || signal?.aborted) return result;
			if (this.closed) throw new FlowLedgerError("stale", "Tool work attachment closed during admission.");
			const tool = input.context.tools?.find((item) => item.name === input.toolCall.name);
			if (!tool) throw new FlowLedgerError("identity", "Admitted tool is unavailable.");
			if (this.pending.has(input.toolCall.id))
				throw new FlowLedgerError("identity", "Tool call identity is already pending.");
			this.pending.set(input.toolCall.id, { tool, args: input.args, signal, matches: work.captureInvocationCheck() });
			if (!this.wrapped.has(tool)) {
				this.wrapped.add(tool);
				const execute = tool.execute;
				this.hooks.set(tool, "execute", async (id, args, toolSignal, update) => {
					const pending = this.pending.get(id);
					// Another session may share the tool object; only the exact admitted arguments bind this call.
					if (
						!pending ||
						pending.tool !== tool ||
						pending.args !== args ||
						pending.signal !== toolSignal ||
						!pending.matches()
					)
						return execute.call(tool, id, args, toolSignal, update);
					this.pending.delete(id);
					if (this.closed) throw new FlowLedgerError("stale", "Tool work attachment is closed.");
					return work.runTool(() => execute.call(tool, id, args, toolSignal, update));
				});
			}
			return result;
		});
	}

	close(): void {
		this.closed = true;
		this.pending.clear();
		this.unsubscribe();
		this.hooks.close();
	}
}
