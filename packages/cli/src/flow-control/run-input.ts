/**
 * Whether the run a request belongs to carries user instruction.
 *
 * No-reply permission may only be granted to a notification-only run, so this decides what "the
 * current run" contains. The whole conversation is replayed on every request, so history is not the
 * question: only the trailing block after the last assistant turn is this run's input. A user
 * message there is real instruction unless every text part exactly matches content from the active
 * flow composition.
 *
 * It errs toward withholding: anything unparseable, unfamiliar, or not provably flow-injected counts
 * as user input, because wrongly granting silence loses a reply the user asked for.
 */
export function flowRunContainsUserInput(
	messages: readonly { role: string; content?: unknown }[],
	composition: { readonly content: readonly { type: string; text?: unknown }[] },
): boolean {
	if (!Array.isArray(messages)) return true;
	const flowTexts = new Set<string>();
	for (const part of composition.content)
		if (part.type === "text" && typeof part.text === "string") flowTexts.add(part.text);
	let start = 0;
	for (let index = messages.length - 1; index >= 0; index--)
		if (messages[index]?.role === "assistant") {
			start = index + 1;
			break;
		}
	for (const message of messages.slice(start)) {
		if (message?.role !== "user") continue;
		if (!isFlowInjected(message.content, flowTexts)) return true;
	}
	return false;
}

/** Every part must be text the active composition produced, not merely JSON with a flowInput key. */
function isFlowInjected(content: unknown, flowTexts: ReadonlySet<string>): boolean {
	if (typeof content === "string") return false;
	if (!Array.isArray(content) || content.length === 0) return false;
	return content.every((part) => {
		if (!part || typeof part !== "object") return false;
		const text =
			(part as { type?: string; text?: unknown }).type === "text" ? (part as { text?: unknown }).text : undefined;
		return typeof text === "string" && flowTexts.has(text);
	});
}
