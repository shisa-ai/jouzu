import type { AgentSession } from "./agent-session.js";

export interface FlowSubmission {
	version: 1;
	id: string;
	api: "prompt" | "steer" | "followUp" | "sendCustomMessage" | "sendUserMessage";
	origin: { kind: "host" | "sdk" | "extension"; id: string };
	/** leafId is a transcript position, not a durable campaign/branch identity. */
	scope: { sessionId: string; leafId: string | null; attachmentId: string };
	args: unknown[];
	userCommand?: { id: string; name: string; submissionId: string };
}

export interface FlowIngress {
	version: 1;
	/** Allocate session resources here, after construction and before the SDK returns. */
	attach?(session: AgentSession): void | Promise<void>;
	/** Release resources after ingress is fenced. Session disposal awaits this callback. */
	dispose?(): void | Promise<void>;
	/** Retain before returning, dispatch once, or throw to reject. */
	submit(submission: FlowSubmission, dispatch: () => Promise<void>): void | Promise<void>;
}
