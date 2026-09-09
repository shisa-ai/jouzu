import { createHash } from "node:crypto";
import { isNativeUserInput } from "./native-admission.js";
import type { PiFlowAttachment } from "./pi-attachment.js";
import { FlowLedgerError, type FlowScope } from "./receipt-ledger.js";

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

export function userWorkId(scope: FlowScope, id: string, revision: number): string {
	return `user:${createHash("sha256")
		.update(JSON.stringify(["user-work-v1", scope.sessionId, scope.branchId, id, revision]))
		.digest("hex")}`;
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
	let work = await attachment.waits.registerWork(
		userWorkId(scope, record.id, record.revision),
		"host-user",
		record.acceptedAt,
		[{ id: record.id, revision: record.revision }],
	);
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
	const inputs: { id: string; revision: number }[] = [];
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
		inputs.push({ id: matches[0].id, revision: matches[0].revision });
		work.push(await retainUserWork(attachment, matches[0].id, matches[0].revision, participants));
	}
	if (work.length === 1) return work[0];
	const key = createHash("sha256")
		.update(JSON.stringify(["user-batch-v1", work.map((item) => item.id)]))
		.digest("hex");
	let batch = await attachment.waits.registerWork(`user-batch:${key}`, "host-user", Date.now(), inputs);
	for (const participant of participants)
		if (!batch.participants.includes(participant))
			batch = await attachment.waits.shareWork(batch.id, "host-user", batch.revision, participant, Date.now());
	return { id: batch.id, actor: batch.owner, revision: batch.revision };
}
