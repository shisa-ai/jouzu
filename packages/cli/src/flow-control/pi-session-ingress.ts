import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { type FlowProducer, retainedByReceipt } from "./controller.js";
import type { FlowInputItem } from "./model-input.js";
import {
	awaitingNativeInput,
	decideNativeAdmission,
	isNativeUserInput,
	isNativeUserQueueSubmission,
} from "./native-admission.js";
import { type PiFlowBranchResources, type PiFlowSessionOptions, PiFlowSessionService } from "./pi-session-service.js";
import { FlowLedgerError } from "./receipt-ledger.js";
import type { FlowNativeInput } from "./submission-store.js";
import { activeAdmissionHolds } from "./submission-view.js";
import type { FlowWorkStatus } from "./wait-authority.js";
import type { FlowWaitClock } from "./wait-deadlines.js";
import { createFlowWaitDecisionProducer } from "./wait-decisions.js";

type Ingress = NonNullable<CreateAgentSessionOptions["flowIngress"]>;
type Submission = Parameters<Ingress["submit"]>[0];
export interface PiFlowIngressOptions extends Omit<PiFlowSessionOptions, "admitNativeQueue" | "decorateNativeContext"> {
	/** Opt in to host-boundary release; failures require visible host reporting. */
	autoRelease?: { onError(error: unknown): void; clock?: FlowWaitClock };
	/** Semantic admission override; omission uses conservative unadapted-send admission. */
	admit?(
		submission: Submission,
		branch: PiFlowBranchResources,
		phase: "submission" | "queue",
		input?: FlowNativeInput,
	): Promise<boolean>;
}
interface Pending {
	branch: PiFlowBranchResources;
	submission: Submission;
	revision: number;
	dispatch: () => Promise<void>;
	running?: Promise<boolean>;
}

/** Own Pi's ingress lifecycle and retained one-use callbacks. Persistence never reconstructs a send. */
export class PiSessionFlowIngress implements Ingress {
	readonly version = 1 as const;
	private service?: PiFlowSessionService;
	private session?: AgentSession;
	private opening?: Promise<void>;
	private closing?: Promise<void>;
	private disposed = false;
	private fenced = false;
	private readonly pending = new Map<string, Pending>();
	private readonly waitContexts = new Map<
		string,
		{ branch: PiFlowBranchResources; args: unknown[]; used: boolean; completed: boolean }
	>();
	private readonly frames = new AsyncLocalStorage<{ active: boolean; id?: string }>();
	private readonly active = new Set<Promise<unknown>>();
	private producerWake?: Promise<void>;
	private producerWakeRequested = false;
	private activeUserInput = 0;
	private retainedUserInput = new Set<string>();
	private unsubscribeIdle?: () => void;
	private unsubscribeWaits?: () => void;
	private scheduledRelease?: ReturnType<typeof setImmediate>;
	private releaseRequested = false;
	private semanticReleaseRequested = false;
	private automaticReleaseRunning = false;
	private releasing?: Promise<{ released: string[]; held: string[] }>;
	constructor(private readonly options: PiFlowIngressOptions) {}

