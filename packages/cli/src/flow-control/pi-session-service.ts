import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { CatalogMessageId, catalogText, defaultCatalog } from "../cli-messages.js";
import type { CatalogBundle } from "../locale-catalog.js";
import type { FlowAdmissionGates } from "./admission.js";
import { retainAutomaticWork } from "./automatic-work.js";
import { SessionFlowController } from "./controller.js";
import { isNativeUserInput, isUserInstruction } from "./native-admission.js";
import { reconcileNativeSources } from "./native-source-reconciliation.js";
import { FlowOwnership } from "./ownership.js";
import { PiFlowAttachment } from "./pi-attachment.js";
import {
	bindPiFlowBranch,
	bindPiFlowInitialMarker,
	completePiFlowNavigation,
	piTranscriptBranchOwners,
} from "./pi-branch-binding.js";
import { PiControllerHost, type PiControllerHostOptions } from "./pi-controller-host.js";
import { recoverPiHistory } from "./pi-history-recovery.js";
import { PiNativeDispatch } from "./pi-native-dispatch.js";
import { PiNavigationGuard } from "./pi-navigation-guard.js";
import { type NativeContextDecorator, PiNativeRequests } from "./pi-native-requests.js";
import { PiFlowSessionRegistry } from "./pi-session-registry.js";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";
import { cancellationSettledSubmission, type FlowNativeInput, type RetainedSubmission } from "./submission-store.js";
import { captureUserWorkParticipants, consumedUserWork, userWorkId } from "./user-work.js";
import { finishedUserWork } from "./user-work-retention.js";
import type { FlowWorkStatus } from "./wait-authority.js";
import { createFlowWaitDecisionProducer, observedFlowWaits, retainedWaitDecisionIds } from "./wait-decisions.js";
import type { FlowWaitState } from "./wait-state.js";

import { FlowWorkContext } from "./work-context.js";

/** Branch records the automatic idle pass keeps. The registry is a mechanism; this is the policy. */
const retainedBranches = 64;

export interface PiFlowSessionOptions {
	/** Set only when attaching at the SDK creation boundary, before extensions can replace the stream. */
	qualifyProviderRoute?: boolean;
	root: string;
	/** Reported once when state written under an earlier record shape is moved aside on open. */
	onIsolatedState?(path: string): void;
	/** Reported once when a registry from an earlier version is dropped and rebuilt from the transcript. */
	onRebuiltRegistry?(droppedStatePath?: string): void;
	/** Turn-level signals the session acts on as a whole; see `PiNativeRequests`. */
	turn?: { aborted(): void; failed?(error: unknown): void; providerFailed?(detail: string): void };
	/** Flow control is on. While it is off, request-level holds are recorded but not enforced. */
	flowEnabled?(): boolean;
	maxInputBytes: number;
	maxResultBytes: number;
	/** Host-approved producer participants for work created from user input. */
	userWorkParticipants?: readonly string[];
	host: Omit<PiControllerHostOptions, "results" | "invokeWork" | "revokeWork" | "consumeWork" | "invokeOperation">;
	decorateNativeContext?: NativeContextDecorator;
	admitNativeQueue?(record: RetainedSubmission, input: FlowNativeInput): Promise<boolean>;
	policy(): Omit<FlowAdmissionGates, "hostReady">;
	/** Register branch-owned sources before retained executions are reconciled. */
	attachWaitSources?(attachment: PiFlowAttachment): Promise<void>;
	/** The resolved catalog every flow reason and tool label reads its text from. */
	catalog?: CatalogBundle;
	/** Release producer delivery leases while flow control is off; the producers then deliver natively. */
	detachProducers?(): Promise<void>;
	/** Re-acquire those leases when flow control comes back on. */
	reattachProducers?(): Promise<void>;
}
export interface PiFlowBranchResources {
	scope: Readonly<FlowScope>;
	attachment: PiFlowAttachment;
	host: PiControllerHost;
	controller: SessionFlowController;
	workContext: FlowWorkContext;
	native: PiNativeDispatch;
	requests: PiNativeRequests;
	recovery: { recovered: number; unresolved: number };
	sourceRecovery: { recovered: number; unresolved: number };
	waitSourceRecovery: { restored: number; missing: string[] };
}

/** The branch and request state the user confirmed for a non-destructive release. */
export interface PiFlowClearExpectation {
	branch: PiFlowBranchResources;
	requests: string;
}

