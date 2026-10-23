import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const methods = ["prompt", "steer", "followUp", "sendCustomMessage", "sendUserMessage"];
/**
 * Admission for input the flow host consumes without a native queue entry or run. Pi reports a
 * prompt outcome with the dispositions "started", "queued", or "handled"; a retained submission
 * reports "handled" because it holds no native queue entry, and it stays distinct from a native
 * "queued" or "started" result reported by the dispatch that eventually runs.
 */
const retained = "handled";

/** Instance-local host capture. The handler owns retention and admission policy. */
export class FlowIngressBinding {
	#source = new AsyncLocalStorage();
	#dispatch = new AsyncLocalStorage();
	#command = new AsyncLocalStorage();
	#branchCallback = new AsyncLocalStorage();
	#attachmentId = randomUUID();
	#closed = false;
	#changingBranch = false;
	#branchWork;
	#closing;
	#dispatches = 0;
	#session;
	#handler;

	static install(session, handler) {
		if (handler === undefined) return undefined;
		if (
			handler?.version !== 1 ||
			typeof handler.submit !== "function" ||
			(handler.attach !== undefined && typeof handler.attach !== "function") ||
			(handler.runCommand !== undefined && typeof handler.runCommand !== "function") ||
			(handler.beforeBranchChange !== undefined && typeof handler.beforeBranchChange !== "function") ||
			(handler.branchChanged !== undefined && typeof handler.branchChanged !== "function") ||
			(handler.dispose !== undefined && typeof handler.dispose !== "function")
		)
			throw new Error("Unsupported flow ingress protocol.");
		if (typeof session.agent.inspectQueuedMessages !== "function")
			throw new Error("Flow host queue checkpoints are unavailable.");
		const binding = new FlowIngressBinding(session, handler);
		for (const api of methods) {
			const native = session[api].bind(session);
			session[api] = (...args) => binding.#capture(api, args, native);
		}
		const checkpoints = session.agent.flowCheckpoints;
		session.agent.flowCheckpoints = {
			...checkpoints,
			beforeQueueClaim: async (items, signal) => {
				binding.assertActive();
				const admitted = checkpoints?.beforeQueueClaim ? await checkpoints.beforeQueueClaim(items, signal) : true;
				binding.assertActive();
				return admitted;
			},
			beforeRequest: async (input, signal) => {
				binding.assertActive();
				await checkpoints?.beforeRequest?.(input, signal);
				binding.assertActive();
			},
		};
		return binding;
	}

	constructor(session, handler) {
		this.#session = session;
		this.#handler = handler;
	}

	assertActive() {
		if (this.#closed) throw new Error("Flow attachment is closed.");
		if (this.#changingBranch) throw new Error("Flow branch transition has not completed.");
		const frame = this.#dispatch.getStore();
		const scope = frame?.submission.scope;
		// A live command controls the session runtime, not a retained branch input.
		// Its awaited continuation can navigate again; captured input dispatches and
		// callbacks after the command ends keep their original attachment fence.
		if (
			scope &&
			(scope.sessionId !== this.#session.sessionManager.getSessionId() ||
				(scope.attachmentId !== this.#attachmentId && !(frame.control && frame.active)))
		)
			throw new Error("Flow submission belongs to a replaced attachment.");
	}

	fromExtension(id, run) {
		return this.#source.run({ origin: { kind: "extension", id }, used: false }, run);
	}

	commandPreflighted() {
		return this.#dispatch.getStore()?.commandPreflighted === true;
	}

	async withCommand(command, run) {
		const parent = this.#dispatch.getStore()?.submission;
		if (parent?.api !== "prompt" || parent.origin.kind !== "host") return run();
		const context = {
			active: true,
			owner: command.flowExtensionPath,
			value: { id: randomUUID(), name: command.invocationName, submissionId: parent.id },
		};
		try {
			const invoke = () => this.#command.run(context, run);
			return await (this.#dispatch.getStore()?.control && this.#handler.runCommand
				? this.#handler.runCommand(structuredClone(parent), invoke)
				: invoke());
		} finally {
			context.active = false;
		}
	}

	#scope() {
		return {
			sessionId: this.#session.sessionManager.getSessionId(),
			leafId: this.#session.sessionManager.getLeafId(),
			attachmentId: this.#attachmentId,
		};
	}

	#assertBranchIdle() {
		if (
			this.#dispatches > 0 ||
			this.#session.agent.hasQueuedMessages() ||
			this.#session._pendingNextTurnMessages.length > 0
		)
			throw new Error("Flow submissions must settle or be cancelled before branch navigation.");
	}

	#runBranch(run) {
		const frame = { active: true };
		return this.#branchCallback.run(frame, async () => {
			try {
				return await run(this.#scope());
			} finally {
				frame.active = false;
			}
		});
	}