	attach(session: AgentSession): Promise<void> {
		if (this.disposed || this.opening || this.service)
			return Promise.reject(new FlowLedgerError("stale", "Flow ingress is already attached or closed."));
		this.session = session;
		this.opening = (async () => {
			const service = await PiFlowSessionService.open(session, {
				...this.options,
				policy: () => {
					const policy = this.options.policy();
					return {
						...policy,
						userPending: policy.userPending || this.activeUserInput > 0 || this.retainedUserInput.size > 0,
					};
				},
				decorateNativeContext: async (messages, sources, signal) => {
					const branch = this.branch();
					// Queue receipts identify consumed user input; text and delivery lanes do not.
					if (messages.at(-1)?.role !== "user" || !sources.some((source) => source.queue)) return messages;
					const records = await branch.attachment.submissions.snapshot();
					const user = sources.some((source) => {
						if (!source.queue || source.index !== messages.length - 1) return false;
						const record = records.find((record) => record.dispatch?.operationId === source.operationId);
						return (
							record &&
							isNativeUserInput(record.submission) &&
							record.dispatch?.inputs?.some(
								(input) => input.queue?.id === source.queue?.id && input.queue?.revision === source.queue?.revision,
							)
						);
					});
					if (!user) return messages;
					const content = await this.userWaitContext(branch, true, true);
					if (content === undefined) return messages;
					signal?.throwIfAborted();
					if (this.branch() !== branch) throw new FlowLedgerError("stale", "Queued user context branch changed.");
					const projection = {
						role: "custom" as const,
						customType: "jouzu-wait-context",
						content,
						display: false,
						timestamp: 0,
					};
					return {
						messages: [...messages, projection],
						projections: JSON.parse(content).waitDecisions.length ? [projection] : [],
					};
				},
				admitNativeQueue: (record, input) =>
					this.track(async () => {
						const branch = this.branch();
						const allowed = await this.admit(
							structuredClone(record.submission),
							branch,
							"queue",
							structuredClone(input),
						);
						if (this.branch() !== branch)
							throw new FlowLedgerError("stale", "Queued input branch changed during admission.");
						return allowed && !branch.attachment.nativeRequests.recoveryBlocked;
					}, record.id),
			});
			this.service = service;
			await this.refreshUserInput();
			await this.startScheduling();
		})();
		return this.opening;
	}
	/** Register with this branch's controller; notifications return through the ingress owner. */
	registerProducer(producer: FlowProducer) {
		const branch = this.branch();
		return branch.controller.register(producer, () => {
			if (this.branch() !== branch)
				return Promise.reject(new FlowLedgerError("stale", "Producer belongs to another flow branch."));
			return this.wakeProducers();
		});
	}
	/** Join producer changes, releasing retained user callbacks before semantic selection. */
	wakeProducers(): Promise<void> {
		const branch = this.branch();
		if (this.frames.getStore()?.active)
			return Promise.reject(new FlowLedgerError("busy", "Producer scheduling cannot join its own ingress operation."));
		this.producerWakeRequested = true;
		if (this.producerWake) return this.producerWake;
		const run = this.track(async () => {
			do {
				this.producerWakeRequested = false;
				if (this.branch() !== branch) throw new FlowLedgerError("stale", "Producer scheduling branch changed.");
				const users = [...this.pending.entries()].filter(
					([, pending]) => pending.branch === branch && isNativeUserInput(pending.submission),
				);
				for (const [id, pending] of users) {
					if (this.pending.get(id) !== pending) continue;
					if (!(await this.release(id, pending.revision))) break;
				}
				if (this.branch() !== branch) throw new FlowLedgerError("stale", "Producer scheduling branch changed.");
				await this.refreshUserInput();
				await branch.controller.wake();
			} while (this.producerWakeRequested);
		});
		this.producerWake = run;
		void run
			.finally(() => {
				if (this.producerWake === run) this.producerWake = undefined;
			})
			.catch(() => {});
		return run;
	}

	private async refreshUserInput(): Promise<void> {
		const records = await this.branch().attachment.submissions.snapshot();
		this.retainedUserInput = new Set(
			records
				.filter((record) => isNativeUserInput(record.submission) && awaitingNativeInput(record))
				.map((record) => record.id),
		);
	}

	private async startScheduling(): Promise<void> {
		const automatic = this.options.autoRelease;
		if (!automatic) return;
		const branch = this.branch();
		let ready = false;
		this.unsubscribeIdle = branch.host.onIdle((cause) => this.queueRelease(cause === "operation"));
		this.unsubscribeWaits = branch.attachment.waits.onChanged(() => {
			if (ready) this.queueRelease(true);
		}, automatic.onError);
		await branch.attachment.waits.startDeadlines(automatic.onError, automatic.clock);
		ready = true;
		// Recovered terminal decisions may predate subscription and need no new producer callback.
		this.queueRelease(true);
	}