/** Whether the transcript holds a message, or a branch marker an earlier attachment wrote. */
function hasConversation(session: AgentSession): boolean {
	return session.sessionManager
		.getEntries()
		.some(
			(entry) =>
				entry.type === "message" ||
				(entry.type === "custom" && (entry as { customType?: string }).customType === "jouzu-flow-branch"),
		);
}

/** Own session storage and each branch controller across awaited Pi lifecycle callbacks. */
export class PiFlowSessionService {
	private current?: PiFlowBranchResources;
	private opening?: {
		attachment: PiFlowAttachment;
		host?: PiControllerHost;
		native?: PiNativeDispatch;
		requests?: PiNativeRequests;
	};
	private transitionId?: string;
	private closing = false;
	// Ledger uncertainty is part of the controller's recovery gate, and the ledger can change it after
	// the branch was opened. The gate is synchronous, so the last read is kept here.
	private outcomeUnresolved = false;
	private storing?: Promise<void>;
	private readonly trustedStream?: AgentSession["agent"]["streamFunction"];
	private readonly navigation: PiNavigationGuard;
	private constructor(
		private readonly session: AgentSession,
		private readonly registry: PiFlowSessionRegistry,
		private readonly options: PiFlowSessionOptions,
	) {
		this.trustedStream = options.qualifyProviderRoute ? session.agent.streamFunction : undefined;
		// Install before branch hooks so closing a branch restores these guards, not bare native methods.
		this.navigation = new PiNavigationGuard(session);
	}

	static async open(session: AgentSession, options: PiFlowSessionOptions): Promise<PiFlowSessionService> {
		if (
			![options.maxInputBytes, options.maxResultBytes, options.host.maxPayloadBytes].every(
				(limit) => Number.isSafeInteger(limit) && limit > 0,
			)
		)
			throw new FlowLedgerError("capacity", "Invalid session flow limits.");
		if (!session.isIdle || session.agent.state.isStreaming || session.isRetrying || session.isCompacting)
			throw new FlowLedgerError("busy", "Session flow attachment requires an idle Pi session.");
		const captured = {
			...options,
			userWorkParticipants: captureUserWorkParticipants(options.userWorkParticipants),
			host: { ...options.host },
		};
		// A session with no conversation and no flow storage has nothing to recover. Its flow state stays
		// in memory until `store`, so a session that is opened and closed unused leaves no files.
		const deferred = !hasConversation(session) && !PiFlowSessionRegistry.exists(options.root, session.sessionId);
		const registry = await PiFlowSessionRegistry.open(
			options.root,
			session.sessionId,
			session.sessionManager.getLeafId(),
			undefined,
			deferred,
		);
		let service: PiFlowSessionService | undefined;
		try {
			const attached = new PiFlowSessionService(session, registry, captured);
			service = attached;
			await registry.run(async () => {
				const scope = await bindPiFlowBranch(
					registry,
					session.sessionManager,
					(path) => captured.onRebuiltRegistry?.(path),
					deferred,
					(branchId) => FlowOwnership.hasRecords(options.root, { sessionId: session.sessionId, branchId }),
				);
				await attached.openBranch(scope, deferred);
			});
			// From here on, the first thing the session records writes its flow state first. A session
			// that is closed without recording anything leaves nothing behind.
			if (deferred)
				attached.branch().attachment.storeBeforeFirstWrite(() => (attached.closing ? Promise.resolve() : attached.store()));
			return attached;
		} catch (error) {
			try {
				if (service) await service.close();
				else await registry.close(async () => {});
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Session flow attachment failed to close.");
			}
			throw error;
		}
	}

	branch(): PiFlowBranchResources {
		if (this.closing || this.transitionId || !this.current)
			throw new FlowLedgerError("stale", "Session flow branch is not attached.");
		if (this.session.sessionId !== this.current.scope.sessionId)
			throw new FlowLedgerError("scope", "Pi session changed outside the flow lifecycle.");
		return this.current;
	}

	/** Whether this session's flow state is on disk. A new session's state is in memory until `store`. */
	get stored(): boolean {
		const attachment = this.current?.attachment ?? this.opening?.attachment;
		return this.registry.stored && (!attachment || attachment.stored);
	}

	/**
	 * Write a new session's flow state the first time it records something: take its locks, then the
	 * branch marker in the Pi transcript, then the registry and branch records that point to it. A
	 * process that loses the session to another one fails before it writes anything. Idempotent.
	 */
	store(): Promise<void> {
		if (this.stored) return Promise.resolve();
		this.storing ??= this.registry
			.run(async () => {
				const attachment = this.branch().attachment;
				this.registry.claimStorage();
				attachment.claimStorage();
				await bindPiFlowInitialMarker(this.registry, this.session.sessionManager);
				await this.registry.materialize();
				await attachment.materialize();
			})
			.finally(() => {
				this.storing = undefined;
			});
		return this.storing;
	}

