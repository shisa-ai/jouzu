import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { bindPiFlowBranch } from "../../dist/flow-control/pi-branch-binding.js";
import { PiFlowSessionRegistry } from "../../dist/flow-control/pi-session-registry.js";

const [root] = process.argv.slice(2);
const manager = SessionManager.create(root, join(root, "child-history"));
const registry = await PiFlowSessionRegistry.open(root, manager.getSessionId(), manager.getLeafId());
await bindPiFlowBranch(registry, manager);
const transition = await registry.beginNavigation((await registry.snapshot()).revision, manager.getLeafId());
manager.resetLeaf();
manager.appendCustomEntry("jouzu-flow-branch", {
	version: 1,
	sessionId: manager.getSessionId(),
	branchId: transition.branchId,
	transitionId: transition.id,
});
manager.flush();
process.send({ path: manager.getSessionFile(), branchId: transition.branchId });
setInterval(() => {}, 1000);