	/** Policy changes and drained host operations use one deferred scheduling entry point. */
	requestRelease(): void {
		this.queueRelease(true);
	}
	private queueRelease(semantic: boolean): void {
		if (!this.options.autoRelease || this.disposed || this.fenced) return;
		this.releaseRequested = true;
		this.semanticReleaseRequested ||= semantic;
		if (this.scheduledRelease || this.automaticReleaseRunning) return;
		this.scheduledRelease = this.frames.exit(() =>
			setImmediate(() => {
				this.scheduledRelease = undefined;
				if (this.disposed || this.fenced) return;
				this.releaseRequested = false;
				const wakeSemantic = this.semanticReleaseRequested;
				this.semanticReleaseRequested = false;
				this.automaticReleaseRunning = true;
				const joinedExisting = !!this.releasing;
				void Promise.resolve()
					.then(async () => {
						// Drain an already admitted native pass before considering another dispatch.
						await this.releasing;
						if (wakeSemantic && !this.disposed && !this.fenced && this.branch().controller.view().producers.length)
							await this.wakeProducers();
						// Producer scheduling releases retained users first, then applies semantic rank ordering.
						return this.releaseReady();
					})
					.then((result) => {
						if (joinedExisting || (result.released.length && result.held.length)) this.releaseRequested = true;
					})
					.finally(() => {
						this.automaticReleaseRunning = false;
						if (this.releaseRequested) this.queueRelease(false);
					})
					.catch((error: unknown) => {
						if ((this.disposed || this.fenced) && error instanceof FlowLedgerError && error.code === "stale") return;
						this.options.autoRelease?.onError(error);
					});
			}),
		);
	}
	private stopReleaseNotifications(): void {
		this.releaseRequested = false;
		this.semanticReleaseRequested = false;
		this.unsubscribeIdle?.();
		this.unsubscribeIdle = undefined;
		this.unsubscribeWaits?.();
		this.unsubscribeWaits = undefined;
		if (this.scheduledRelease) clearImmediate(this.scheduledRelease);
		this.scheduledRelease = undefined;
	}

	/** Read persisted admission reasons; inspection cannot reconstruct an executable send. */
	async heldInputs(): Promise<{ id: string; reason: string }[]> {
		const records = await this.branch().attachment.submissions.snapshot();
		return records.flatMap((record) =>
			activeAdmissionHolds(record).map((hold) => ({ id: record.id, reason: hold.reason })),
		);
	}

	/** Versioned read-only management snapshot; neither inspection nor receipt presence authorizes replay. */
	inspect() {
		return this.track(async () => {
			const branch = this.branch();
			const submissions = await branch.attachment.submissionViews();
			if (this.branch() !== branch) throw new FlowLedgerError("stale", "Flow inspection branch changed.");
			return { version: 1 as const, scope: { ...branch.scope }, submissions };
		});
	}
	private manage<T>(run: (service: PiFlowSessionService) => Promise<T>): Promise<T> {
		this.branch();
		const service = this.service;
		if (!service) return Promise.reject(new FlowLedgerError("stale", "Flow management has no attached session."));
		return this.track(() => run(service)).then((result) => {
			this.queueRelease(true);
			return result;
		});
	}
	changeWork(id: string, owner: string, revision: number, status: FlowWorkStatus, reason: string) {
		return this.manage((service) =>
			service.changeWork(id, owner, revision, status, reason, this.options.autoRelease?.clock?.now() ?? Date.now()),
		);
	}
	cancelNativeQueue(id: string, revision: number): Promise<void> {
		return this.manage(async (service) => {
			await service.cancelNativeQueue(id, revision);
			await this.refreshUserInput();
		});
	}
	cancelNativeContext(id: string, revision: number, inputIndex: number): Promise<void> {
		return this.manage((service) => service.cancelNativeContext(id, revision, inputIndex));
	}
	reconcileNativeQueueEdit(id: string, revision: number): Promise<void> {
		return this.manage((service) => service.reconcileNativeQueueEdit(id, revision));
	}
	retryNativeRequest(id: string, expectedHash: string): Promise<void> {
		return this.manage((service) => service.retryNativeRequest(id, expectedHash));
	}
	cancelNativeSources(id: string, expectedHash: string, indices: number[]): Promise<void> {
		return this.manage((service) => service.cancelNativeSources(id, expectedHash, indices));
	}