	private async openBranch(scope: FlowScope, deferred = false): Promise<void> {
		const attachment = await PiFlowAttachment.open(
			this.options.root,
			scope,
			undefined,
			(path) => this.options.onIsolatedState?.(path),
			this.options.catalog,
			deferred,
		);
		this.opening = { attachment };
		try {
			await this.options.attachWaitSources?.(attachment);
			const waitSourceRecovery = await attachment.waitProducers.restorePending();
			const recovery = await recoverPiHistory(this.session.sessionManager, attachment.ledger);
			const state = await attachment.ledger.snapshot();

			this.outcomeUnresolved = state.attempts.some((attempt) => attempt.phase === "uncertain");
			await attachment.submissions.archiveCompleted();
			await attachment.submissions.recoverCallbacks();
			const native = new PiNativeDispatch(
				this.session,
				attachment.submissions,
				this.options.admitNativeQueue,
				() => this.options.flowEnabled?.() !== false,
				this.options.catalog,
			);
			this.opening.native = native;
			const sourceRecovery = await native.recoverSources();
			await reconcileNativeSources(this.session, attachment, native);
			const requests = new PiNativeRequests(
				this.session,
				attachment.nativeRequests,
				this.options.host.maxPayloadBytes,
				(messages) => native.sources(messages),
				true,
				() => native.consumedSources(),
				this.options.decorateNativeContext,
				this.trustedStream,
				// Host-assigned origin and command provenance decide which operations are user instruction.
				// Nothing here reads message content, so no label or marker can claim to be the user.
				async () =>
					new Set(
						(await attachment.submissions.snapshot())
							.filter((record) => isUserInstruction(record.submission))
							.map((record) => record.dispatch?.operationId)
							.filter((id): id is string => !!id),
					),
				this.options.turn,
				() => reconcileNativeSources(this.session, attachment, native),
				// Turning flow control off releases a recovery hold's grip on the session's own sends.
				() => this.options.flowEnabled?.() !== false,
				() => this.retireUnreferencedRequests(this.branch()),
				this.options.catalog,
			);
			this.opening.requests = requests;
			const workContext = new FlowWorkContext(
				() => this.branch().attachment,
				// Capture this branch's attachment directly: `this.branch()` is unavailable while a
				// navigation transition is still open during `branchChanged`.
				() => retainAutomaticWork(attachment),
			);
			const host = new PiControllerHost(
				this.session,
				attachment.ledger,
				{
					...this.options.host,
					results: attachment.results,
					invokeWork: (id, invoke) => workContext.runSelected(id, invoke),
					invokeOperation: (invoke) => workContext.withOperation(invoke),
					flowEnabled: () => this.options.flowEnabled?.() !== false,
					revokeWork: () => workContext.revoke(),
					consumeWork: async (claimed) => {
						const work = await consumedUserWork(attachment, claimed, this.options.userWorkParticipants);
						if (work) await workContext.selectToolWork(work);
					},
				},
				() => {
					const policy = this.options.policy();
					const waits = attachment.waits.gate();
					return {
						...policy,
						waitingWorkIds: [...new Set([...policy.waitingWorkIds, ...waits.waitingWorkIds])],
						inactiveWorkIds: [...new Set([...(policy.inactiveWorkIds ?? []), ...waits.inactiveWorkIds])],
						isWorkRetired: (id) => !!policy.isWorkRetired?.(id) || waits.isWorkRetired(id),
						recoveryBlocked:
							waits.updating ||
							attachment.waitProducers.updating ||
							this.outcomeUnresolved ||
							waitSourceRecovery.missing.length > 0 ||
							recovery.unresolved > 0 ||
							sourceRecovery.unresolved > 0 ||
							attachment.nativeRequests.recoveryBlocked ||
							policy.recoveryBlocked,
					};
				},
			);
			this.opening.host = host;
			// One observer wraps the transport and records both projections, so there is no second
			// wrapper to order against and the guarded transport is stable as soon as it is installed.
			requests.attachComposition(host.requests);
			requests.sealTransport();
			const controller = new SessionFlowController(
				host,
				this.options.maxInputBytes,
				this.options.maxResultBytes,
				this.options.catalog,
			);
			controller.register(
				createFlowWaitDecisionProducer(attachment.waits, {
					ledger: attachment.ledger,
					submissions: attachment.submissions,
					requests: attachment.nativeRequests,
				}),
			);
			this.current = {
				scope: Object.freeze({ ...scope }),
				attachment,
				host,
				controller,
				workContext,
				native,
				requests,
				recovery,
				sourceRecovery,
				waitSourceRecovery,
			};
			// Register the branch host identity before producers can start, so a producer that runs
			// without a selected work still has a registered default to attribute to.
			await workContext.attach();
			this.opening = undefined;
		} catch (error) {
			// A failed host close must retain its storage ownership.
			await this.closeBranch();
			throw error;
		}
	}

