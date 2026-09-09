import { createHash } from "node:crypto";
import { isNativeUserInput } from "./native-admission.js";
import type { PiFlowAttachment } from "./pi-attachment.js";
import { FlowLedgerError } from "./receipt-ledger.js";

export function captureUserWorkParticipants(participants: readonly string[] | undefined): string[] {
	if (participants === undefined) return [];
	if (
		!Array.isArray(participants) ||
		participants.length > 63 ||
		new Set(participants).size !== participants.length ||
		[...participants].some(
			(participant) => typeof participant !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(participant),
		)
	)
		throw new FlowLedgerError("schema", "Invalid user-work producer participants.");
	return [...participants];
}

/** Recoverable from the exact retained host submission; message text never selects existing work. */
export async function retainUserWork(
	attachment: PiFlowAttachment,
	id: string,
	revision: number,
	participants: readonly string[] = [],
) {
	participants = captureUserWorkParticipants(participants);
	const record = (await attachment.submissions.snapshot()).find((item) => item.id === id);
	if (!record || record.revision !== revision || record.status !== "retained")
		throw new FlowLedgerError("stale", "User work requires the retained submission revision.");
	if (!isNativeUserInput(record.submission))
		throw new FlowLedgerError("identity", "User work requires verified host input.");
	const scope = attachment.ledger.scope;
	const key = createHash("sha256")
		.update(JSON.stringify(["user-work-v1", scope.sessionId, scope.branchId, record.id, record.revision]))
		.digest("hex");
	let work = await attachment.waits.registerWork(`user:${key}`, "host-user", record.acceptedAt);
	for (const participant of participants)
		if (!work.participants.includes(participant))
			work = await attachment.waits.shareWork(work.id, "host-user", work.revision, participant, record.acceptedAt);
	return { id: work.id, actor: work.owner, revision: work.revision };
}

/** Consume only exact queue receipts already persisted by the native dispatch bridge. */
export async function consumedUserWork(
	attachment: PiFlowAttachment,
	claimed: { id: string; revision: number }[],
	participants: readonly string[] = [],
) {
	participants = captureUserWorkParticipants(participants);
	if (!claimed.length) return undefined;
	const records = await attachment.submissions.snapshot();
	const work = [];
	for (const item of claimed) {
		const matches = records.filter(
			(record) =>
				record.status === "retained" &&
				record.dispatch?.inputs?.some(
					(input) => input.queue?.id === item.id && input.queue.revision === item.revision,
				) &&
				record.dispatch.queueClaims?.some(
					(claim) => claim.id === item.id && claim.revision === item.revision && claim.consumed,
				),
		);
		if (matches.length !== 1 || !isNativeUserInput(matches[0].submission)) return undefined;
		work.push(await retainUserWork(attachment, matches[0].id, matches[0].revision, participants));
	}
	if (work.length === 1) return work[0];
	const key = createHash("sha256")
		.update(JSON.stringify(["user-batch-v1", work.map((item) => item.id)]))
		.digest("hex");
	let batch = await attachment.waits.registerWork(`user-batch:${key}`, "host-user", Date.now());
	for (const participant of participants)
		if (!batch.participants.includes(participant))
			batch = await attachment.waits.shareWork(batch.id, "host-user", batch.revision, participant, Date.now());
	return { id: batch.id, actor: batch.owner, revision: batch.revision };
}
