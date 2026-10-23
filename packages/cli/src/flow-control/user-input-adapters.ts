import { createHash } from "node:crypto";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { PiFlowBranchResources } from "./pi-session-service.js";
import type { FlowSubmissionCursor } from "./submission-store.js";
import { checkUserInputAdapterGrant } from "./user-input-grants.js";
import { projectUserInputReceipt, type UserInputReceipt } from "./user-input-receipts.js";

type Ingress = NonNullable<CreateAgentSessionOptions["flowIngress"]>;
type Register = NonNullable<Ingress["registerUserInputAdapter"]>;
type Host = Parameters<Register>[0];
type Adapter = Awaited<ReturnType<Register>>;
type Submission = Parameters<Ingress["submit"]>[0];

export function userInputError(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identifier = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value);
function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((key) => !allowed.includes(key))
	)
		throw userInputError("invalid-input", "External input has unsupported fields.");
}
export interface UserInputOwner {
	agentDir?: string;
	branch(): PiFlowBranchResources;
	enabled(): boolean;
	liveQueue(): ReadonlyMap<string, number>;
	pending(id: string): boolean;
	retain(submission: Submission, digest: string, epoch: string, dispatch: () => Promise<void>): Promise<void>;
	onError(error: unknown): void;
}

/** Drop records a pass could not project, so the next pass asks the store for them again. */
function withoutRecords(cursor: FlowSubmissionCursor, ids: ReadonlySet<string>): FlowSubmissionCursor {
	const records = new Map(cursor.records);
	for (const id of ids) records.delete(id);
	return { ...cursor, records, retry: true };
}