	cancelNativeProjections(id: string, expectedHash: string, indices: number[]): Promise<void> {
		return this.manage((service) => service.cancelNativeProjections(id, expectedHash, indices));
	}

	private nativeRecoveryBlocked(
		submission: Submission,
		branch: PiFlowBranchResources,
		phase: "submission" | "queue",
	): boolean {
		return phase === "submission" && this.session && isNativeUserQueueSubmission(submission, this.session)
			? branch.requests.queueingBlocked
			: branch.attachment.nativeRequests.recoveryBlocked;
	}
	private async admit(
		submission: Submission,
		branch: PiFlowBranchResources,
		phase: "submission" | "queue",
		input?: FlowNativeInput,
	): Promise<boolean> {
		if (!this.session) throw new FlowLedgerError("stale", "Flow ingress has no host session.");
		const session = this.session;
		const records = await branch.attachment.submissions.snapshot();
		const state = await branch.attachment.ledger.snapshot();
		const policy = this.options.policy();
		const waits = branch.attachment.waits.gate();
		const recoveryBlocked =
			waits.updating ||
			policy.recoveryBlocked ||
			this.nativeRecoveryBlocked(submission, branch, phase) ||
			branch.recovery.unresolved > 0 ||
			branch.sourceRecovery.unresolved > 0 ||
			state.attempts.some((attempt) => attempt.phase === "uncertain");
		let decision = decideNativeAdmission(
			submission,
			records,
			{
				...policy,
				waitingWorkIds: [...new Set([...policy.waitingWorkIds, ...waits.waitingWorkIds])],
				recoveryBlocked,
			},
			this.session,
			phase,
			input,
		);
		if (this.options.admit && !recoveryBlocked) {
			try {
				decision = (await this.options.admit(
					structuredClone(submission),
					branch,
					phase,
					input ? structuredClone(input) : undefined,
				))
					? { allowed: true }
					: { allowed: false, reason: "Input is held by host admission policy." };
			} catch (error) {
				await branch.attachment.submissions.recordAdmission(
					submission.id,
					records.find((record) => record.id === submission.id)?.revision ?? 0,
					{ phase, ...(input?.queue ? { queue: input.queue } : {}) },
					"Host admission policy failed; review input before retry.",
				);
				throw error;
			}
		}
		// A boolean host override supplies no authority to bypass a durable dependency wait.
		const durableWaitDecision = () => {
			if (this.automaticReleaseRunning && this.semanticReleaseRequested && !isNativeUserInput(submission))
				return { allowed: false, reason: "Input is waiting for updated semantic admission." } as const;
			const currentWaits = branch.attachment.waits.gate();
			if (!currentWaits.updating && currentWaits.waitingWorkIds.length === 0) return { allowed: true } as const;
			return decideNativeAdmission(
				submission,
				records,
				{ userPending: false, recoveryBlocked: currentWaits.updating, waitingWorkIds: currentWaits.waitingWorkIds },
				session,
				phase,
				input,
			);
		};
		const waitDecision = durableWaitDecision();
		if (!waitDecision.allowed) decision = waitDecision;
		if (this.nativeRecoveryBlocked(submission, branch, phase))
			decision = { allowed: false, reason: "Input is waiting for recovery reconciliation." };
		const current = records.find((record) => record.id === submission.id);
		if (!current) return false;
		const saved = await branch.attachment.submissions.recordAdmission(
			submission.id,
			current.revision,
			{ phase, ...(input?.queue ? { queue: input.queue } : {}) },
			decision.allowed ? undefined : decision.reason,
		);
		if (!saved && phase === "submission")
			throw new FlowLedgerError("stale", "Retained input changed during admission.");
		return (
			saved &&
			decision.allowed &&
			durableWaitDecision().allowed &&
			!this.nativeRecoveryBlocked(submission, branch, phase)
		);
	}

