import { BACKGROUND_CONTEXT, type Session } from "@earendil-works/pi-agent-core";
import { openLocalFlowSession } from "./local-storage.js";
import { FlowOwnership } from "./ownership.js";
import { createPiLedgerStore } from "./pi-ledger-store.js";
import { FlowReceiptLedger, type FlowScope } from "./receipt-ledger.js";
import { FlowResultManifestStore } from "./result-manifest.js";
import { FlowSubmissionStore } from "./submission-store.js";

/** Own the Pi receipt session from open through its final close. */
export class PiFlowAttachment {
	private constructor(
		private readonly ownership: FlowOwnership,
		private readonly session: Session,
		readonly ledger: FlowReceiptLedger,
		readonly submissions: FlowSubmissionStore,
		readonly results: FlowResultManifestStore,
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
			return new PiFlowAttachment(ownership, session, ledger, submissions, results);
		} catch (error) {
			try {
				await ownership.close(() => session?.close(BACKGROUND_CONTEXT));
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Flow attachment failed and storage did not close.");
			}
			throw error;
		}
	}

	/** Drain admitted writes, close Pi storage, then release process ownership. */
	close(): Promise<void> {
		return this.ownership.close(() => this.session.close(BACKGROUND_CONTEXT));
	}
}
