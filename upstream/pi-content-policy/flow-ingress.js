import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const methods = ["prompt", "steer", "followUp", "sendCustomMessage", "sendUserMessage"];

/** Instance-local host capture. The handler owns retention and admission policy. */
export class FlowIngressBinding {
	#source = new AsyncLocalStorage();
	#dispatch = new AsyncLocalStorage();
	#command = new AsyncLocalStorage();
	#attachmentId = randomUUID();
	#closed = false;
	#dispatches = 0;
	#session;
	#handler;

	static install(session, handler) {
		if (handler === undefined) return undefined;
		if (handler?.version !== 1 || typeof handler.submit !== "function")
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
		const scope = this.#dispatch.getStore()?.submission.scope;
		if (
			scope &&
			(scope.attachmentId !== this.#attachmentId || scope.sessionId !== this.#session.sessionManager.getSessionId())
		)
			throw new Error("Flow submission belongs to a replaced attachment.");
	}

	fromExtension(id, run) {
		return this.#source.run({ origin: { kind: "extension", id }, used: false }, run);
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
			return await this.#command.run(context, run);
		} finally {
			context.active = false;
		}
	}

	beforeBranchChange() {
		this.assertActive();
		if (
			this.#dispatches > 0 ||
			this.#session.agent.hasQueuedMessages() ||
			this.#session._pendingNextTurnMessages.length > 0
		)
			throw new Error("Flow submissions must settle or be cancelled before branch navigation.");
	}

	branchChanged() {
		this.#attachmentId = randomUUID();
	}

	dispose() {
		this.#closed = true;
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
		const notify = (accepted) => {
			if (preflightDone) return;
			preflightDone = true;
			preflight?.(accepted);
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
			notify(false);
			throw new Error("Flow submission contains unsupported data.", { cause });
		}
		const submission = {
			version: 1,
			id: randomUUID(),
			api,
			origin: { ...origin },
			scope: {
				sessionId: this.#session.sessionManager.getSessionId(),
				leafId: this.#session.sessionManager.getLeafId(),
				attachmentId: this.#attachmentId,
			},
			args: snapshot,
			...(command?.active && command.owner === origin.id ? { userCommand: { ...command.value } } : {}),
		};
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
			if (preflight) captured[1] = { ...captured[1], preflightResult: notify };
			this.#dispatches++;
			try {
				return await this.#dispatch.run({ submission, forward: api === "sendUserMessage" ? "prompt" : undefined }, () =>
					native(...captured),
				);
			} finally {
				this.#dispatches--;
			}
		};
		try {
			await this.#handler.submit(structuredClone(submission), dispatch);
			if (execution) await execution;
			if (!started) notify(true);
		} catch (error) {
			revoked = true;
			if (execution) await execution.catch(() => {});
			if (!started) notify(false);
			throw error;
		}
	}
}
