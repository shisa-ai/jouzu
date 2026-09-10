import { createHash } from "node:crypto";

/**
 * One host message offered to producers for recognition, in a shape no host type leaks into.
 *
 * Producers observe their own tool output, which means they must be able to say "that result of
 * mine is in the final context". Handing them the host's message type made every producer depend on
 * Pi's `AgentMessage`, so a host change reached each of them. They now match on this projection and
 * answer with indices, which also removes the need to trust object identity: an index either falls
 * inside the offered list or it does not.
 */
export interface FlowObservation {
	/** Position in the offered list. The only thing a producer returns. */
	index: number;
	/** Producers observe tool output; anything else is offered so indices stay stable. */
	kind: "toolResult" | "other";
	/** A failed result proves nothing was delivered, so producers exclude it. */
	failed: boolean;
	toolCallId?: string;
	toolName?: string;
	/** Hash of the message content, so recognition never depends on the host's content shape. */
	contentHash: string;
}

/**
 * Hash message content for recognition. The host's message union includes variants that carry no
 * content at all, and `JSON.stringify(undefined)` is not a string, so those hash a stable marker
 * rather than crashing the projection of an entire context.
 */
export const flowObservationHash = (content: unknown): string =>
	createHash("sha256")
		.update(content === undefined ? "\u0000no-content" : JSON.stringify(content))
		.digest("hex");

/** Project one retained message the same way, so stored evidence and live context compare equal. */
export const flowObservationOf = (message: {
	role: string;
	isError?: boolean;
	toolCallId?: string;
	toolName?: string;
	content?: unknown;
}): Omit<FlowObservation, "index"> => {
	const [projected] = flowObservations([message]);
	const { index: _index, ...rest } = projected;
	return rest;
};

/** Project host messages for producer recognition without exposing the host's message type. */
export function flowObservations(
	messages: readonly { role: string; isError?: boolean; toolCallId?: string; toolName?: string; content?: unknown }[],
): FlowObservation[] {
	return messages.map((message, index) => ({
		index,
		kind: message.role === "toolResult" ? "toolResult" : "other",
		failed: message.isError === true,
		...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
		...(message.toolName === undefined ? {} : { toolName: message.toolName }),
		contentHash: flowObservationHash(message.content),
	}));
}

/** Validate what a producer claimed to recognize before the host acts on it. */
export function selectedObservations(indices: readonly number[], offered: number): number[] {
	if (!Array.isArray(indices)) throw new TypeError("Observation selection must be a list of indices.");
	const selected = new Set<number>();
	for (const index of indices) {
		if (!Number.isSafeInteger(index) || index < 0 || index >= offered)
			throw new RangeError("Observation is outside native context.");
		selected.add(index);
	}
	return [...selected].sort((a, b) => a - b);
}