	/**
	 * One retirement policy over one idle reservation. The phases run in dependency order — waits,
	 * submissions, requests, ledger, results — because each later phase reads evidence the earlier one
	 * may retire. A phase that cannot run right now is skipped rather than failing the pass, which is
	 * what the five separate callers did between them; running them together means one reservation,
	 * one ownership check, and one busy semantics instead of five.
	 */
	async retireFlowHistory(): Promise<number> {
		// A session whose state is still in memory has recorded nothing, so it has no history to retire.
		if (!this.stored) return 0;
		const phases: (() => Promise<number>)[] = [
			async () => {
				const { work, executions, waits } = await this.retireWaitHistory(true);
				return work + executions + waits;
			},
			() => this.archiveSubmissionHistory(),
			() => this.retireRequestHistory(),
			() => this.retireLedgerHistory(),
			() => this.retireResultHistory(),
		];
		let retired = 0;
		for (const phase of phases) {
			try {
				retired += await phase();
			} catch (error) {
				// Busy or stale means this phase has nothing it may safely retire yet; a later idle pass
				// takes it. Any other failure is a real fault and belongs to the caller.
				if (!(error instanceof FlowLedgerError) || !["busy", "stale"].includes(error.code)) throw error;
			}
		}
		return retired;
	}

	retireRequestHistory() {
		return this.registry.run(async () => {
			const branch = this.branch();
			const result = await branch.host.atIdle(async () => {
				if (this.branch() !== branch) throw new FlowLedgerError("stale", "Request retirement branch changed.");
				if ((await branch.attachment.ledger.snapshot()).activeAttemptId)
					throw new FlowLedgerError("busy", "Request retirement requires settled controller work.");
				return this.retireUnreferencedRequests(branch);
			});
			if (result.kind === "busy") throw new FlowLedgerError("busy", "Request retirement requires an idle session.");
			return result.value;
		});
	}

	/** Also runs at a serialized request checkpoint, where a tool sequence need not be idle. */
	private async retireUnreferencedRequests(branch: PiFlowBranchResources): Promise<number> {
		// Reconcile producer observations before removing their successful request evidence.
		const references = await branch.controller.retentionReferences();
		const superseded = await branch.attachment.nativeRequests.retireSuperseded();
		const live = new Set(
			(await branch.attachment.submissions.snapshot(false))
				.map((record) => record.dispatch?.operationId)
				.filter((id): id is string => !!id),
		);
		const liveWaits = new Set((await branch.attachment.waits.snapshot()).map((wait) => wait.token));
		const protectedRequests = new Set<string>();
		for (const request of await branch.attachment.nativeRequests.snapshot()) {
			const messages = (request.projectionCapture?.members ?? []).map((member) => member.message);
			if (
				branch.controller.observationProjections(messages).length ||
				request.waitTokens?.some((token) => liveWaits.has(token))
			)
				protectedRequests.add(request.id);
		}
		return superseded + await branch.attachment.nativeRequests.retireHistory(undefined, live, protectedRequests, () => {
			if (this.branch() !== branch) throw new FlowLedgerError("stale", "Request retirement branch changed.");
			references.assertCurrent();
		});
	}

	/** Fold settled controller attempts into their carried fences, counters, and producer round. */
	retireLedgerHistory(keep?: number) {
		return this.registry.run(async () => {
			const branch = this.branch();
			const result = await branch.host.atIdle(async () => {
				if (this.branch() !== branch) throw new FlowLedgerError("stale", "Ledger retirement branch changed.");
				if ((await branch.attachment.ledger.snapshot()).activeAttemptId)
					throw new FlowLedgerError("busy", "Ledger retirement requires settled controller work.");
				const references = await branch.controller.retentionReferences();
				const protectedMembers = retainedWaitDecisionIds(await branch.attachment.waits.snapshot());
				for (const id of references.resultIds) protectedMembers.add(JSON.parse(id)[1]);
				return branch.attachment.ledger.retire(keep, protectedMembers, () => references.assertCurrent());
			});
			if (result.kind === "busy") throw new FlowLedgerError("busy", "Ledger retirement requires an idle session.");
			return result.value;
		});
	}

