import type { FlowScope } from "./receipt-ledger.js";
import type { FlowSubmissionView } from "./submission-view.js";
import type { FlowAuthorityWork } from "./wait-authority.js";
import type { FlowWaitState } from "./wait-state.js";

/** One input the controller is holding, with the reason a reader can act on. */
export interface FlowHeldInput {
	id: string;
	revision: number;
	reason: string;
}
/**
 * A request whose input was withheld and whose retry the user must authorize. `hash` is the
 * evidence `retryNativeRequest` requires, so a retry cannot be aimed at changed input.
 */
export interface FlowRetryableRequest {
	submissionId: string;
	requestId: string;
	hash: string;
	reason: "required-input" | "required-context";
}
/** A live wait with the deadline it was given, not a recomputed one. */
export interface FlowBlockedWait {
	token: string;
	workId: string;
	owner?: string;
	reason: string;
	expiresAt: number;
	unmet: number;
}
/** Work a producer still names that this session holds no authority for, so it will not run. */
export interface FlowUnaccountableWork {
	producer: string;
	description: string;
}
/** Work a user has held or retired, which produces no automated turns until that changes. */
export interface FlowSuspendedWork {
	id: string;
	owner: string;
	state: "paused" | "stopped";
	reason: string;
}
/**
 * Registered work that can still take automated turns, listed so its identity is the pause and stop
 * target a user can name. A campaign is discoverable whether or not it currently holds a wait.
 */
export interface FlowActiveWork {
	id: string;
	owner: string;
	/** Key parts naming the campaign, as its owning producer named them. Absent for unbound work. */
	campaign?: string[];
	/** Live waits this work owns, so a reader can connect it to the waits listed above. */
	waits: number;
}
export interface FlowStatus {
	version: 1;
	scope: FlowScope;
	held: FlowHeldInput[];
	retryable: FlowRetryableRequest[];
	waiting: FlowBlockedWait[];
	active: FlowActiveWork[];
	suspended: FlowSuspendedWork[];
	unaccountable: FlowUnaccountableWork[];
}

/**
 * Project what a user needs to decide: what is held and why, what a retry may be aimed at, which
 * work is blocked until when, and which registered work can still take turns. Derived from retained
 * state only, so reading it neither releases work nor adds model context.
 */
export function projectFlowStatus(
	scope: FlowScope,
	submissions: FlowSubmissionView[],
	waits: FlowWaitState[],
	work: FlowAuthorityWork[],
	unaccountable: FlowUnaccountableWork[] = [],
): FlowStatus {
	const owners = new Map(work.map((record) => [record.id, record.owner]));
	const held: FlowHeldInput[] = [];
	const retryable: FlowRetryableRequest[] = [];
	for (const submission of submissions) {
		if (submission.admission === "held" && submission.reason)
			held.push({ id: submission.id, revision: submission.revision, reason: submission.reason });
		for (const request of submission.nativeRequests ?? []) {
			// A request that already has a retry is not offered again.
			if (!request.hold || request.retryRequestId) continue;
			retryable.push({
				submissionId: submission.id,
				requestId: request.requestId,
				hash: request.hold.hash,
				reason: request.hold.reason,
			});
		}
	}
	const waiting = waits
		.filter((wait) => wait.state === "waiting")
		.map((wait) => ({
			token: wait.token,
			workId: wait.workId,
			...(owners.get(wait.workId) ? { owner: owners.get(wait.workId) as string } : {}),
			reason: wait.reason,
			expiresAt: wait.expiresAt,
			unmet: wait.unmet.length,
		}));
	// Work with source submissions is one user turn's identity, not a campaign a user would pause,
	// and a session accumulates one per turn. Only registered producer work is offered as a target.
	const active = work.flatMap((record) =>
		(record.lifecycle?.state ?? "active") === "active" && record.userInputs === undefined
			? [
					{
						id: record.id,
						owner: record.owner,
						...(record.binding ? { campaign: [...record.binding.key] } : {}),
						waits: waiting.filter((wait) => wait.workId === record.id).length,
					},
				]
			: [],
	);
	// A completed campaign is finished rather than held, so only paused and stopped work is listed.
	const suspended = work.flatMap((record) =>
		record.lifecycle && ["paused", "stopped"].includes(record.lifecycle.state)
			? [
					{
						id: record.id,
						owner: record.owner,
						state: record.lifecycle.state as FlowSuspendedWork["state"],
						reason: record.lifecycle.reason,
					},
				]
			: [],
	);
	return {
		version: 1,
		scope: { ...scope },
		held,
		retryable,
		waiting,
		active,
		suspended,
		unaccountable: [...unaccountable],
	};
}

const duration = (milliseconds: number): string => {
	const minutes = Math.round(milliseconds / 60_000);
	if (minutes < 1) return "under a minute";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
};

/** Render the status for a terminal. Identifiers stay whole so a retry can be copied from it. */
export function formatFlowStatus(status: FlowStatus, now: number): string {
	const lines: string[] = [];
	if (status.waiting.length) {
		lines.push("Waiting");
		for (const wait of status.waiting) {
			const remaining = wait.expiresAt - now;
			const deadline = remaining > 0 ? `expires in ${duration(remaining)}` : "past its deadline";
			lines.push(`- ${wait.owner ?? "work"} ${wait.workId}: ${wait.reason}`);
			lines.push(`  ${wait.unmet} unmet, ${deadline}, token ${wait.token}`);
		}
	}
	if (status.held.length) {
		if (lines.length) lines.push("");
		lines.push("Held input");
		for (const input of status.held) lines.push(`- ${input.id}: ${input.reason}`);
	}
	if (status.retryable.length) {
		if (lines.length) lines.push("");
		lines.push("Withheld requests");
		for (const request of status.retryable) {
			lines.push(`- ${request.requestId} (${request.reason})`);
			lines.push(`  retry with: /flow retry ${request.requestId}`);
		}
	}
	if (status.active.length) {
		if (lines.length) lines.push("");
		lines.push("Active work");
		for (const item of status.active) {
			const campaign = item.campaign?.length ? ` (${item.campaign.join(" ")})` : "";
			const waits = item.waits === 0 ? "no live wait" : `${item.waits} live wait${item.waits === 1 ? "" : "s"}`;
			lines.push(`- ${item.owner} ${item.id}${campaign}: ${waits}`);
			// One command per line: a trailing separator would be copied along with the identity.
			lines.push(`  pause with: /flow pause ${item.id}`);
			lines.push(`  stop with: /flow stop ${item.id}`);
		}
	}
	if (status.suspended.length) {
		if (lines.length) lines.push("");
		lines.push("Held work");
		for (const item of status.suspended) lines.push(`- ${item.owner} ${item.id}: ${item.state} (${item.reason})`);
	}
	if (status.unaccountable.length) {
		if (lines.length) lines.push("");
		lines.push("Not accounted for in this session");
		for (const item of status.unaccountable) lines.push(`- ${item.producer}: ${item.description}`);
	}
	return lines.length ? lines.join("\n") : "Nothing is held, withheld, or waiting.";
}
