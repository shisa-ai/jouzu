import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createFlowSession } from "../../../../scripts/fixtures/pi-flow-session.mjs";
import { FlowModelInput } from "../../dist/flow-control/model-input.js";
import { PiFlowAttachment } from "../../dist/flow-control/pi-attachment.js";
import { PiHistoryReceipts } from "../../dist/flow-control/pi-history-receipts.js";
import { PiQueueReceipts } from "../../dist/flow-control/pi-queue-receipts.js";

const [root, boundary] = process.argv.slice(2);
await mkdir(join(root, "host"));
const host = await createFlowSession({ after() {} }, { root: join(root, "host"), persist: true });
const scope = { sessionId: host.session.sessionId, branchId: "main" };
const attachment = await PiFlowAttachment.open(join(root, "receipts"), scope);
const queue = new PiQueueReceipts(host.session.agent, attachment.ledger);
new PiHistoryReceipts(host.session, attachment.ledger);
await host.session.prompt("initial");
host.requests.length = 0;
const composition = FlowModelInput.compose(
	"attempt",
	[{ id: "work", revision: "1", kind: "work", text: "owned instruction" }],
	4096,
);
await attachment.ledger.select("attempt", composition.members);
await queue.enqueue("attempt", () => {
	host.session.agent.followUp({ role: "user", content: composition.content, timestamp: 1 });
});
const history = attachment.ledger.history.bind(attachment.ledger);
attachment.ledger.history = async (id, receipts) => {
	if (boundary === "after-receipt") await history(id, receipts);
	process.send({
		scope,
		receipt: receipts[0],
		historyFile: host.session.sessionManager.getSessionFile(),
		requests: host.requests.length,
	});
	await new Promise(() => {});
};
setInterval(() => {}, 1000);
await host.session.agent.continue();