	/** Preserve live manifest references while retiring unreferenced result history and branch ancestry. */
	retireResultHistory(keepManifests?: number, keepBranches?: number) {
		return this.registry.run(async () => {
			const branch = this.branch();
			const result = await branch.host.atIdle(async () => {
				if (this.branch() !== branch) throw new FlowLedgerError("stale", "Result retirement branch changed.");
				const references = await branch.controller.retentionReferences();
				const retained = JSON.stringify([
					this.session.messages,
					await branch.attachment.ledger.snapshot(),
					await branch.attachment.submissions.snapshot(),
				]);
				const manifests = await branch.attachment.results.retire(
					keepManifests,
					new Set(retained.match(/flow-results:[a-f0-9]{64}/g) ?? []),
					references.resultIds,
					() => references.assertCurrent(),
				);
				// Branches a restart or reattachment can still land on must survive retirement:
				// a restart reopens at the newest transcript entry and binds by its marker.
				return (
					manifests +
					(await this.registry.retireBranchHistory(
						keepBranches ?? retainedBranches,
						piTranscriptBranchOwners(this.session.sessionManager),
					))
				);
			});
			if (result.kind === "busy") throw new FlowLedgerError("busy", "Result retirement requires an idle session.");
			return result.value;
		});
	}

	/** Keep handled user source evidence available while freeing active submission capacity. */
	archiveSubmissionHistory() {
		return this.registry.run(async () => {
			const branch = this.branch();
			const result = await branch.host.atIdle(async () => {
				const attachment = branch.attachment;
				if ((await attachment.ledger.snapshot()).activeAttemptId || attachment.nativeRequests.recoveryBlocked)
					throw new FlowLedgerError("busy", "Submission archival requires settled requests.");
				const { isWorkRetired } = attachment.waits.gate();
				const selected = (await attachment.submissions.snapshot(false)).filter(
					(record) =>
						cancellationSettledSubmission(record) ||
						(isNativeUserInput(record.submission) &&
							isWorkRetired(userWorkId(branch.scope, record.id, record.revision))),
				);
				return attachment.submissions.archiveHandled(
					selected.map(({ id, revision }) => ({ id, revision })),
					() => {
						if (this.branch() !== branch || attachment.waits.gate().updating)
							throw new FlowLedgerError("stale", "Submission archival ownership changed.");
					},
				);
			});
			if (result.kind === "busy") throw new FlowLedgerError("busy", "Submission archival requires an idle session.");
			return result.value;
		});
	}

	/** Retire observed wait history while native execution and queue mutation are fenced. */
	retireWaitHistory(includeUserWork = false) {
		return this.registry.run(async () => {
			const branch = this.branch();
			const result = await branch.host.atIdle(async () => {
				if (this.branch() !== branch) throw new FlowLedgerError("stale", "Wait retirement branch changed.");
				const attachment = branch.attachment;
				const ledger = await attachment.ledger.snapshot();
				if (ledger.activeAttemptId || attachment.waitProducers.updating)
					throw new FlowLedgerError("busy", "Wait retirement requires settled work and producer evidence.");
				await attachment.waitProducers.closeTerminalSubscriptions();
				const waits = await observedFlowWaits(
					await attachment.waits.snapshot(),
					{
						submissions: attachment.submissions,
						requests: attachment.nativeRequests,
					},
					await attachment.waits.toolReceipts(),
					ledger,
				);
				const references = await branch.controller.retentionReferences();
				const authority = await attachment.waits.authoritySnapshot();
				const producerRetirement = attachment.waitProducers.retirementCandidates(authority.executions);
				const remainingWaits = (await attachment.waits.snapshot()).filter(
					(wait) => !waits.some((selected) => selected.token === wait.token && selected.workId === wait.workId),
				);
				const candidates = producerRetirement.executions.filter(
					(execution) =>
						!remainingWaits.some((wait) =>
							wait.on.some(
								(handle) => handle.producer === execution.producer && handle.execution === execution.execution,
							),
						),
				);
				const referenced = references.workIds;
				for (const execution of authority.executions)
					if (
						!candidates.some(
							(candidate) => candidate.producer === execution.producer && candidate.execution === execution.execution,
						)
					)
						referenced.add(execution.workId);
				for (const wait of remainingWaits) referenced.add(wait.workId);
				const finished = includeUserWork
					? finishedUserWork(
							authority.work,
							await attachment.submissions.snapshot(),
							await attachment.nativeRequests.snapshot(),
							referenced,
						)
					: [];
				const work = authority.work.filter(
					(item) =>
						!referenced.has(item.id) &&
						["completed", "stopped"].includes(item.lifecycle?.state ?? "active") &&
						!finished.some((user) => user.id === item.id),
				);
				const retiringWork = new Set([...work, ...finished].map((item) => item.id));
				// Keep observed predicates available to future waits while their owning work is active.
				const executions = candidates.filter((execution) => retiringWork.has(execution.workId));
				if (!waits.length && !finished.length && !work.length && !executions.length)
					return { work: 0, executions: 0, waits: 0 };
				return attachment.waits.retire({ waits, work, executions, finishedUserWork: finished }, () => {
					references.assertCurrent();
					producerRetirement.assertCurrent();
				});
			});
			if (result.kind === "busy") throw new FlowLedgerError("busy", "Wait retirement requires an idle session.");
			return result.value;
		});
	}

