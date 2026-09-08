import { PiFlowAttachment } from "../../dist/flow-control/pi-attachment.js";

const attachment = await PiFlowAttachment.open(process.argv[2], { sessionId: "parent", branchId: "main" });
await attachment.submissions.retain({
	version: 1,
	id: "durable",
	api: "prompt",
	origin: { kind: "host", id: "prompt" },
	scope: { sessionId: "parent", attachmentId: "first", leafId: null },
	args: ["survives process death", undefined],
});
process.send({ saved: true });
setInterval(() => {}, 1000);
