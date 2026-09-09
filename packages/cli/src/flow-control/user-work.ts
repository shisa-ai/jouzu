import { createHash } from "node:crypto";
import { isNativeUserInput } from "./native-admission.js";
import type { PiFlowAttachment } from "./pi-attachment.js";
import { FlowLedgerError } from "./receipt-ledger.js";

/** Recoverable from the exact retained host submission; message text never selects existing work. */
export async function retainUserWork(attachment: PiFlowAttachment, id: string, revision: number) {
	const record = (await attachment.submissions.snapshot()).find((item) => item.id === id);
	if (!record || record.revision !== revision || record.status !== "retained")
		throw new FlowLedgerError("stale", "User work requires the retained submission revision.");
	if (!isNativeUserInput(record.submission))
		throw new FlowLedgerError("identity", "User work requires verified host input.");
	const scope = attachment.ledger.scope;
	const key = createHash("sha256")
		.update(JSON.stringify(["user-work-v1", scope.sessionId, scope.branchId, record.id, record.revision]))
		.digest("hex");
	const work = await attachment.waits.registerWork(`user:${key}`, "host-user", record.acceptedAt);
	return { id: work.id, actor: work.owner, revision: work.revision };
}