	/**
	 * Resolve an uncertain attempt on the user's instruction, then release the recovery gate it holds.
	 * The provider's receipt for such an attempt is unknowable locally, so this is the user's decision
	 * and never an automatic one.
	 */
	resolveUncertainAttempt(id: string, resolution: "retry" | "discard") {
		return this.registry.run(async () => {
			const branch = this.branch();
			const state = await branch.attachment.ledger.snapshot();
			const attempt = state.attempts.find((item) => item.id === id);
			if (!attempt || attempt.phase !== "uncertain")
				throw new FlowLedgerError("identity", "No uncertain attempt has that identity.");
			await branch.attachment.ledger.resolveUncertain(
				id,
				resolution,
				resolution === "retry"
					? catalogText(this.options.catalog ?? defaultCatalog(), CatalogMessageId.flowServiceResolvedUndelivered)
					: catalogText(this.options.catalog ?? defaultCatalog(), CatalogMessageId.flowServiceResolvedSpent),
			);
			await this.refreshOutcomeUnresolved(branch);
		});
	}

	/**
	 * Move the controller's recovery gate with the ledger after a user decision changes it. The
	 * ingress reads ledger uncertainty live on every admission, so a gate left behind would hold
	 * automated work for the rest of the attachment while the status report showed it resolved.
	 */
	private async refreshOutcomeUnresolved(branch: PiFlowBranchResources): Promise<void> {
		this.outcomeUnresolved = (await branch.attachment.ledger.snapshot()).attempts.some(
			(attempt) => attempt.phase === "uncertain",
		);
	}

	/** Release a stuck active reservation without deleting receipts or stopping producer jobs. */
	clearFlow(expected?: PiFlowClearExpectation) {
		return this.resetFlowImpl(false, undefined, expected);
	}

	/** Destructively reset flow delivery after an idle boundary; provider and producer jobs keep running. */
	resetFlow(onReset?: () => void) {
		return this.resetFlowImpl(true, onReset);
	}

