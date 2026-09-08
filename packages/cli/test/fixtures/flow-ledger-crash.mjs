import { appendFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createPiLedgerStore } from "../../dist/flow-control/pi-ledger-store.js";
import { FlowReceiptLedger } from "../../dist/flow-control/receipt-ledger.js";

const [root, checkpoint] = process.argv.slice(2);
let tearNext = false;
class InterruptedFileSystem extends NodeExecutionEnv {
	async appendFile(path, content, currentContext) {
		if (!tearNext) return super.appendFile(path, content, currentContext);
		await appendFile(path, content.slice(0, Math.floor(content.length / 2)));
		process.send({ ready: true, metadata: session.metadata });
		return new Promise(() => {});
	}
}
const repo = new JsonlSessionRepo({ fileSystem: new InterruptedFileSystem({ cwd: root }), sessionsRoot: root });
const session = await repo.create({ cwd: root }, context);
const ledger = await FlowReceiptLedger.attach(createPiLedgerStore(session), {
	sessionId: "parent",
	branchId: "branch-a",
});
const member = { id: "result", revision: "execution-1", kind: "result", required: false, contentHash: "a".repeat(64) };
const queue = { id: "queue", revision: 1 };
await ledger.select("attempt", [member]);
await ledger.queued("attempt", queue);
await ledger.claim("attempt", queue);
await ledger.history("attempt", [{ id: member.id, revision: member.revision, entryId: "history" }]);
await ledger.prepare(
	"attempt",
	"request",
	[{ id: member.id, revision: member.revision, disposition: "included", contentHash: member.contentHash }],
	false,
);
if (checkpoint === "torn-handoff") tearNext = true;
if (checkpoint !== "before-handoff") await ledger.handoff("attempt", "request");
process.send({ ready: true, metadata: session.metadata });
// Parent kills the live process at the named durable boundary; no orderly close occurs.
setInterval(() => {}, 1000);
