import { join } from "node:path";
import { createFlowSession } from "../../../../scripts/fixtures/pi-flow-session.mjs";
import { PiFlowAttachment } from "../../dist/flow-control/pi-attachment.js";
import { PiNativeDispatch } from "../../dist/flow-control/pi-native-dispatch.js";

const [root, phase] = process.argv.slice(2);
let attachment, native;
const { session, requests } = await createFlowSession(
	{ after() {} },
	{
		root: join(root, "host"),
		persist: true,
		ingress: {
			version: 1,
			async submit(input, dispatch) {
				const retained = await attachment.submissions.retain(input);
				await native.dispatch(retained.id, retained.revision, input.id, dispatch);
			},
		},
	},
);
const scope = { sessionId: session.sessionId, branchId: "main" };
attachment = await PiFlowAttachment.open(join(root, "receipts"), scope);
native = new PiNativeDispatch(session, attachment.submissions);
const context = phase.startsWith("context-");
if (context) session.sessionManager.flush();
if (!phase.startsWith("prompt-") && !context) await session.followUp("one native input");
const checkpoint = async () => {
	process.send({
		scope,
		sessionFile: session.sessionManager.getSessionFile(),
		requests: requests.length,
		queued: session.agent.inspectQueuedMessages().length,
	});
	await new Promise(() => {
		setInterval(() => {}, 1000);
	});
};
if (phase === "context-observed") {
	const dispatch = attachment.submissions.dispatch.bind(attachment.submissions);
	attachment.submissions.dispatch = (id, revision, operation, run) =>
		dispatch(id, revision, operation, (observer, submission) =>
			run(
				{
					observe: async (input) => {
						const index = await observer.observe(input);
						await checkpoint();
						return index;
					},
				},
				submission,
			),
		);
}
const method =
	phase.startsWith("context-claim-") || phase.startsWith("prompt-claim-")
		? "recordPromptClaim"
		: phase.startsWith("context-history-") || phase.startsWith("prompt-")
			? "recordPromptHistory"
			: phase.startsWith("history-")
				? "recordQueueHistory"
				: "recordQueueClaim";
const record = attachment.submissions[method].bind(attachment.submissions);
if (phase !== "context-observed")
	attachment.submissions[method] = async (...args) => {
		if (phase.endsWith("after")) await record(...args);
		await checkpoint();
	};
if (context)
	await session.sendCustomMessage(
		{ customType: "note", content: "one retained context", display: true },
		{ triggerTurn: false },
	);
else if (phase.startsWith("prompt-")) await session.prompt("one native prompt");
else await session.continueQueued();