	private resetFlowImpl(destructive: boolean, onReset?: () => void, expected?: PiFlowClearExpectation) {
		return this.registry.run(async () => {
			const branch = this.branch();
			if (expected && branch !== expected.branch)
				throw new FlowLedgerError("stale", "Flow release branch changed.");
			const reserve = destructive
				? branch.host.atQueueMaintenance.bind(branch.host)
				: branch.host.atIdle.bind(branch.host);
			const result = await reserve(async () => {
				if (this.branch() !== branch) throw new FlowLedgerError("stale", "Flow reset branch changed.");
				const state = await branch.attachment.ledger.snapshot();
				if (expected) {
					const requests = JSON.stringify(await branch.attachment.nativeRequests.snapshot());
					if (this.branch() !== expected.branch || requests !== expected.requests)
						throw new FlowLedgerError("stale", "Flow release confirmation changed.");
				}
				const attemptId = state.activeAttemptId;
				if (attemptId && !destructive)
					await branch.attachment.ledger.emergencyReset(
						attemptId,
						"Emergency flow release from /flow; provider outcome may be unknown.",
					);
				// A clear preserves evidence and reconciles it. A reset explicitly discards flow
				// delivery state after the idle boundary, so an unknown provider outcome cannot keep
				// the session blocked indefinitely.
				if (destructive) {
					branch.host.invalidate();
					branch.native.reset();
					await branch.attachment.waits.reset();
					await branch.attachment.ledger.reset();
					await branch.attachment.submissions.reset();
					onReset?.();
					this.outcomeUnresolved = false;
					Object.assign(branch.recovery, { recovered: 0, unresolved: 0 });
					Object.assign(branch.sourceRecovery, { recovered: 0, unresolved: 0 });
					Object.assign(branch.waitSourceRecovery, { restored: 0, missing: [] });
					branch.workContext.revoke();
					await branch.workContext.attach();
				} else {
					await this.refreshOutcomeUnresolved(branch);
					await branch.attachment.submissions.discardInterrupted();
					Object.assign(branch.sourceRecovery, await branch.native.recoverSources());
					await branch.attachment.submissions.archiveCompleted();
					await reconcileNativeSources(this.session, branch.attachment, branch.native, "reset");
				}
				const releasedRequests = await branch.attachment.nativeRequests.reset();
				await branch.attachment.nativeRequests.retireSuperseded();
				const ledgerAfter = await branch.attachment.ledger.snapshot();
				const waitRecoveryHeld = branch.waitSourceRecovery.missing.length > 0;
				const recoveryHeld = destructive
					? false
					: branch.host.gate().recoveryBlocked ||
						branch.attachment.nativeRequests.recoveryBlocked ||
						branch.recovery.unresolved > 0 ||
						branch.sourceRecovery.unresolved > 0 ||
						waitRecoveryHeld ||
						ledgerAfter.attempts.some((attempt) => attempt.phase === "uncertain");
				return {
					kind: attemptId ? ("cancelled" as const) : ("inactive" as const),
					attemptId,
					releasedRequests,
					recoveryHeld,
				};
			});
			if (result.kind === "busy") throw new FlowLedgerError("busy", "Flow reset requires an idle session.");
			if (result.value.kind !== "inactive" && result.value.attemptId)
				await branch.host.reconcile(result.value.attemptId);
			return result.value;
		});
	}

	/**
	 * Change a campaign's lifecycle on the user's behalf. The owner and revision are looked up rather
	 * than supplied, so a user cannot pause or stop work by guessing whose it is. Stopping also ends
	 * that work's live waits, and neither control stops the underlying job.
	 */
	changeWorkStatus(id: string, status: FlowWorkStatus, reason: string, now: number) {
		return this.registry.run(async () => {
			const waits = this.branch().attachment.waits;
			const work = (await waits.authoritySnapshot()).work.find((record) => record.id === id);
			if (!work) throw new FlowLedgerError("identity", "No registered work has that identity.");
			const current = work.lifecycle?.state ?? "active";
			if (current === status) return work;
			if (["stopped", "completed"].includes(current))
				throw new FlowLedgerError("transition", `Work is already ${current} and cannot change again.`);
			return waits.changeWork(id, work.owner, work.revision, status, reason, now);
		});
	}

	changeWork(id: string, owner: string, revision: number, status: FlowWorkStatus, reason: string, now: number) {
		return this.registry.run(() => this.branch().attachment.waits.changeWork(id, owner, revision, status, reason, now));
	}

	/**
	 * Cancel a live wait on the user's behalf. The wait's own producer stays its owner, so the
	 * owning work is looked up rather than supplied: a user cannot cancel a wait by guessing an
	 * owner. This removes the dependency gate only; the underlying job keeps running.
	 */
	cancelWait(token: string, reason: string, now: number): Promise<FlowWaitState> {
		return this.registry.run(async () => {
			const waits = this.branch().attachment.waits;
			const live = (await waits.snapshot()).find((wait) => wait.token === token);
			if (!live || live.state !== "waiting") throw new FlowLedgerError("stale", "Wait token is not live.");
			const work = (await waits.authoritySnapshot()).work.find((record) => record.id === live.workId);
			if (!work) throw new FlowLedgerError("identity", "Wait has no registered owning work.");
			return waits.cancelOwned(work.owner, work.revision, token, reason, now);
		});
	}

	/** Called by an explicit repair action; the next admitted request still applies content policy. */
	retryNativeRequest(id: string, expectedHash: string): Promise<void> {
		return this.registry.run(async () => {
			const branch = this.branch();
			const result = await branch.host.atIdle(async () => {
				if (this.branch() !== branch) throw new FlowLedgerError("stale", "Native retry branch changed.");
				await branch.attachment.nativeRequests.authorizeRetry(id, expectedHash);
			});
			if (result.kind === "busy") throw new FlowLedgerError("busy", "Native retry requires an idle session.");
		});
	}

