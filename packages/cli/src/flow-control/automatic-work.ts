import { createHash } from "node:crypto";
import type { PiFlowAttachment } from "./pi-attachment.js";
import type { WorkIdentity } from "./work-context.js";

/**
 * Producers that need an origin before they can create their own work. A background execution
 * captures its owning work before the process starts, and a task derives its work from the
 * invocation that created it, so both are unusable without one.
 */
const automaticWorkParticipants = ["bg", "tasks", "subagent", "schedule"] as const;

/**
 * One reusable host identity per branch for turns that no producer owns: result deliveries, wait
 * decisions, and alerts still run the model, and the tools they reach must be able to start work.
 * The identity is stable per branch so a job started in one wake turn reports back to the work
 * that started it, and it is host-supplied, so no tool argument can select or invent it.
 */
export function automaticWorkId(scope: { sessionId: string; branchId: string }): string {
	return `automatic:${createHash("sha256")
		.update(JSON.stringify(["automatic-work-v1", scope.sessionId, scope.branchId]))
		.digest("hex")}`;
}

export async function retainAutomaticWork(attachment: PiFlowAttachment): Promise<WorkIdentity> {
	const scope = attachment.ledger.scope;
	let work = await attachment.waits.registerWork(automaticWorkId(scope), "host-automatic", Date.now());
	for (const participant of automaticWorkParticipants)
		if (!work.participants.includes(participant))
			work = await attachment.waits.shareWork(work.id, work.owner, work.revision, participant, Date.now());
	return { id: work.id, actor: work.owner, revision: work.revision };
}
