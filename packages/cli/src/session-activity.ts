import type { SessionUiActivity } from "./session-ui/index.js";

export interface SessionActivityInput {
	/** Status text the multiloop extension publishes for this session, for example "multiloop: 1 running". */
	loopStatus?: string;
	/** Child runs that are queued, starting, or running in this session. */
	activeAgents: number;
	/** Running background jobs the dashboard shows in place of the producer's widget. */
	activeJobs?: number;
}

/**
 * Multiloop publishes one count summary and no structured state, so a running loop is read from the
 * count label it writes, for example "1 running". Only the marker animation depends on this: the
 * counts themselves are shown verbatim, so a wording change upstream can cost the animation but
 * never the text. The transform that writes the label lives in scripts/multiloop-flow-transform.mjs.
 */
const LOOP_RUNNING = /\b\d+ running\b/;

/**
 * Compose Session Line activity for autonomous work. Loops and child agents report together so one
 * marker answers whether anything is still moving, and the counts stay in one place.
 */
export function sessionActivity(input: SessionActivityInput): SessionUiActivity | undefined {
	const parts: string[] = [];
	const loop = input.loopStatus?.trim();
	if (loop) parts.push(loop);
	if (input.activeAgents > 0) parts.push(`${input.activeAgents} subagent${input.activeAgents === 1 ? "" : "s"}`);
	const jobs = input.activeJobs ?? 0;
	if (jobs > 0) parts.push(`${jobs} job${jobs === 1 ? "" : "s"}`);
	if (parts.length === 0) return undefined;
	return {
		text: parts.join(" · "),
		active: input.activeAgents > 0 || jobs > 0 || (loop !== undefined && LOOP_RUNNING.test(loop)),
	};
}