	cancelNativeSources(id: string, expectedHash: string, indices: number[]): Promise<void> {
		const selected = [...indices];
		return this.registry.run(async () => {
			const branch = this.branch();
			const result = await branch.host.atIdle(async () => {
				if (this.branch() !== branch) throw new FlowLedgerError("stale", "Native cancellation branch changed.");
				await branch.attachment.nativeRequests.cancelSources(id, expectedHash, selected);
			});
			if (result.kind === "busy") throw new FlowLedgerError("busy", "Native cancellation requires an idle session.");
		});
	}

	cancelNativeProjections(id: string, expectedHash: string, indices: number[]): Promise<void> {
		const selected = [...indices];
		return this.registry.run(async () => {
			const branch = this.branch();
			const result = await branch.host.atIdle(async () => {
				if (this.branch() !== branch) throw new FlowLedgerError("stale", "Projection cancellation branch changed.");
				await branch.attachment.nativeRequests.cancelProjections(id, expectedHash, selected);
			});
			if (result.kind === "busy")
				throw new FlowLedgerError("busy", "Projection cancellation requires an idle session.");
		});
	}

	reconcileNativeQueueEdit(id: string, revision: number): Promise<void> {
		return this.registry.run(async () => {
			const branch = this.branch();
			const result = await branch.host.atQueueMaintenance(() => branch.native.reconcileQueueEdit(id, revision));
			if (result.kind === "busy")
				throw new FlowLedgerError("busy", "Native edit reconciliation requires an idle session.");
		});
	}

	cancelNativeQueue(id: string, revision: number): Promise<void> {
		return this.registry.run(async () => {
			const branch = this.branch();
			const result = await branch.host.atQueueMaintenance(() => branch.native.cancelQueue(id, revision));
			if (result.kind === "busy")
				throw new FlowLedgerError("busy", "Native queue cancellation requires an idle session.");
		});
	}

	cancelNativeContext(id: string, revision: number, inputIndex: number): Promise<void> {
		return this.registry.run(async () => {
			const branch = this.branch();
			const result = await branch.host.atQueueMaintenance(() => branch.native.cancelContext(id, revision, inputIndex));
			if (result.kind === "busy") throw new FlowLedgerError("busy", "Deferred cancellation requires an idle session.");
		});
	}

	private async closeBranch(): Promise<void> {
		const branch = this.current;
		if (branch) {
			await branch.controller.close();
			await branch.requests.close();
			await branch.native.close();
			await branch.attachment.close();
		} else if (this.opening) {
			await this.opening.host?.close();
			await this.opening.requests?.close();
			await this.opening.native?.close();
			await this.opening.attachment.close();
		}
		this.current = undefined;
		this.opening = undefined;
		this.outcomeUnresolved = false;
	}

	/** Called from Pi's prepared beforeBranchChange callback, with ingress fenced. */
	async beforeBranchChange(): Promise<void> {
		// Navigation records a transition against a stored branch.
		await this.store();
		return this.registry.run(async () => {
			const branch = this.branch();
			const state = await this.registry.snapshot();
			const manager = this.session.sessionManager;
			const transition = await this.registry.beginNavigation(
				state.revision,
				manager.getLeafId(),
				manager.getEntries().at(-1)?.id ?? null,
			);
			this.transitionId = transition.id;
			branch.host.handoffNavigation();
			await this.closeBranch();
		});
	}

	/** Live waits, read through the registry so a caller can end them from outside the branch scope. */
	parkedWaits() {
		return this.registry.run(async () => (this.current ? this.current.attachment.waits.snapshot() : []));
	}

	/** Persist navigation and attach its branch resources before Pi emits session_tree. */
	branchChanged(): Promise<void> {
		return this.registry.run(async () => {
			if (this.closing || !this.transitionId || this.current)
				throw new FlowLedgerError("transition", "Session flow navigation is not prepared.");
			const scope = await completePiFlowNavigation(this.registry, this.session.sessionManager, this.transitionId);
			await this.openBranch(scope);
			this.transitionId = undefined;
		});
	}

	close(): Promise<void> {
		this.closing = true;
		const closeStorage = () => this.registry.close(() => this.closeBranch()).then(() => this.navigation.close());
		// An admitted first save still needs the registry for its remaining writes. Fence new work
		// now, but let the save settle before the registry starts refusing operations.
		return this.storing ? this.storing.then(closeStorage, closeStorage) : closeStorage();
	}
}