/** Runtime-owned registration, validation and scoped receipt lookup. */
export class UserInputAdapters {
	private admission: Promise<unknown> = Promise.resolve();
	/** Admission is closed while a destructive reset rotates the external target epoch. */
	private barrier?: Promise<void>;
	private releaseBarrier?: () => void;
	private resetOwners = 0;
	private resetDrain?: Promise<unknown>;
	private readonly subscriptions = new Set<() => void>();
	/** Live registrations, keyed by loader identity and adapter ID. */
	private readonly registrations = new Map<string, { invalidate: () => void }>();
	private closed = false;
	/**
	 * Registration ownership generation. Ending the runtime or closing the registry advances it, so a
	 * registration still waiting for its grant decision, and every handle created earlier, is inert
	 * afterwards. The host fences its own callbacks, but registration cleanup runs before native reload
	 * invalidation, so host liveness alone cannot establish that this ownership has not ended.
	 */
	private lifetime = 0;
	constructor(private readonly owner: UserInputOwner) {}
	private serial<T>(run: () => Promise<T>): Promise<T> {
		// Capture the admission cohort at enqueue, not when the chained callback starts. A reset that
		// closes admission in the same tick must still drain work that was already queued behind the
		// previous cohort; otherwise that work waits for a reset that is waiting for it.
		const barrier = this.barrier;
		const operation = this.admission.then(async () => {
			if (barrier) await barrier;
			return run();
		});
		this.admission = operation.catch(() => {});
		return operation;
	}
	async drain(): Promise<void> {
		await this.admission;
	}
	/**
	 * Close external admission for a destructive reset, then drain what already started.
	 *
	 * A reset rotates the target epoch without replacing the attachment, so a submission that validated
	 * the previous target must not retain into the new journal or dispatch under the old binding. New work
	 * waits here; `endReset` reopens admission once the epoch has rotated.
	 */
	async beginReset(): Promise<void> {
		if (this.resetOwners++ === 0) {
			this.barrier = new Promise<void>((resolve) => {
				this.releaseBarrier = resolve;
			});
			// Later resets share this pre-barrier cohort, not submissions queued behind the barrier.
			this.resetDrain = this.admission;
		}
		await this.resetDrain;
	}
	endReset(): void {
		if (this.resetOwners === 0 || --this.resetOwners > 0) return;
		const release = this.releaseBarrier;
		this.barrier = undefined;
		this.releaseBarrier = undefined;
		this.resetDrain = undefined;
		release?.();
	}
	close(): void {
		this.closed = true;
		this.lifetime++;
		// Nothing can be admitted after close, so unfinished reset owners must not hold the drain.
		this.resetOwners = 1;
		this.endReset();
		this.clearSubscriptions();
		this.registrations.clear();
	}
	clearSubscriptions(): void {
		for (const unsubscribe of this.subscriptions) unsubscribe();
		this.subscriptions.clear();
	}
	/**
	 * The extension runtime that registered these adapters is ending, as an in-place reload replaces it.
	 *
	 * The host fences every handle the old runtime registered, so drop their subscriptions and
	 * registrations here and end the registration lifetime. A registration still waiting for its grant
	 * decision cannot insert afterwards, and the replacement runtime registers the identity again with its
	 * own live assertions. Retained records keep their own evidence: the owner ends the callbacks that
	 * never acquired dispatch intent.
	 */
	endRuntime(): void {
		this.lifetime++;
		this.clearSubscriptions();
		this.registrations.clear();
	}
	/** The runtime that created this handle, or started a registration, is still the owner. */
	private assertOwned(ownership: number): void {
		if (this.closed || ownership !== this.lifetime)
			throw userInputError("stale-target", "External input runtime ended.");
	}
	/** Report a listener failure without letting the reporting channel interrupt the notification. */
	private reportListenerError(error: unknown): void {
		try {
			this.owner.onError(error);
		} catch {
			// Notification is the contract here; a failing error channel must not stop later withdrawals.
		}
	}
	/** The stable target changed. Every published binding is stale and must be bound again. */
	invalidateTargets(): void {
		for (const registration of [...this.registrations.values()]) {
			try {
				registration.invalidate();
			} catch (error) {
				// One registration's failure, or a failing error report, must not skip the others.
				this.reportListenerError(error);
			}
		}
	}
	async authorize(extensionId: string, adapterId: string): Promise<string> {
		if (this.closed) throw userInputError("stale-target", "External input runtime is closed.");
		if (!this.owner.agentDir) throw userInputError("unauthorized", "External input grants are not configured.");
		const decision = await checkUserInputAdapterGrant({
			agentDir: this.owner.agentDir,
			loaderExtensionPath: extensionId,
			adapterId,
		});
		if (!decision.authorized) throw userInputError(decision.code, "External input adapter is not authorized.");
		return decision.grant.extensionPath;
	}
	/** Revalidate the canonical identity encoded in a retained message's receipt namespace. */
	async authorizeSubmission(submission: Submission, expectedEpoch?: string): Promise<void> {
		const provenance = submission.externalUser;
		if (!provenance) return;
		const extensionId = await this.authorize(submission.origin.id, provenance.adapterId);
		const branch = this.owner.branch();
		const epoch = await branch.attachment.submissions.externalTargetEpoch();
		if (expectedEpoch !== undefined && expectedEpoch !== epoch)
			throw userInputError("stale-target", "External input target changed before dispatch.");
		const target = hash([branch.scope.sessionId, branch.scope.branchId, epoch]);
		if (submission.id !== hash([target, extensionId, provenance.adapterId, provenance.messageId]))
			throw userInputError("unauthorized", "External input extension identity changed.");
	}
	async register(host: Host, options: Parameters<Register>[1]): Promise<Adapter> {
		keys(options, ["id", "label"]);
		if (
			!identifier(options.id) ||
			typeof options.label !== "string" ||
			!options.label.trim() ||
			options.label.length > 128
		)
			throw userInputError("invalid-input", "Adapter registration requires a bounded ID and label.");
		const adapterId = options.id;
		const ownership = this.lifetime;
		const extensionId = await this.authorize(host.extensionId, adapterId);
		const scope = () => {
			try {
				return host.scope();
			} catch (cause) {
				// Host attachment checks may use plain errors during navigation or runtime replacement.
				// Keep the adapter boundary structured without allowing a stale handle through.
				throw Object.assign(userInputError("stale-target", "External input target is not active."), { cause });
			}
		};
		// Authorization reads the grants file asynchronously, so the host attachment and the runtime that
		// started this registration can change while it waits. Revalidate both, then check and insert the
		// identity in one synchronous section: a concurrent registration must not also take it, and a
		// registration whose runtime ended must not reserve the identity its replacement needs.
		this.assertOwned(ownership);
		scope();
		const registrationKey = `${extensionId}\u0000${adapterId}`;
		if (this.registrations.has(registrationKey))
			throw userInputError(
				"adapter-already-registered",
				"An adapter with this ID is already registered for this extension runtime.",
			);
		/** Adapters the current stable target was published to; a target change invalidates every one. */
		const invalidated = new Set<() => void>();
		this.registrations.set(registrationKey, {
			invalidate: () => {
				// One failing client notification must not decide whether another observer learns that its
				// binding expired, so every captured listener is notified independently.
				for (const listener of [...invalidated]) {
					try {
						listener();
					} catch (error) {
						this.reportListenerError(error);
					}
				}
			},
		});
		const active = () => {
			// The host fences its own callbacks; this handle also checks the registration lifetime, which
			// ends before native reload invalidation.
			this.assertOwned(ownership);
			scope();
			return this.owner.branch();
		};
		const bindingFor = async (branch: PiFlowBranchResources) => {
			const epoch = await branch.attachment.submissions.externalTargetEpoch();
			return { epoch, target: hash([branch.scope.sessionId, branch.scope.branchId, epoch]) };
		};
		const authorize = async () => {
			if ((await this.authorize(host.extensionId, adapterId)) !== extensionId)
				throw userInputError("unauthorized", "External input extension identity changed.");
		};
		const identity = (target: string, messageId: string) => hash([target, extensionId, adapterId, messageId]);
		const lookup = async (target: string, messageId: string) => {
			if (!identifier(messageId) || typeof target !== "string" || !/^[a-f0-9]{64}$/.test(target))
				throw userInputError("invalid-input", "Invalid external input receipt identity.");
			await authorize();
			const branch = active();
			if (target !== (await bindingFor(branch)).target)
				throw userInputError("target-unavailable", "Receipt target is not attached.");
			const store = branch.attachment.submissions;
			const snapshot = await store.snapshotVersioned([identity(target, messageId)]);
			const [record] = snapshot.records;
			if (!record) {
				if (active() !== branch || target !== (await bindingFor(branch)).target)
					throw userInputError("stale-target", "Receipt target changed.");
				return undefined;
			}
			const provenance = record.submission.externalUser;
			if (!provenance || provenance.adapterId !== adapterId || provenance.messageId !== messageId)
				throw userInputError("id-conflict", "External input receipt identity conflicts.");
			const journal = snapshot.journal;
			if (active() !== branch || target !== (await bindingFor(branch)).target)
				throw userInputError("stale-target", "Receipt target changed.");
			return projectUserInputReceipt({ record, provenance, target, journal, liveQueue: this.owner.liveQueue() });
		};
		const requiredReceipt = async (target: string, messageId: string) => {
			const receipt = await lookup(target, messageId);
			if (!receipt) throw userInputError("stale-target", "Retained input receipt is unavailable.");
			return receipt;
		};
		return {
			version: 1,
			bind: async () => {
				await authorize();
				const branch = active();
				const generation = scope().attachmentId;
				const { target } = await bindingFor(branch);
				if (active() !== branch || generation !== scope().attachmentId)
					throw userInputError("stale-target", "Input target changed.");
				return Object.freeze({ target, generation });
			},
			lookup: async (input) => {
				keys(input, ["target", "messageId"]);
				return lookup(input.target, input.messageId);
			},
			submit: async (submitted) => {
				let input: typeof submitted;
				try {
					input = structuredClone(submitted);
				} catch {
					throw userInputError("invalid-input", "External input must contain only serializable data.");
				}
				return this.serial(async () => {
					keys(input, ["binding", "messageId", "text", "deliverAs"]);
					keys(input.binding, ["target", "generation"]);
					if (
						!identifier(input.messageId) ||
						typeof input.text !== "string" ||
						!input.text.trim() ||
						Buffer.from(input.text, "utf8").toString("utf8") !== input.text ||
						Buffer.byteLength(input.text) > 32768 ||
						!["steer", "followUp"].includes(input.deliverAs)
					)
						throw userInputError(
							"invalid-input",
							"External input requires text up to 32 KiB and a valid delivery mode.",
						);
					await authorize();
					const branch = active();
					const { target, epoch } = await bindingFor(branch);
					const liveScope = scope();
					if (
						input.binding.target !== target ||
						input.binding.generation !== liveScope.attachmentId ||
						active() !== branch
					)
						throw userInputError("stale-target", "External input target changed.");
					if (!this.owner.enabled()) throw userInputError("flow-suspended", "External input admission is paused.");
					const id = identity(target, input.messageId);
					const digest = hash([input.text, input.deliverAs]);
					const [previous] = await branch.attachment.submissions.forIds([id]);
					if (previous?.externalDigest !== undefined && previous.externalDigest !== digest)
						throw userInputError("id-conflict", "Message ID was reused with different content.");
					if (
						previous &&
						(previous.status !== "retained" ||
							previous.dispatch ||
							previous.unavailable !== "callback-ended" ||
							this.owner.pending(id))
					)
						return requiredReceipt(target, input.messageId);
					if (active() !== branch || !this.owner.enabled())
						throw userInputError("stale-target", "External input admission changed.");
					const submission: Submission = {
						version: 1,
						id,
						api: "prompt",
						origin: { kind: "extension", id: host.extensionId },
						scope: liveScope,
						externalUser: { version: 1, adapterId, messageId: input.messageId },
						args: [
							input.text,
							{ expandPromptTemplates: false, streamingBehavior: input.deliverAs, source: "extension" },
						],
					};
					await this.owner.retain(submission, digest, epoch, host.prepare(submission, epoch));
					return requiredReceipt(target, input.messageId);
				});
			},
			subscribe: (listener) => {
				if (typeof listener !== "function")
					throw userInputError("invalid-input", "Receipt listener must be a function.");
				const branch = active();
				let stopped = false;
				let running = false;
				let requested = false;
				/**
				 * What this subscription has already projected. Passing it back lets the store report only records
				 * whose indexed evidence changed, instead of decoding the archived journal for every store write.
				 * The first pass has no cursor and reads the current journal in full, which is what gives a new
				 * subscriber the records archived before it started listening.
				 */
				let cursor: FlowSubmissionCursor | undefined;
				let cursorTarget: string | undefined;
				const publish = () => {
					requested = true;
					if (running) return;
					running = true;
					void (async () => {
						while (requested && !stopped) {
							requested = false;
							// One authorization decision, target, and journal read serve this pass: the projection is
							// pure, so a revocation or target change applies to the whole pass instead of being re-read
							// for every record in it.
							await authorize();
							const { target } = await bindingFor(branch);
							// Reset may occur between target capture and the journal read. Never carry a cursor
							// filtered under the old target into publication for its replacement target.
							const update = await branch.attachment.submissions.snapshotChanged(
								cursorTarget === target ? cursor : undefined,
							);
							const liveQueue = this.owner.liveQueue();
							const unprojected = new Set<string>();
							for (const record of update.records) {
								const provenance = record.submission.externalUser;
								if (
									!provenance ||
									provenance.adapterId !== adapterId ||
									record.id !== identity(target, provenance.messageId)
								)
									continue;
								if (stopped) return;
								let receipt: UserInputReceipt;
								try {
									receipt = projectUserInputReceipt({
										record,
										provenance,
										target,
										journal: update.journal,
										liveQueue,
									});
								} catch (error) {
									// A record this pass could not project is asked for again next time, so the cursor must
									// not claim it as projected.
									unprojected.add(record.id);
									this.reportListenerError(error);
									continue;
								}
								try {
									listener(receipt);
								} catch (error) {
									this.reportListenerError(error);
								}
							}
							cursor = unprojected.size ? withoutRecords(update.cursor, unprojected) : update.cursor;
							cursorTarget = target;
						}
					})()
						.catch((error) => this.reportListenerError(error))
						.finally(() => {
							running = false;
							if (requested && !stopped) publish();
						});
				};
				const off = branch.attachment.submissions.subscribe(publish);
				const unsubscribe = () => {
					stopped = true;
					off();
					this.subscriptions.delete(unsubscribe);
				};
				this.subscriptions.add(unsubscribe);
				publish();
				return unsubscribe;
			},
			onTargetInvalidated: (listener) => {
				if (typeof listener !== "function")
					throw userInputError("invalid-input", "Target listener must be a function.");
				active();
				invalidated.add(listener);
				return () => {
					invalidated.delete(listener);
				};
			},
		};
	}
}