	branch(): PiFlowBranchResources {
		if (this.disposed || this.fenced || !this.service)
			throw new FlowLedgerError("stale", "Flow ingress is not attached to an active branch.");
		return this.service.branch();
	}
	private track<T>(run: () => Promise<T>, id?: string): Promise<T> {
		const frame = { active: true, id };
		const operation = this.frames.run(frame, run);
		this.active.add(operation);
		void operation
			.finally(() => {
				frame.active = false;
				this.active.delete(operation);
			})
			.catch(() => {});
		return operation;
	}
	submit(submission: Submission, dispatch: () => Promise<void>): Promise<void> {
		const captured = structuredClone(submission);
		const user = isNativeUserInput(captured);
		if (user) this.activeUserInput++;
		return this.track(async () => {
			const branch = this.branch();
			const saved = await branch.attachment.submissions.retain(captured);
			if (this.branch() !== branch) throw new FlowLedgerError("stale", "Flow submission branch changed.");
			if (saved.duplicate || saved.status === "cancelled") return;
			const contextId = (captured.args[0] as { details?: { waitContextId?: string } } | undefined)?.details
				?.waitContextId;
			const context = contextId ? this.waitContexts.get(contextId) : undefined;
			if (
				context &&
				captured.api === "sendCustomMessage" &&
				context.branch === branch &&
				isDeepStrictEqual(context.args, captured.args)
			) {
				if (context.used) throw new FlowLedgerError("stale", "Wait context callback was already used.");
				context.used = true;
				await branch.native.dispatch(saved.id, saved.revision, captured.id, dispatch);
				context.completed = true;
				return;
			}
			if (user) this.retainedUserInput.add(saved.id);
			this.pending.set(saved.id, { branch, submission: captured, revision: saved.revision, dispatch });
			try {
				await this.release(saved.id, saved.revision);
			} catch (error) {
				// Pi revokes a callback when its submission handler throws.
				this.pending.delete(saved.id);
				throw error;
			}
		}).finally(() => {
			if (user) this.activeUserInput--;
		});
	}
	private async userWaitContext(
		branch: PiFlowBranchResources,
		includeDecisions = true,
		forceEmpty = false,
	): Promise<string | undefined> {
		const session = this.session!;
		const signal = new AbortController().signal;
		const capturedAt = this.options.autoRelease?.clock?.now() ?? Date.now();
		if (!Number.isSafeInteger(capturedAt) || capturedAt < 0)
			throw new FlowLedgerError("schema", "Invalid wait context time.");
		const waits = await branch.attachment.waits.snapshot();
		const live = waits
			.filter((wait) => wait.state === "waiting")
			.map((wait) => ({
				token: wait.token,
				work: wait.workId,
				reason: wait.reason,
				mode: wait.mode,
				on: wait.on,
				unmet: wait.unmet,
				createdAt: wait.createdAt,
				expiresAt: wait.expiresAt,
				elapsedMs: Math.max(0, capturedAt - wait.createdAt),
				health: "deadline-only",
			}));
		const source = createFlowWaitDecisionProducer(
			{ snapshot: async () => structuredClone(waits) },
			{
				submissions: branch.attachment.submissions,
				requests: branch.attachment.nativeRequests,
			},
		);
		const ledger = await branch.attachment.ledger.snapshot();
		const candidates = (await source.snapshot(signal)).filter((intent) => !retainedByReceipt(intent, ledger));
		let clearPrevious = false;
		if ((!forceEmpty || !waits.length) && !candidates.length && !live.length) {
			for (const message of [...session.agent.state.messages].reverse()) {
				if (
					message.role !== "custom" ||
					message.customType !== "jouzu-wait-context" ||
					typeof message.content !== "string"
				)
					continue;
				try {
					const prior = JSON.parse(message.content);
					clearPrevious =
						(Array.isArray(prior.liveWaits) && prior.liveWaits.length > 0) ||
						(Number.isSafeInteger(prior.remainingLiveWaits) && prior.remainingLiveWaits > 0);
				} catch {
					/* Ordinary context is not a wait snapshot. */
				}
				break;
			}
			if (!clearPrevious) return undefined;
		}
		const selected: FlowInputItem[] = [];
		const selectedLive: typeof live = [];
		const encode = (items: FlowInputItem[], liveItems = selectedLive) =>
			JSON.stringify({
				capturedAt,
				scope: branch.scope,
				guidance:
					"Use the latest wait snapshot for this branch. Status questions do not renew deadlines. Continue only work independent of live dependencies.",
				liveWaits: liveItems,
				remainingLiveWaits: live.length - liveItems.length,
				waitDecisions: items,
				remainingWaitDecisions: candidates.length - items.length,
			});
		for (const wait of live) {
			if (Buffer.byteLength(encode(selected, [...selectedLive, wait])) <= this.options.maxInputBytes)
				selectedLive.push(wait);
		}
		for (const intent of includeDecisions ? candidates : []) {
			if (this.branch() !== branch) throw new FlowLedgerError("stale", "User wait context branch changed.");
			const item = await source.build(intent, signal);
			if (Buffer.byteLength(encode([...selected, item])) <= this.options.maxInputBytes) selected.push(item);
		}
		const content = encode(selected);
		if (Buffer.byteLength(content) > this.options.maxInputBytes)
			throw new FlowLedgerError("capacity", "Wait context summary exceeds the input limit.");
		if (this.branch() !== branch) throw new FlowLedgerError("stale", "User wait context branch changed.");
		return content;
	}
	private async appendUserWaitContext(branch: PiFlowBranchResources): Promise<boolean> {
		const session = this.session;
		if (!session?.isIdle || session.isStreaming || session.isRetrying || session.isCompacting) return false;
		const content = await this.userWaitContext(branch);
		if (content === undefined) return false;
		const id = randomUUID();
		const message = { customType: "jouzu-wait-context", content, display: false, details: { waitContextId: id } };
		const options = { triggerTurn: false };
		const context = { branch, args: structuredClone([message, options]), used: false, completed: false };
		this.waitContexts.set(id, context);
		try {
			await session.sendCustomMessage(message, options);
			if (!context.completed) throw new FlowLedgerError("identity", "Wait context lacks a completed native append.");
			return true;
		} finally {
			this.waitContexts.delete(id);
		}
	}

