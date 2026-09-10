/**
 * Whether the run a request belongs to carries user instruction.
 *
 * No-reply permission may only be granted to a notification-only run, so this decides what "the
 * current run" contains. The whole conversation is replayed on every request, so history is not the
 * question: only the trailing block after the last assistant turn is this run's input. A user
 * message there is real instruction unless every part of it is flow-injected, which is how the
 * controller's own composed wakes appear.
 *
 * It errs toward withholding: anything unparseable, unfamiliar, or not provably flow-injected counts
 * as user input, because wrongly granting silence loses a reply the user asked for.
 */
export function flowRunContainsUserInput(messages: readonly { role: string; content?: unknown }[]): boolean {
	if (!Array.isArray(messages)) return true;
	let start = 0;
	for (let index = messages.length - 1; index >= 0; index--)
		if (messages[index]?.role === "assistant") {
			start = index + 1;
			break;
		}
	for (const message of messages.slice(start)) {
		if (message?.role !== "user") continue;
		if (!isFlowInjected(message.content)) return true;
	}
	return false;
}

/** A message the controller composed carries a flow marker on every one of its text parts. */
function isFlowInjected(content: unknown): boolean {
	if (typeof content === "string") return false;
	if (!Array.isArray(content) || content.length === 0) return false;
	return content.every((part) => {
		if (!part || typeof part !== "object") return false;
		const text =
			(part as { type?: string; text?: unknown }).type === "text" ? (part as { text?: unknown }).text : undefined;
		if (typeof text !== "string") return false;
		try {
			return (JSON.parse(text) as { flowInput?: unknown })?.flowInput !== undefined;
		} catch {
			// Ordinary user text is not JSON, and malformed JSON is not evidence of a flow marker.
			return false;
		}
	});
}
