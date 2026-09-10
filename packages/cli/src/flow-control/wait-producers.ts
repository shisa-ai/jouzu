import { isDeepStrictEqual } from "node:util";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";
import { type FlowAuthorityExecution, requireAuthorityWork } from "./wait-authority.js";
import { type FlowWaitClock, systemWaitClock } from "./wait-deadlines.js";
import { type FlowHealthPolicy, validateFlowHealthPolicy } from "./wait-health.js";
import type { FlowWaitStore } from "./wait-store.js";

export interface FlowExecutionIdentity {
	scope: FlowScope;
	workId: string;
	handle: string;
	execution: string;
}
export interface FlowExecutionEvidence extends FlowExecutionIdentity {
	revision: number;
	predicates: FlowAuthorityExecution["predicates"];
}
export interface FlowWaitExecutionSource {
	version: 1;
	namespace: string;
	/** Install the local listener synchronously, before snapshot inspection starts. */
	subscribe(identity: FlowExecutionIdentity, changed: (evidence: FlowExecutionEvidence) => void): () => void;
	snapshot(identity: FlowExecutionIdentity, signal: AbortSignal): Promise<FlowExecutionEvidence>;
	/**
	 * Health policies this producer supports for the given execution. Absent or empty means the
	 * producer offers no liveness evidence, so waits on it are deadline-only. The host never invents
	 * a policy: a wait may request only what is returned here for that exact execution.
	 */
	healthPolicies?(identity: FlowExecutionIdentity): FlowHealthPolicy[];
	/** True only when terminal output is observed or explicitly disposed in the producer's durable state. */
	canRetireExecution?(identity: FlowExecutionIdentity): boolean;
	close?(): void | Promise<void>;
}

interface ProducerRegistration {
	bind(
		identity: Omit<FlowExecutionIdentity, "scope">,
		workRevision: number,
	): Promise<{ flush(): Promise<void>; close(): Promise<void> }>;
	flushExecution(execution: string): Promise<boolean>;
	closeExecution(execution: string): Promise<boolean>;
	canRetireExecution(identity: FlowExecutionIdentity): boolean;
	healthPolicies(identity: FlowExecutionIdentity): FlowHealthPolicy[];
	close(): Promise<void>;
}

