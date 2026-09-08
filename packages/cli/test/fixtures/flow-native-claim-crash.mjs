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
await session.followUp("one native input");
const record = attachment.submissions.recordQueueClaim.bind(attachment.submissions);
attachment.submissions.recordQueueClaim = async (...args) => {
	if (phase === "after") await record(...args);
	process.send({ scope, requests: requests.length, queued: session.agent.inspectQueuedMessages().length });
	await new Promise(() => {
		setInterval(() => {}, 1000);
	});
};
await session.continueQueued();
