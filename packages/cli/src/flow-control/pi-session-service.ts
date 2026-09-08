import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { FlowAdmissionGates } from "./admission.js";
import { SessionFlowController } from "./controller.js";
import { PiFlowAttachment } from "./pi-attachment.js";
import { bindPiFlowBranch, completePiFlowNavigation } from "./pi-branch-binding.js";
import { PiControllerHost, type PiControllerHostOptions } from "./pi-controller-host.js";
import { recoverPiHistory } from "./pi-history-recovery.js";
import { PiNativeDispatch } from "./pi-native-dispatch.js";
import { type NativeContextDecorator, PiNativeRequests } from "./pi-native-requests.js";
import { PiFlowSessionRegistry } from "./pi-session-registry.js";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";
import type { FlowNativeInput, RetainedSubmission } from "./submission-store.js";
import { createFlowWaitDecisionProducer } from "./wait-decisions.js";

export interface PiFlowSessionOptions {
	root: string;
	maxInputBytes: number;
	maxResultBytes: number;
	host: Omit<PiControllerHostOptions, "results">;
	decorateNativeContext?: NativeContextDecorator;
	admitNativeQueue?(record: RetainedSubmission, input: FlowNativeInput): Promise<boolean>;
	policy(): Omit<FlowAdmissionGates, "hostReady">;
}
export interface PiFlowBranchResources {
	scope: Readonly<FlowScope>;
	attachment: PiFlowAttachment;
	host: PiControllerHost;
	controller: SessionFlowController;
	native: PiNativeDispatch;
	requests: PiNativeRequests;
	recovery: { recovered: number; unresolved: number };
	sourceRecovery: { recovered: number; unresolved: number };
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
	private constructor(
		private readonly session: AgentSession,
		private readonly registry: PiFlowSessionRegistry,
		private readonly options: PiFlowSessionOptions,
	) {}

	static async open(session: AgentSession, options: PiFlowSessionOptions): Promise<PiFlowSessionService> {
		if (
			![options.maxInputBytes, options.maxResultBytes, options.host.maxPayloadBytes].every(
				(limit) => Number.isSafeInteger(limit) && limit > 0,
			)
		)
			throw new FlowLedgerError("capacity", "Invalid session flow limits.");
		if (!session.isIdle || session.agent.state.isStreaming || session.isRetrying || session.isCompacting)
			throw new FlowLedgerError("busy", "Session flow attachment requires an idle Pi session.");
		const captured = { ...options, host: { ...options.host, projections: new Map(options.host.projections) } };
		const registry = await PiFlowSessionRegistry.open(
			options.root,
			session.sessionId,
			session.sessionManager.getLeafId(),
		);
		const service = new PiFlowSessionService(session, registry, captured);
		try {
			await registry.run(async () => {
				const scope = await bindPiFlowBranch(registry, session.sessionManager);
				await service.openBranch(scope);
			});
			return service;
		} catch (error) {
			try {
				await service.close();
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

	private async openBranch(scope: FlowScope): Promise<void> {
		const attachment = await PiFlowAttachment.open(this.options.root, scope);
		this.opening = { attachment };
		try {
			const recovery = await recoverPiHistory(this.session.sessionManager, attachment.ledger);
			const state = await attachment.ledger.snapshot();

			let recoveryBlocked = recovery.unresolved > 0 || state.attempts.some((attempt) => attempt.phase === "uncertain");
			const native = new PiNativeDispatch(this.session, attachment.submissions, this.options.admitNativeQueue);
			this.opening.native = native;
			const sourceRecovery = await native.recoverSources();
			recoveryBlocked ||= sourceRecovery.unresolved > 0;
			const requests = new PiNativeRequests(
				this.session,
				attachment.nativeRequests,
				this.options.host.maxPayloadBytes,
				(messages) => native.sources(messages),
				true,
				() => native.consumedSources(),
				this.options.decorateNativeContext,
			);
			this.opening.requests = requests;
			const host = new PiControllerHost(
				this.session,
				attachment.ledger,
				{ ...this.options.host, results: attachment.results },
				() => {
					const policy = this.options.policy();
					const waits = attachment.waits.gate();
					return {
						...policy,
						waitingWorkIds: [...new Set([...policy.waitingWorkIds, ...waits.waitingWorkIds])],
						recoveryBlocked:
							waits.updating || recoveryBlocked || attachment.nativeRequests.recoveryBlocked || policy.recoveryBlocked,
					};
				},
			);
			this.opening.host = host;
			const controller = new SessionFlowController(host, this.options.maxInputBytes, this.options.maxResultBytes);
			controller.register(
				createFlowWaitDecisionProducer(attachment.waits, {
					submissions: attachment.submissions,
					requests: attachment.nativeRequests,
				}),
			);
			this.current = {
				scope: Object.freeze({ ...scope }),
				attachment,
				host,
				controller,
				native,
				requests,
				recovery,
				sourceRecovery,
			};
			this.opening = undefined;
		} catch (error) {
			// A failed host close must retain its storage ownership.
			await this.closeBranch();
			throw error;
		}
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
	}

	/** Called from Pi's prepared beforeBranchChange callback, with ingress fenced. */
	beforeBranchChange(): Promise<void> {
		return this.registry.run(async () => {
			const branch = this.branch();
			const state = await this.registry.snapshot();
			const transition = await this.registry.beginNavigation(state.revision, this.session.sessionManager.getLeafId());
			this.transitionId = transition.id;
			branch.host.handoffNavigation();
			await this.closeBranch();
		});
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
		return this.registry.close(() => this.closeBranch());
	}
}
