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
	/** Deferred native executions whose completion settles when the action runs or the drain ends. */
	#deferredSettled = new Set();
	/** Nesting depth of `agent_settled` emissions whose drains are still running. */
	#settledDepth = 0;
	#session;
	#handler;
	#nativePrompt;

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
		// Pi drains deferred settled actions after the event and stops at the first rejection, so an
		// earlier action's failure would abandon every later one without invoking it. Settle this
		// binding's pending executions when the drain ends instead of relying on its closure running.
		//
		// A deferred action that completes a turn emits a nested `agent_settled` before the outer drain
		// reaches its remaining actions, and Pi resumes that outer drain when the nested event returns.
		// Only the outermost completion means the drain is over, so an inner completion must not settle
		// actions the outer drain still owns.
		const emitSettled = session._emitAgentSettled;
		if (typeof emitSettled === "function") {
			const emit = emitSettled.bind(session);
			session._emitAgentSettled = async () => {
				binding.#settledDepth++;
				try {
					return await emit();
				} finally {
					binding.#settledDepth--;
					if (binding.#settledDepth === 0) binding.#abandonSettled();
				}
			};
		}
		return binding;
	}

	constructor(session, handler) {
		this.#session = session;
		this.#handler = handler;
		this.#nativePrompt = session.prompt.bind(session);
	}

	/**
	 * Run a native send that Pi may defer until the settled event finishes.
	 *
	 * While Pi emits `agent_settled`, a prompt and a waking custom send store a closure that re-enters the
	 * wrapped session method and return without executing. That re-entry would become a second submission
	 * with no retained record, so the dispatch that owns the retained record would report that it produced
	 * no native input while the text ran under an unowned host record instead. Replacing Pi's deferred
	 * closure with one that makes the same native call keeps the input owned by the record retained for it,
	 * so one delivery carries the original receipt identity.
	 *
	 * The deferred closure re-asks `revalidate` when it runs: grant authorization, runtime identity, and
	 * target are read at execution, not inherited from admission before the event was held. Every pending
	 * execution is settled when the outermost settled drain ends, so an earlier action's failure or a
	 * nested turn it starts cannot leave this dispatch waiting on a closure Pi has already discarded.
	 *
	 * Only a dispatch whose caller does not wait for the settled event may use this. Pi drains deferred work
	 * after the event finishes, so a send an `agent_settled` handler awaits would wait for itself.
	 */
	async #settled(revalidate, native, args) {
		const deferred = this.#session._deferredSettledActions;
		if (!Array.isArray(deferred)) return native(...args);
		const pending = deferred.length;
		const result = native(...args);
		if (deferred.length === pending) return result;
		// Pi drains these actions from the settled event's own async context, which belongs to whichever
		// dispatch emitted it. Capture this dispatch's context so the re-entry keeps the frame and
		// provenance that own the retained record.
		const snapshot = AsyncLocalStorage.snapshot();
		const entry = { running: false, settled: false, settle: undefined };
		const completed = new Promise((resolve, reject) => {
			entry.settle = { resolve, reject };
		});
		// Drop Pi's own re-entry, which would dispatch the same text again outside this dispatch.
		deferred.splice(pending);
		deferred.push(async () => {
			// The drain may have ended before this action ran; it was settled with the others then, and a
			// later invocation must not dispatch input that already reports a conservative outcome.
			if (entry.settled) return;
			entry.running = true;
			try {
				await snapshot(async () => {
					this.assertActive();
					try {
						await revalidate();
					} catch (error) {
						// A refusal is this dispatch's outcome, not a reason to abort the host's settled drain
						// and the deferred work other extensions queued behind it.
						entry.settled = true;
						entry.settle.reject(error);
						return;
					}
					const value = await native(...args);
					entry.settled = true;
					entry.settle.resolve(value);
				});
			} catch (error) {
				entry.settled = true;
				entry.settle.reject(error);
				throw error;
			} finally {
				entry.running = false;
				this.#deferredSettled.delete(entry);
			}
		});
		this.#deferredSettled.add(entry);
		return completed;
	}

	/** Settle every deferred execution whose action the outermost settled drain did not run. */
	#abandonSettled() {
		for (const entry of this.#deferredSettled) {
			if (entry.running || entry.settled) continue;
			entry.settled = true;
			entry.settle.reject(
				Object.assign(new Error("Deferred external input did not run before the settled event ended."), {
					code: "dispatch-abandoned",
				}),
			);
		}
		this.#deferredSettled.clear();
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

	async registerUserInputAdapter(extensionId, options, assertRuntime = () => {}) {
		assertRuntime();
		this.assertActive();
		if (typeof this.#handler.registerUserInputAdapter !== "function")
			throw Object.assign(new Error("External user input is unavailable in this host."), {
				code: "unsupported-protocol",
			});
		return this.#handler.registerUserInputAdapter(
			{
				extensionId,
				scope: () => {
					assertRuntime();
					this.assertActive();
					return this.#scope();
				},
				prepare: (input, expectedEpoch) => {
					assertRuntime();
					this.assertActive();
					const submission = structuredClone(input);
					const scope = this.#scope();
					if (
						submission.origin.kind !== "extension" ||
						submission.origin.id !== extensionId ||
						submission.api !== "prompt" ||
						!submission.externalUser ||
						submission.scope.sessionId !== scope.sessionId ||
						submission.scope.attachmentId !== scope.attachmentId ||
						(expectedEpoch !== undefined && typeof expectedEpoch !== "string")
					)
						throw new Error("Invalid external user-input dispatch identity.");
					/** Live authority for this exact input, asked again immediately before native input. */
					const revalidate = async () => {
						assertRuntime();
						this.assertActive();
						this.#assertTarget(submission);
						if (expectedEpoch === undefined) return;
						// The target epoch is the handler's: only it can compare the journal lifetime the caller
						// validated against the one a dispatch would run in.
						if (typeof this.#handler.authorizeExternal !== "function")
							throw Object.assign(new Error("External user input cannot be revalidated."), {
								code: "stale-target",
							});
						await this.#handler.authorizeExternal(submission, expectedEpoch);
						// Authorization reads the grant and the journal asynchronously, so the runtime that created
						// this callback, the binding it belongs to, and the target can all be replaced while it
						// waits. Ask again here rather than dispatching under authority read before the await.
						assertRuntime();
						this.assertActive();
						this.#assertTarget(submission);
					};
					let started = false;
					return async () => {
						await revalidate();
						if (started) throw new Error("External user input was already dispatched.");
						started = true;
						this.#dispatches++;
						try {
							await this.#dispatch.run({ submission, scope: submission.scope }, () =>
								this.#settled(revalidate, this.#nativePrompt, structuredClone(submission.args)),
							);
						} finally {
							this.#dispatches--;
						}
					};
				},
			},
			structuredClone(options),
		);
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

	/** The attachment and session this prepared dispatch validated are still the live ones. */
	#assertTarget(submission) {
		if (submission.scope.attachmentId !== this.#attachmentId || submission.scope.sessionId !== this.#scope().sessionId)
			throw Object.assign(new Error("External user-input target changed."), { code: "stale-target" });
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
		// A held settled event must not keep a dispatch waiting on a closure this binding no longer owns.
		this.#abandonSettled();
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
