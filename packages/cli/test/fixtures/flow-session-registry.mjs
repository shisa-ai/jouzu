import { PiFlowSessionRegistry } from "../../dist/flow-control/pi-session-registry.js";

const [root, phase] = process.argv.slice(2);
const registry = await PiFlowSessionRegistry.open(root, "parent", null);
const transition = await registry.beginNavigation((await registry.snapshot()).revision, "old-leaf");
if (phase === "finish") await registry.finishNavigation(transition.id, "new-leaf");
process.send({ kind: "saved", state: await registry.snapshot() });
setInterval(() => {}, 1000);