	async beforeBranchChange() {
		this.assertActive();
		this.#assertBranchIdle();
		this.#changingBranch = true;
		this.#branchWork = this.#runBranch((scope) => this.#handler.beforeBranchChange?.(scope));
		await this.#branchWork;
		if (this.#closed) throw new Error("Flow attachment is closed.");
		this.#assertBranchIdle();
	}

	async branchChanged() {
		if (this.#closed) throw new Error("Flow attachment is closed.");
		if (!this.#changingBranch) throw new Error("Flow branch transition was not started.");
		this.#attachmentId = randomUUID();
		this.#branchWork = this.#runBranch((scope) => this.#handler.branchChanged?.(scope));
		await this.#branchWork;
		if (this.#closed) throw new Error("Flow attachment is closed.");
		this.#assertBranchIdle();
		this.#changingBranch = false;
	}

	dispose() {
		if (this.#branchCallback.getStore()?.active) throw new Error("Flow branch callback cannot join its own disposal.");
		this.#closed = true;
		this.#closing ??= Promise.resolve().then(async () => {
			await this.#branchWork?.catch(() => {});
			await this.#handler.dispose?.();
		});
		return this.#closing;
	}

	async #capture(api, args, native) {
		this.assertActive();
		const frame = this.#dispatch.getStore();
		// sendUserMessage normalizes its content and calls prompt synchronously.
		// Consume this one forwarding allowance before prompt emits any events.
		if (frame?.forward === api) {
			frame.forward = undefined;
			return native(...args);
		}
		const source = this.#source.getStore();
		const origin =
			source && !source.used
				? source.origin
				: { kind: api === "prompt" || api === "steer" || api === "followUp" ? "host" : "sdk", id: api };
		if (source) source.used = true;
		const command = this.#command.getStore();
		const preflight = api === "prompt" ? args[1]?.preflightResult : undefined;
		if (preflight !== undefined && typeof preflight !== "function")
			throw new TypeError("Flow prompt preflightResult must be a function.");
		let preflightDone = false;
		// Pi's preflight callback is success-only: it receives a disposition once the prompt was
		// started, queued, or handled, and a rejected prompt reports through its rejected promise.
		// Exactly one report is forwarded, so a later dispatch cannot revise retained admission.
		const notify = (disposition) => {
			if (preflightDone) return;
			preflightDone = true;
			preflight?.(disposition);
		};
		const data = args.slice();
		if (preflight) {
			data[1] = { ...data[1] };
			delete data[1].preflightResult;
		}
		let snapshot;
		try {
			snapshot = structuredClone(data);
		} catch (cause) {
			throw new Error("Flow submission contains unsupported data.", { cause });
		}
		const submission = {
			version: 1,
			id: randomUUID(),
			api,
			origin: { ...origin },
			hostState: { streaming: this.#session.isStreaming },
			scope: {
				sessionId: this.#session.sessionManager.getSessionId(),
				leafId: this.#session.sessionManager.getLeafId(),
				attachmentId: this.#attachmentId,
			},
			args: snapshot,
			...(command?.active && command.owner === origin.id ? { userCommand: { ...command.value } } : {}),
		};
		// A direct host command may replace this session. Run Pi's command preflight before
		// admission owns a native dispatch that disposal would have to join. Nested sends
		// remain captured; extension-driven commands keep their existing admission policy.
		const commandPreflighted =
			api === "prompt" && origin.kind === "host" && (!frame || frame.control) && !this.#session._isEmittingAgentSettled;
		if (commandPreflighted && (snapshot[1]?.expandPromptTemplates ?? true) && snapshot[0].startsWith("/")) {
			const control = { submission, control: true, active: true };
			let handled;
			try {
				handled = await this.#dispatch.run(control, () => this.#session._tryExecuteExtensionCommand(snapshot[0]));
			} finally {
				control.active = false;
			}
			if (handled) {
				notify("handled");
				return;
			}
		}
		let started = false;
		let revoked = false;
		let execution;
		const dispatch = () => {
			const running = execute();
			execution ??= running;
			running.catch(() => {});
			return running;
		};
		const execute = async () => {
			this.assertActive();
			if (
				submission.scope.attachmentId !== this.#attachmentId ||
				submission.scope.sessionId !== this.#session.sessionManager.getSessionId()
			)
				throw new Error("Flow submission belongs to a replaced attachment.");
			if (revoked) throw new Error("Flow submission was rejected.");
			if (started) throw new Error("Flow submission was already dispatched.");
			started = true;
			const captured = structuredClone(snapshot);
			if (api === "sendCustomMessage") {
				// Pi's omitted triggerTurn defaults to waking only while streaming.
				// Retention must not change that decision when dispatch runs later.
				const triggerTurn = submission.hostState.streaming
					? captured[1]?.triggerTurn !== false
					: !!captured[1]?.triggerTurn;
				captured[1] = { ...captured[1], triggerTurn };
			}
			if (preflight) captured[1] = { ...captured[1], preflightResult: notify };
			this.#dispatches++;
			try {
				return await this.#dispatch.run(
					{ submission, commandPreflighted, forward: api === "sendUserMessage" ? "prompt" : undefined },
					() => native(...captured),
				);
			} finally {
				this.#dispatches--;
			}
		};
		try {
			await this.#handler.submit(structuredClone(submission), dispatch);
			// A dispatch owns the outcome, including the disposition the native send reported.
			// Propagating it keeps a wrapped send API identical to the unmodified session.
			if (execution) return await execution;
			notify(retained);
			return api === "steer" || api === "followUp" ? retained : undefined;
		} catch (error) {
			revoked = true;
			if (execution) await execution.catch(() => {});
			throw error;
		}
	}
}
