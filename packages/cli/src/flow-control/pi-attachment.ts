import { defaultCatalog } from "../cli-messages.js";
import type { CatalogBundle } from "../locale-catalog.js";
import { createDeferredJournal, type DeferredJournal } from "./journal-storage.js";
import { materializeLocalFlowSession, openLocalFlowSession, reconcileFlowStateVersion } from "./local-storage.js";
import { FlowNativeRequestStore } from "./native-request-store.js";
import { FlowOwnership } from "./ownership.js";
import { createPiLedgerStore } from "./pi-ledger-store.js";
import { FlowReceiptLedger, type FlowScope } from "./receipt-ledger.js";
import { FlowResultManifestStore } from "./result-manifest.js";
import { BACKGROUND_CONTEXT, type Session } from "./scalar-storage.js";
import { FlowSubmissionStore } from "./submission-store.js";
import { type FlowSubmissionView, projectFlowSubmissions } from "./submission-view.js";
import { FlowWaitProducerRegistry } from "./wait-producers.js";
import { FlowWaitStore } from "./wait-store.js";

/** Own the flow journal session from open through its final close. */
export class PiFlowAttachment {
	private constructor(
		private readonly ownership: FlowOwnership,
		private readonly session: Session,
		readonly ledger: FlowReceiptLedger,
		readonly submissions: FlowSubmissionStore,
		readonly results: FlowResultManifestStore,
		readonly nativeRequests: FlowNativeRequestStore,
		readonly waits: FlowWaitStore,
		readonly waitProducers: FlowWaitProducerRegistry,
		private readonly catalog: CatalogBundle,
		private readonly deferred?: DeferredJournal,
	) {}

	/** The opener must use the owned directory and return an exclusively owned session. */
	static async open(
		root: string,
		scope: FlowScope,
		openSession: (
			directory: string,
			acceptedDirectories?: readonly string[],
		) => Promise<Session> = openLocalFlowSession,
		onIsolatedState?: (path: string) => void,
		catalog: CatalogBundle = defaultCatalog(),
		deferred = false,
	): Promise<PiFlowAttachment> {
		const ownership = deferred
			? FlowOwnership.reserve(root, scope, catalog)
			: FlowOwnership.acquire(root, scope, catalog);
		const journal = deferred ? createDeferredJournal() : undefined;
		let session: Session | undefined;
		try {
			if (journal) session = journal.session;
			else {
				// State from an earlier record shape is moved aside before any store reads it.
				const isolated = await ownership.run(() => reconcileFlowStateVersion(ownership.directory));
				if (isolated) onIsolatedState?.(isolated);
				session = await openSession(ownership.directory, ownership.sessionDirectories);
			}
			const store = createPiLedgerStore(session);
			const ledger = await FlowReceiptLedger.attach(
				{
					archivesRequests: store.archivesRequests,
					retired: (query) => ownership.run(() => store.retired(query)),
					readContext: (ids) => ownership.run(() => store.readContext(ids)),
					read: () => ownership.run(() => store.read()),
					transact: (update) => ownership.run(() => store.transact(update)),
				},
				ownership.scope,
				undefined,
				catalog,
			);
			const submissions = await FlowSubmissionStore.attach(session, ownership);
			const results = await FlowResultManifestStore.attach(session, ownership);
			const nativeRequests = await FlowNativeRequestStore.attach(session, ownership);
			const waits = await FlowWaitStore.attach(session, ownership);
			return new PiFlowAttachment(
				ownership,
				session,
				ledger,
				submissions,
				results,
				nativeRequests,
				waits,
				new FlowWaitProducerRegistry(waits, ownership.scope),
				catalog,
				journal,
			);
		} catch (error) {
			try {
				await ownership.close(() => session?.close(BACKGROUND_CONTEXT));
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Flow attachment failed and storage did not close.");
			}
			throw error;
		}
	}

	/** Whether this branch's records are on disk. A deferred attachment is in memory until `materialize`. */
	get stored(): boolean {
		return !this.deferred || this.deferred.materialized;
	}

	/** Run `store` before this branch records anything while it is in memory. */
	storeBeforeFirstWrite(store: () => Promise<void>): void {
		this.deferred?.beforeFirstWrite(store);
	}

	/** Take the branch's lock for deferred records, refusing a branch that another process recorded. */
	claimStorage(): void {
		if (this.deferred && !this.ownership.claimedStorage) this.ownership.claimNew();
	}

	/** Claim the branch directory and write the in-memory records to it. */
	materialize(): Promise<void> {
		const journal = this.deferred;
		if (!journal || journal.materialized) return Promise.resolve();
		return this.ownership.run(async () => {
			this.claimStorage();
			await reconcileFlowStateVersion(this.ownership.directory);
			await materializeLocalFlowSession(journal, this.ownership.directory);
		});
	}

	/** Inspection only. Read request receipts before claims, which are persisted before requests. */
	async submissionViews(liveQueue?: ReadonlyMap<string, number>): Promise<FlowSubmissionView[]> {
		const requests = await this.nativeRequests.snapshot();
		const records = await this.submissions.snapshot();
		const ledger = await this.ledger.snapshot();
		return projectFlowSubmissions(records, ledger, requests, this.catalog, liveQueue);
	}

	/** Drain admitted writes, close Pi storage, then release process ownership. */
	close(): Promise<void> {
		const stopped = this.waits.stopDeadlines();
		const producers = this.waitProducers.close();
		return this.ownership.close(async () => {
			await producers;
			await stopped;
			await this.session.close(BACKGROUND_CONTEXT);
		});
	}
}
