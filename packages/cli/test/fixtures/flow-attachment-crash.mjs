import { BACKGROUND_CONTEXT as context, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { PiFlowAttachment } from "../../dist/flow-control/pi-attachment.js";

const [root] = process.argv.slice(2);
let metadata;
const attachment = await PiFlowAttachment.open(root, { sessionId: "parent", branchId: "branch" }, async (directory) => {
	const repo = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: directory }), sessionsRoot: directory });
	const session = await repo.create({ cwd: directory }, context);
	metadata = session.metadata;
	return session;
});
const member = { id: "result", revision: "1", kind: "result", required: false, contentHash: "a".repeat(64) };
const queue = { id: "queue", revision: 1 };
await attachment.ledger.select("attempt", [member]);
await attachment.ledger.queued("attempt", queue);
await attachment.ledger.claim("attempt", queue);
await attachment.ledger.prepare("attempt", "request", [{ ...member, disposition: "included" }], false);
await attachment.ledger.handoff("attempt", "request");
process.send({ metadata });
setInterval(() => {}, 1000);
