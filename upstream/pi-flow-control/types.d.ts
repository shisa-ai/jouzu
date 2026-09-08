import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "./types.js";

export interface FlowQueuedMessage {
	id: string;
	revision: number;
	lane: "steer" | "followUp";
	message: AgentMessage;
}

export interface FlowQueueClaim {
	candidates: FlowQueuedMessage[];
	claimed: FlowQueuedMessage[];
}

export type FlowQueueChange =
	| { kind: "cancelled" | "not-queued" }
	| { kind: "edited" | "conflict"; revision: number };

export interface FlowRequestInput {
	requestId: string;
	sourceMessages: AgentMessage[];
	transformedMessages: AgentMessage[];
	modelMessages: Message[];
	systemPrompt: string;
}

/** Optional host checkpoints. Throws withhold consumption or a transport call. */
export interface FlowCheckpoints {
	/** Reports Pi conversion and image-policy replacements before returning model input. */
	afterModelConversion?: (input: {
		sourceMessages: readonly AgentMessage[];
		modelMessages: readonly Message[];
		sourceIndices: readonly number[];
		imageReplaced: readonly boolean[];
	}) => void | Promise<void>;
	/** Reports the host-created clone before extension handlers; references are identity evidence only. */
	afterContextClone?: (source: readonly AgentMessage[], cloned: readonly AgentMessage[], signal?: AbortSignal) => void | Promise<void>;
	/** True permits the candidate revisions; false retains them in their native queue. */
	beforeQueueClaim?: (items: FlowQueuedMessage[], signal?: AbortSignal) => boolean | Promise<boolean>;
	/** Reports exact removal after synchronous revision revalidation; awaited before history/model work. */
	afterQueueClaim?: (receipt: FlowQueueClaim, signal?: AbortSignal) => void | Promise<void>;
	/** Runs after conversion and auth resolution, immediately before the stream function. */
	beforeRequest?: (input: FlowRequestInput, signal?: AbortSignal) => void | Promise<void>;
}