	/** Release only a live retained callback after the host's ordinary admission policy succeeds. */
	release(id: string, revision: number): Promise<boolean> {
		const branch = this.branch();
		const pending = this.pending.get(id);
		if (!pending || pending.revision !== revision || pending.branch !== branch)
			return Promise.reject(new FlowLedgerError("stale", "Retained send has no matching live dispatch callback."));
		if (this.frames.getStore()?.active && this.frames.getStore()?.id === id)
			return Promise.reject(new FlowLedgerError("busy", "Flow admission cannot release its own pending send."));
		if (pending.running) return pending.running;
		const run = this.track(async () => {
			if (!(await this.admit(structuredClone(pending.submission), branch, "submission"))) return false;
			if (this.branch() !== branch || this.pending.get(id) !== pending)
				throw new FlowLedgerError("stale", "Retained send changed during admission.");
			if (this.nativeRecoveryBlocked(pending.submission, branch, "submission")) return false;
			// Remove before dispatch so a reentrant release cannot consume the callback twice.
			const user = isNativeUserInput(pending.submission);
			if (user && pending.submission.api === "prompt" && (await this.appendUserWaitContext(branch))) {
				if (!(await this.admit(structuredClone(pending.submission), branch, "submission"))) return false;
			}
			if (this.branch() !== branch || this.pending.get(id) !== pending)
				throw new FlowLedgerError("stale", "User dispatch changed during context preparation.");
			if (user) this.activeUserInput++;
			this.pending.delete(id);
			try {
				await branch.native.dispatch(id, revision, pending.submission.id, pending.dispatch);
				await this.refreshUserInput();
				return true;
			} finally {
				if (user) this.activeUserInput--;
			}
		}, id);
		pending.running = run;
		void run
			.finally(() => {
				pending.running = undefined;
			})
			.catch(() => {});
		return run;
	}
	/** Release at most one eligible live callback; new arrivals belong to a later pass. */
	releaseReady(): Promise<{ released: string[]; held: string[] }> {
		const branch = this.branch();
		if (this.frames.getStore()?.active)
			return Promise.reject(new FlowLedgerError("busy", "Flow release cannot run from its own admission or dispatch."));
		if (this.releasing) return this.releasing;
		const candidates = [...this.pending.entries()]
			.filter(([, pending]) => pending.branch === branch)
			.sort(([, a], [, b]) => Number(isNativeUserInput(b.submission)) - Number(isNativeUserInput(a.submission)));
		const run = this.track(async () => {
			const result: { released: string[]; held: string[] } = { released: [], held: [] };
			for (const [id, pending] of candidates) {
				if (this.branch() !== branch) throw new FlowLedgerError("stale", "Flow release branch changed.");
				if (this.pending.get(id) !== pending) continue;
				if (await this.release(id, pending.revision)) {
					result.released.push(id);
					break;
				}
			}
			result.held = candidates.filter(([id, pending]) => this.pending.get(id) === pending).map(([id]) => id);
			return result;
		});
		this.releasing = run;
		void run
			.finally(() => {
				if (this.releasing === run) this.releasing = undefined;
			})
			.catch(() => {});
		return run;
	}

