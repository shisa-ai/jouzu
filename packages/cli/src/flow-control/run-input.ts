import type { NativeSourceCapture } from "./native-request-store.js";

/**
 * Whether the run a request belongs to carries user instruction.
 *
 * No-reply permission may only be granted to a notification-only run, so this decides what "the
 * current run" contains. Two carried facts answer it, and no message content is compared:
 *
 * - **Position.** The whole conversation replays on every request, so history is not the question:
 *   only the block after the last assistant turn is this run's input. Each retained source's place in
 *   the converted model input was recorded at conversion, so the boundary is arithmetic.
 * - **Origin.** Whether a source is user instruction is the origin the host assigned to its
 *   submission, never a label, a marker, or matching text. Controller-composed input is not a
 *   retained source at all, so a run carrying only composed input carries no user instruction.
 *
 * It errs toward withholding: a request with no conversion evidence, or one whose sources cannot be
 * placed, counts as carrying user input, because wrongly granting silence loses a reply the user
 * asked for.
 */
export function flowRunContainsUserInput(
	modelMessages: readonly { role?: string }[],
	capture: NativeSourceCapture | undefined,
	userOperations: ReadonlySet<string> | undefined,
): boolean {
	if (!capture?.model || !userOperations || !Array.isArray(modelMessages)) return true;
	let boundary = 0;
	for (let index = modelMessages.length - 1; index >= 0; index--)
		if (modelMessages[index]?.role === "assistant") {
			boundary = index + 1;
			break;
		}
	return capture.members.some((member, offset) => {
		if (!userOperations.has(member.operationId)) return false;
		const model = capture.model?.members[offset];
		// A source with no recorded position cannot be placed outside this run's input.
		if (!model || model.sourceIndex !== member.index || model.index === undefined) return true;
		return model.index >= boundary;
	});
}
