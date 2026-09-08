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
if (!phase.startsWith("prompt-")) await session.followUp("one native input");
const method = phase.startsWith("prompt-claim-")
	? "recordPromptClaim"
	: phase.startsWith("prompt-")
		? "recordPromptHistory"
		: phase.startsWith("history-")
			? "recordQueueHistory"
			: "recordQueueClaim";
const record = attachment.submissions[method].bind(attachment.submissions);
attachment.submissions[method] = async (...args) => {
	if (phase.endsWith("after")) await record(...args);
	process.send({ scope, requests: requests.length, queued: session.agent.inspectQueuedMessages().length });
	await new Promise(() => {
		setInterval(() => {}, 1000);
	});
};
if (phase.startsWith("prompt-")) await session.prompt("one native prompt");
else await session.continueQueued();