	/** Retire an undispatched instruction and its live callback without starting host work. */
	cancelRetained(id: string, revision: number) {
		const branch = this.branch();
		return this.track(async () => {
			const result = await branch.attachment.submissions.cancelPending(id, revision);
			if (result.kind === "cancelled") {
				this.retainedUserInput.delete(id);
				const pending = this.pending.get(id);
				if (pending?.branch === branch) this.pending.delete(id);
			}
			return result;
		});
	}

	async beforeBranchChange(): Promise<void> {
		if (this.frames.getStore()?.active)
			throw new FlowLedgerError("busy", "Flow ingress cannot navigate from its own admission or dispatch.");
		const service = this.service;
		this.branch();
		this.fenced = true;
		this.stopReleaseNotifications();
		await Promise.allSettled([...this.active]);
		this.pending.clear();
		await service?.beforeBranchChange();
	}
	async branchChanged(): Promise<void> {
		if (this.disposed || !this.fenced || !this.service)
			throw new FlowLedgerError("stale", "Flow branch change is not prepared.");
		await this.service.branchChanged();
		if (!this.disposed) {
			this.fenced = false;
			await this.refreshUserInput();
			await this.startScheduling();
		}
	}
	dispose(): Promise<void> {
		if (this.frames.getStore()?.active)
			return Promise.reject(
				new FlowLedgerError("busy", "Flow ingress cannot close from its own admission or dispatch."),
			);
		this.disposed = true;
		this.fenced = true;
		this.stopReleaseNotifications();
		this.closing ??= (async () => {
			await this.opening?.catch(() => {});
			await Promise.allSettled([...this.active]);
			this.pending.clear();
			await this.service?.close();
		})();
		return this.closing;
	}
}
