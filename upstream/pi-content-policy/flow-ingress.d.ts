import type { AgentSession } from "./agent-session.js";

export interface FlowSubmission {
	version: 1;
	id: string;
	api: "prompt" | "steer" | "followUp" | "sendCustomMessage" | "sendUserMessage";
	origin: { kind: "host" | "sdk" | "extension"; id: string };
	/** Capture-time native state. Earlier v1 records may omit it; absence cannot establish an implicit wake. */
	hostState?: { streaming: boolean };
	/** leafId is a transcript position, not a durable campaign/branch identity. */
	scope: { sessionId: string; leafId: string | null; attachmentId: string };
	args: unknown[];
	userCommand?: { id: string; name: string; submissionId: string };
	/** Issued by the host adapter path, never read from ordinary send options. */
	externalUser?: { version: 1; adapterId: string; messageId: string };
}

export type UserInputTarget = string;
export interface UserInputBinding {
	target: UserInputTarget;
	generation: string;
}
export interface UserInputReceipt {
	version: 1;
	adapterId: string;
	messageId: string;
	target: UserInputTarget;
	state: "retained" | "held" | "queued" | "consumed" | "rejected" | "cancelled" | "unknown";
	revision: number;
	generation: number;
	reason?: { code: string; text: string };
}
export interface UserInputAdapter {
	readonly version: 1;
	/** Stable target and executable generation for the current attachment. */
	bind(): Promise<UserInputBinding>;
	submit(input: {
		binding: UserInputBinding;
		messageId: string;
		text: string;
		deliverAs: "steer" | "followUp";
	}): Promise<UserInputReceipt>;
	lookup(input: { target: UserInputTarget; messageId: string }): Promise<UserInputReceipt | undefined>;
	subscribe(listener: (receipt: UserInputReceipt) => void): () => void;
	/**
	 * Report that the published target can no longer accept input, such as a flow reset that starts a new
	 * target epoch. Withdraw the published binding, call `bind()` again, and publish the new target; never
	 * retarget a message that was composed against the old one. Returns the unsubscribe function.
	 */
	onTargetInvalidated(listener: () => void): () => void;
}
export interface UserInputAdapterHost {
	/** Loader-owned identity and live native scope; neither is supplied by message data. */
	readonly extensionId: string;
	scope(): FlowSubmission["scope"];
	/** Capture one fenced literal native prompt callback for a retained host-owned submission. */
	prepare(submission: FlowSubmission, expectedEpoch?: string): () => Promise<void>;
}

export interface FlowIngress {
	version: 1;
	registerUserInputAdapter?(host: UserInputAdapterHost, options: { id: string; label: string }): Promise<UserInputAdapter>;
	/**
	 * Revalidate live authority for one prepared external dispatch immediately before native input.
	 * `epoch` is the external target epoch the caller validated; a rotated epoch refuses the dispatch.
	 * The binding asks again after this returns, so a runtime, attachment, or target replaced while the
	 * check awaited still refuses the dispatch.
	 */
	authorizeExternal?(submission: FlowSubmission, epoch: string): void | Promise<void>;
	/** Allocate session resources here, after construction and before the SDK returns. */
	attach?(session: AgentSession): void | Promise<void>;
	/** Run a direct host command without native input ownership. May hold automation, but must not join the command during disposal. */
	runCommand?(submission: FlowSubmission, run: () => Promise<void>): Promise<void>;
	/** Release resources after ingress is fenced. Session disposal awaits this callback. */
	dispose?(): void | Promise<void>;
	/** Drain old branch resources with ingress fenced, before Pi changes its transcript position. Do not await session disposal here. */
	beforeBranchChange?(previous: FlowSubmission["scope"]): void | Promise<void>;
	/** Attach new branch resources before session_tree handlers run. Failure keeps ingress fenced. Do not await session disposal here. */
	branchChanged?(current: FlowSubmission["scope"]): void | Promise<void>;
	/**
	 * Retain before returning, dispatch once, or throw to reject. A retained submission is admitted
	 * as "handled": a prompt's preflightResult callback receives it and steer/followUp resolve with
	 * it, because the host holds the input without a native queue entry. A dispatch reports its own
	 * native disposition instead, and a rejection rejects the send promise without reporting one.
	 */
	submit(submission: FlowSubmission, dispatch: () => Promise<void>): void | Promise<void>;
}
