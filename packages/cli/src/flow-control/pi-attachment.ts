import { BACKGROUND_CONTEXT, type Session } from "@earendil-works/pi-agent-core";
import { openLocalFlowSession } from "./local-storage.js";
import { FlowNativeRequestStore } from "./native-request-store.js";
import { FlowOwnership } from "./ownership.js";
import { createPiLedgerStore } from "./pi-ledger-store.js";
import { FlowReceiptLedger, type FlowScope } from "./receipt-ledger.js";
import { FlowResultManifestStore } from "./result-manifest.js";
import { FlowSubmissionStore } from "./submission-store.js";
import { type FlowSubmissionView, projectFlowSubmissions } from "./submission-view.js";
import { FlowWaitStore } from "./wait-store.js";

/** Own the Pi receipt session from open through its final close. */
export class PiFlowAttachment {
	private constructor(
		private readonly ownership: FlowOwnership,
		private readonly session: Session,
		readonly ledger: FlowReceiptLedger,
		readonly submissions: FlowSubmissionStore,
		readonly results: FlowResultManifestStore,
		readonly nativeRequests: FlowNativeRequestStore,
		readonly waits: FlowWaitStore,
	) {}

	/** The opener must use the owned directory and return an exclusively owned session. */
	static async open(
		root: string,
		scope: FlowScope,
		openSession: (directory: string) => Promise<Session> = openLocalFlowSession,
	): Promise<PiFlowAttachment> {
		const ownership = FlowOwnership.acquire(root, scope);
		let session: Session | undefined;
		try {
			session = await openSession(ownership.directory);
			const store = createPiLedgerStore(session);
			const ledger = await FlowReceiptLedger.attach(
				{
					read: () => ownership.run(() => store.read()),
					transact: (update) => ownership.run(() => store.transact(update)),
				},
				ownership.scope,
			);
			const submissions = await FlowSubmissionStore.attach(session, ownership);
			const results = await FlowResultManifestStore.attach(session, ownership);
			const nativeRequests = await FlowNativeRequestStore.attach(session, ownership);
			const waits = await FlowWaitStore.attach(session, ownership);
			return new PiFlowAttachment(ownership, session, ledger, submissions, results, nativeRequests, waits);
		} catch (error) {
			try {
				await ownership.close(() => session?.close(BACKGROUND_CONTEXT));
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Flow attachment failed and storage did not close.");
			}
			throw error;
		}
	}

	/** Inspection only. Read request receipts before claims, which are persisted before requests. */
	async submissionViews(): Promise<FlowSubmissionView[]> {
		const requests = await this.nativeRequests.snapshot();
		const records = await this.submissions.snapshot();
		const ledger = await this.ledger.snapshot();
		return projectFlowSubmissions(records, ledger, requests);
	}

	/** Drain admitted writes, close Pi storage, then release process ownership. */
	close(): Promise<void> {
		const stopped = this.waits.stopDeadlines();
		return this.ownership.close(async () => {
			await stopped;
			await this.session.close(BACKGROUND_CONTEXT);
		});
	}
}
