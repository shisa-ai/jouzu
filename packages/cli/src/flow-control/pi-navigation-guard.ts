import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PiHostHooks } from "./pi-host-hooks.js";
import { FlowLedgerError } from "./receipt-ledger.js";

const guards = new WeakMap<AgentSession, PiNavigationGuard>();

/** Installed below branch-owned hooks, so navigation stays fenced while those hooks are replaced. */
export class PiNavigationGuard {
	private readonly hooks = new PiHostHooks();
	private active = false;
	private entering = false;
	private closing = false;

	constructor(private readonly session: AgentSession) {
		if (guards.has(session)) throw new FlowLedgerError("busy", "Session navigation guard is already attached.");
		guards.set(session, this);
		const agent = session.agent;
		const prompt = agent.prompt.bind(agent);
		this.hooks.set(agent, "prompt", async (input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) => {
			this.assertAvailable();
			return typeof input === "string" ? prompt(input, images) : prompt(input);
		});
		this.hooks.set(agent, "continue", this.asyncCall(agent.continue.bind(agent)));
		this.hooks.set(agent, "continueQueued", this.asyncCall(agent.continueQueued.bind(agent)));
		this.hooks.set(agent, "steer", this.syncCall(agent.steer.bind(agent)));
		this.hooks.set(agent, "followUp", this.syncCall(agent.followUp.bind(agent)));
		this.hooks.set(agent, "editQueuedMessage", this.syncCall(agent.editQueuedMessage.bind(agent)));
		this.hooks.set(agent, "cancelQueuedMessage", this.syncCall(agent.cancelQueuedMessage.bind(agent)));
		this.hooks.set(session, "prompt", this.asyncCall(session.prompt.bind(session)));
		this.hooks.set(session, "continueQueued", this.asyncCall(session.continueQueued.bind(session)));
		this.hooks.set(session, "steer", this.asyncCall(session.steer.bind(session)));
		this.hooks.set(session, "followUp", this.asyncCall(session.followUp.bind(session)));
		this.hooks.set(session, "sendUserMessage", this.asyncCall(session.sendUserMessage.bind(session)));
		this.hooks.set(session, "sendCustomMessage", this.asyncCall(session.sendCustomMessage.bind(session)));
		this.hooks.set(session, "compact", this.asyncCall(session.compact.bind(session)));
		this.hooks.set(session, "setModel", this.asyncCall(session.setModel.bind(session)));
		this.hooks.set(session, "cycleModel", this.asyncCall(session.cycleModel.bind(session)));
		const navigate = session.navigateTree.bind(session);
		this.hooks.set(session, "navigateTree", async (...args) => {
			// Only the original synchronous entry may cross the fence. Recursive calls from hooks and
			// independent callers during awaited cleanup cannot reuse that entry permission.
			if (this.active && !this.entering) this.assertAvailable();
			this.entering = false;
			return navigate(...args);
		});
	}

	private assertAvailable(): void {
		if (this.active) throw new FlowLedgerError("busy", "Host operations must wait for branch navigation.");
	}

	private syncCall<A extends unknown[], R>(run: (...args: A) => R): (...args: A) => R {
		return (...args) => {
			this.assertAvailable();
			return run(...args);
		};
	}

	private asyncCall<A extends unknown[], R>(run: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
		return async (...args) => {
			this.assertAvailable();
			return run(...args);
		};
	}

	static run<T>(session: AgentSession, run: () => Promise<T>): Promise<T> {
		return guards.get(session)?.navigate(run) ?? run();
	}

	private async navigate<T>(run: () => Promise<T>): Promise<T> {
		this.assertAvailable();
		this.active = true;
		try {
			let pending: Promise<T>;
			this.entering = true;
			try {
				pending = run();
			} finally {
				this.entering = false;
			}
			return await pending;
		} finally {
			this.active = false;
			if (this.closing) this.close();
		}
	}

	close(): void {
		this.closing = true;
		if (this.active) return;
		this.hooks.close();
		if (guards.get(this.session) === this) guards.delete(this.session);
	}
}