/** One namespace registration per attachment; each execution has one subscription owner. */
export class FlowWaitProducerRegistry {
	private readonly producers = new Map<string, ProducerRegistration>();
	private closed = false;
	private pendingBindings = 0;
	private restoring = false;
	private readonly listeners = new Set<{ changed(): void; onError(error: unknown): void }>();
	onChanged(changed: () => void, onError: (error: unknown) => void): () => void {
		if (this.closed) throw new FlowLedgerError("stale", "Wait producer registry is closed.");
		const listener = { changed, onError };
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private notifyChanged(): void {
		for (const listener of this.listeners)
			queueMicrotask(() => {
				if (!this.listeners.has(listener)) return;
				try {
					listener.changed();
				} catch (error) {
					listener.onError(error);
				}
			});
	}
	get updating(): boolean {
		return this.restoring || this.pendingBindings > 0;
	}
	constructor(
		private readonly store: FlowWaitStore,
		private readonly scope: Readonly<FlowScope>,
		private readonly clock: FlowWaitClock = systemWaitClock,
	) {}

	register(source: FlowWaitExecutionSource, onError: (error: unknown) => void) {
		if (this.closed) throw new FlowLedgerError("stale", "Wait producer registry is closed.");
		if (
			source?.version !== 1 ||
			!/^[a-z][a-z0-9-]{0,63}$/.test(source.namespace) ||
			typeof source.subscribe !== "function" ||
			typeof source.snapshot !== "function" ||
			(source.canRetireExecution !== undefined && typeof source.canRetireExecution !== "function") ||
			(source.healthPolicies !== undefined && typeof source.healthPolicies !== "function") ||
			(source.close !== undefined && typeof source.close !== "function") ||
			typeof onError !== "function"
		)
			throw new FlowLedgerError("schema", "Unsupported wait producer registration.");
		if (this.producers.size >= 64) throw new FlowLedgerError("capacity", "Wait producer registry is full.");
		const namespace = source.namespace;
		if (this.producers.has(namespace)) throw new FlowLedgerError("identity", "Wait producer is already registered.");
		const subscribe = source.subscribe.bind(source),
			snapshot = source.snapshot.bind(source),
			closeSource = source.close?.bind(source),
			canRetire = source.canRetireExecution?.bind(source),
			policies = source.healthPolicies?.bind(source);
		const bindings = new Map<string, ExecutionBinding>();
		let closed = false;
		let closing: Promise<void> | undefined;
		const registration = {
			healthPolicies: (identity: FlowExecutionIdentity) => {
				const declared = policies?.(structuredClone(identity)) ?? [];
				if (!Array.isArray(declared)) throw new FlowLedgerError("schema", "Health policies must be a list.");
				if (declared.length > 16)
					throw new FlowLedgerError("capacity", "An execution declares too many health policies.");
				const validated = declared.map((policy) => validateFlowHealthPolicy(policy));
				if (new Set(validated.map((policy) => policy.name)).size !== validated.length)
					throw new FlowLedgerError("identity", "Health policy names must be unique for an execution.");
				return validated;
			},
			canRetireExecution: (identity: FlowExecutionIdentity) =>
				!closed && !this.closed && canRetire?.(structuredClone(identity)) === true,
			closeExecution: async (execution: string) => {
				const binding = bindings.get(execution);
				if (!binding) return false;
				await binding.close();
				if (bindings.get(execution) === binding) bindings.delete(execution);
				return true;
			},
			flushExecution: async (execution: string) => {
				const binding = bindings.get(execution);
				if (!binding) return false;
				await binding.flush();
				return true;
			},
			bind: async (identity: Omit<FlowExecutionIdentity, "scope">, workRevision: number) => {
				if (closed || this.closed) throw new FlowLedgerError("stale", "Wait producer registration is closed.");
				const captured = {
					workId: identity.workId,
					handle: identity.handle,
					execution: identity.execution,
					scope: { ...this.scope },
				};
				if (
					![captured.workId, captured.handle, captured.execution].every(
						(value) => typeof value === "string" && value.length > 0 && value.length <= 512,
					)
				)
					throw new FlowLedgerError("identity", "Invalid producer execution identity.");
				if (bindings.size >= 1024) throw new FlowLedgerError("capacity", "Producer execution subscriptions are full.");
				const key = captured.execution;
				if (bindings.has(key)) throw new FlowLedgerError("identity", "Producer execution already has a subscription.");
				const binding = new ExecutionBinding(
					this.store,
					namespace,
					captured,
					workRevision,
					subscribe,
					snapshot,
					this.clock,
					onError,
				);
				bindings.set(key, binding);
				this.pendingBindings++;
				try {
					await binding.start();
					return {
						flush: () => binding.flush(),
						close: async () => {
							await binding.close();
							if (bindings.get(key) === binding) bindings.delete(key);
						},
					};
				} catch (error) {
					await binding.close();
					bindings.delete(key);
					throw error;
				} finally {
					this.pendingBindings--;
					this.notifyChanged();
				}
			},
			close: () => {
				closing ??= (async () => {
					closed = true;
					await Promise.all([...bindings.values()].map((binding) => binding.close()));
					await closeSource?.();
					bindings.clear();
					if (this.producers.get(namespace) === registration) this.producers.delete(namespace);
				})();
				return closing;
			},
		};
		this.producers.set(namespace, registration);
		return registration;
	}

	/** Bind an exact tool dependency or reuse its retained terminal evidence. */
	/**
	 * Resolve the policy a wait requests, or refuse the declaration. An unregistered name, or any
	 * name at all from a producer that declares none, fails here rather than parking a wait whose
	 * health could never be evaluated.
	 */
	requireHealthPolicy(
		namespace: string,
		identity: Omit<FlowExecutionIdentity, "scope">,
		name: string,
	): FlowHealthPolicy {
		if (this.closed) throw new FlowLedgerError("stale", "Wait producer registry is closed.");
		const producer = this.producers.get(namespace);
		if (!producer) throw new FlowLedgerError("identity", "Wait producer is not attached.");
		const policy = producer
			.healthPolicies({ ...structuredClone(identity), scope: { ...this.scope } })
			.find((candidate) => candidate.name === name);
		if (!policy)
			throw new FlowLedgerError(
				"identity",
				`Health policy ${name} is not registered for this execution; declare a deadline-only wait instead.`,
			);
		return policy;
	}

	async bindForWait(
		namespace: string,
		identity: Omit<FlowExecutionIdentity, "scope">,
		workRevision: number,
	): Promise<void> {
		if (this.closed) throw new FlowLedgerError("stale", "Wait producer registry is closed.");
		if (this.updating) throw new FlowLedgerError("busy", "Producer subscriptions are changing.");
		const captured = structuredClone(identity);
		const authority = await this.store.authoritySnapshot();
		requireAuthorityWork(authority, captured.workId, namespace, workRevision);
		const known = authority.executions.find(
			(execution) => execution.producer === namespace && execution.execution === captured.execution,
		);
		if (known && (known.workId !== captured.workId || known.handle !== captured.handle))
			throw new FlowLedgerError("identity", "Wait execution has different ownership.");
		if (this.closed) throw new FlowLedgerError("stale", "Wait producer registry is closed.");
		if (known?.predicates.every((predicate) => predicate.state !== "pending")) return;
		const producer = this.producers.get(namespace);
		if (!producer) throw new FlowLedgerError("identity", "Wait producer is not attached.");
		if (!(await producer.flushExecution(captured.execution))) await producer.bind(captured, workRevision);
	}

	/** Release listeners after every predicate is terminal; retain durable evidence and unread output. */
	async closeTerminalSubscriptions(): Promise<number> {
		if (this.closed) throw new FlowLedgerError("stale", "Wait producer registry is closed.");
		if (this.updating) throw new FlowLedgerError("busy", "Producer subscriptions are changing.");
		this.pendingBindings++;
		try {
			const authority = await this.store.authoritySnapshot();
			let closed = 0;
			for (const execution of authority.executions) {
				if (this.closed) throw new FlowLedgerError("stale", "Wait producer registry is closed.");
				if (execution.predicates.some((predicate) => predicate.state === "pending")) continue;
				if (await this.producers.get(execution.producer)?.closeExecution(execution.execution)) closed++;
			}
			return closed;
		} finally {
			this.pendingBindings--;
		}
	}

	/** Producer output eligibility complements the store's exact wait/work dependency checks. */
	retirementCandidates(records: readonly FlowAuthorityExecution[]): {
		executions: FlowAuthorityExecution[];
		assertCurrent(): void;
	} {
		if (this.closed) throw new FlowLedgerError("stale", "Wait producer registry is closed.");
		if (this.updating) throw new FlowLedgerError("busy", "Producer subscriptions are changing.");
		const selected = records.flatMap((execution) => {
			if (execution.predicates.some((predicate) => predicate.state === "pending")) return [];
			const producer = this.producers.get(execution.producer);
			const identity = {
				scope: { ...this.scope },
				workId: execution.workId,
				handle: execution.handle,
				execution: execution.execution,
			};
			return producer?.canRetireExecution(identity)
				? [{ execution: structuredClone(execution), producer, identity }]
				: [];
		});
		return {
			executions: selected.map((item) => item.execution),
			assertCurrent: () => {
				if (
					this.closed ||
					this.updating ||
					selected.some(
						(item) =>
							this.producers.get(item.execution.producer) !== item.producer ||
							!item.producer.canRetireExecution(item.identity),
					)
				)
					throw new FlowLedgerError("stale", "Producer output retirement eligibility changed.");
			},
		};
	}

	/** Reconcile retained pending executions before the branch admits another request. */
	async restorePending(): Promise<{ restored: number; missing: string[] }> {
		if (this.closed) throw new FlowLedgerError("stale", "Wait producer registry is closed.");
		if (this.updating) throw new FlowLedgerError("busy", "Producer subscriptions are changing.");
		this.restoring = true;
		try {
			const authority = await this.store.authoritySnapshot();
			const pending = authority.executions.filter((execution) =>
				execution.predicates.some((predicate) => predicate.state === "pending"),
			);
			const missing = [
				...new Set(
					pending.filter((execution) => !this.producers.has(execution.producer)).map((execution) => execution.producer),
				),
			];
			let restored = 0;
			for (const execution of pending) {
				if (this.closed) throw new FlowLedgerError("stale", "Wait producer registry is closed.");
				const producer = this.producers.get(execution.producer);
				if (!producer || (await producer.flushExecution(execution.execution))) continue;
				const work = authority.work.find((work) => work.id === execution.workId);
				if (!work) throw new FlowLedgerError("identity", "Retained execution has no owning work.");
				await producer.bind(
					{ workId: execution.workId, handle: execution.handle, execution: execution.execution },
					work.revision,
				);
				restored++;
			}
			if (this.closed) throw new FlowLedgerError("stale", "Wait producer registry is closed.");
			return { restored, missing };
		} finally {
			this.restoring = false;
			this.notifyChanged();
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		this.listeners.clear();
		await Promise.all([...this.producers.values()].map((producer) => producer.close()));
	}
}

class ExecutionBinding {
	private readonly abort = new AbortController();
	private unsubscribe?: () => void;
	private cleanupFailure?: unknown;
	private buffer: FlowExecutionEvidence[] = [];
	private ready = false;
	private pending = 0;
	private initialNotifications = 0;
	private closed = false;
	private failure?: unknown;
	private tail: Promise<void> = Promise.resolve();
	private starting?: Promise<void>;
	constructor(
		private readonly store: FlowWaitStore,
		private readonly namespace: string,
		private readonly identity: FlowExecutionIdentity,
		private readonly workRevision: number,
		private readonly subscribe: FlowWaitExecutionSource["subscribe"],
		private readonly snapshot: FlowWaitExecutionSource["snapshot"],
		private readonly clock: FlowWaitClock,
		private readonly onError: (error: unknown) => void,
	) {}

	private check(evidence: FlowExecutionEvidence): FlowExecutionEvidence {
		if (
			!evidence ||
			!isDeepStrictEqual(evidence.scope, this.identity.scope) ||
			evidence.workId !== this.identity.workId ||
			evidence.handle !== this.identity.handle ||
			evidence.execution !== this.identity.execution ||
			!Number.isSafeInteger(evidence.revision) ||
			evidence.revision < 1 ||
			!Array.isArray(evidence.predicates) ||
			evidence.predicates.length < 1 ||
			evidence.predicates.length > 64 ||
			evidence.predicates.some(
				(predicate) =>
					!predicate ||
					typeof predicate.until !== "string" ||
					!predicate.until ||
					predicate.until.length > 512 ||
					!["pending", "satisfied", "failed", "cancelled", "missing"].includes(predicate.state),
			) ||
			new Set(evidence.predicates.map((predicate) => predicate.until)).size !== evidence.predicates.length
		)
			throw new FlowLedgerError("identity", "Execution observation has foreign or invalid evidence.");
		return {
			...this.identity,
			scope: { ...this.identity.scope },
			revision: evidence.revision,
			predicates: evidence.predicates.map(({ until, state }) => ({ until, state })),
		};
	}
	private stopSubscription(): void {
		const unsubscribe = this.unsubscribe;
		this.unsubscribe = undefined;
		try {
			unsubscribe?.();
		} catch (error) {
			this.cleanupFailure = error;
		}
	}
	private fail(error: unknown): void {
		if (this.closed || this.failure !== undefined) return;
		this.failure = error;
		this.abort.abort(error);
		this.stopSubscription();
		try {
			this.onError(error);
		} catch (reportError) {
			this.failure = new AggregateError([error, reportError], "Producer observation and error reporting failed.");
		}
	}
	private publish = (evidence: FlowExecutionEvidence): void => {
		if (this.closed || this.failure !== undefined) return;
		try {
			const captured = this.check(evidence);
			if (!this.ready) {
				if (this.initialNotifications++ >= 128)
					throw new FlowLedgerError("capacity", "Execution observation buffer is full.");
				this.buffer.push(captured);
			} else {
				if (this.pending >= 128) throw new FlowLedgerError("capacity", "Execution observation queue is full.");
				this.pending++;
				this.tail = this.tail
					.then(() => this.observe(captured))
					.catch((error) => this.fail(error))
					.finally(() => {
						this.pending--;
					});
			}
		} catch (error) {
			this.fail(error);
		}
	};
	private async observe(evidence: FlowExecutionEvidence): Promise<void> {
		if (this.closed || this.failure !== undefined) return;
		await this.store.observeExecution(
			{ producer: this.namespace, handle: this.identity.handle, execution: this.identity.execution },
			evidence.revision,
			evidence.predicates,
			this.clock.now(),
		);
	}

	start(): Promise<void> {
		this.starting = this.initialize();
		return this.starting;
	}
	private async initialize(): Promise<void> {
		requireAuthorityWork(await this.store.authoritySnapshot(), this.identity.workId, this.namespace, this.workRevision);
		this.abort.signal.throwIfAborted();
		this.unsubscribe = this.subscribe(structuredClone(this.identity), this.publish);
		if (typeof this.unsubscribe !== "function")
			throw new FlowLedgerError("schema", "Producer subscription must return cleanup.");
		this.abort.signal.throwIfAborted();
		let rejectAbort: () => void = () => {};
		const aborted = new Promise<never>((_resolve, reject) => {
			rejectAbort = () => reject(this.abort.signal.reason);
			this.abort.signal.addEventListener("abort", rejectAbort, { once: true });
		});
		const cancelTimeout = this.clock.after(5000, () =>
			this.abort.abort(new FlowLedgerError("stale", "Producer snapshot timed out.")),
		);
		let initial: FlowExecutionEvidence;
		try {
			initial = this.check(
				await Promise.race([this.snapshot(structuredClone(this.identity), this.abort.signal), aborted]),
			);
		} finally {
			cancelTimeout();
			this.abort.signal.removeEventListener("abort", rejectAbort);
		}
		this.abort.signal.throwIfAborted();
		do {
			// Validate the full observed progression, including older events buffered before snapshot.
			const observations = [initial, ...this.buffer.splice(0)].sort((a, b) => a.revision - b.revision);
			let prior = observations[0];
			for (const next of observations.slice(1)) {
				if (
					next.revision === prior.revision
						? !isDeepStrictEqual(next.predicates, prior.predicates)
						: next.predicates.length !== prior.predicates.length ||
							prior.predicates.some((predicate) => {
								const current = next.predicates.find((item) => item.until === predicate.until);
								return !current || (predicate.state !== "pending" && current.state !== predicate.state);
							})
				)
					throw new FlowLedgerError("transition", "Buffered execution evidence conflicts with its snapshot.");
				prior = next;
			}
			initial = prior;
			this.abort.signal.throwIfAborted();
			await this.store.synchronizeExecution(
				{
					producer: this.namespace,
					workId: initial.workId,
					handle: initial.handle,
					execution: initial.execution,
					revision: initial.revision,
					predicates: initial.predicates,
				},
				this.workRevision,
				this.clock.now(),
			);
		} while (this.buffer.length);
		this.abort.signal.throwIfAborted();
		this.ready = true;
	}
	async flush(): Promise<void> {
		await this.starting;
		await this.tail;
		if (this.failure !== undefined) throw this.failure;
	}
	async close(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			this.abort.abort(new FlowLedgerError("stale", "Producer execution subscription closed."));
			this.stopSubscription();
		}
		await this.starting?.catch(() => {});
		await this.tail;
		if (this.cleanupFailure !== undefined) throw this.cleanupFailure;
	}
}
