import { FlowOwnership } from "../../dist/flow-control/ownership.js";

const [root, sessionId, branchId] = process.argv.slice(2);
let owner;
process.on("message", async (message) => {
	if (message === "acquire") {
		try {
			owner = FlowOwnership.acquire(root, { sessionId, branchId });
			process.send({ state: "owned", token: owner.token });
		} catch (error) {
			process.send({ state: "failed", code: error.code, message: error.message });
		}
	} else if (message === "close") {
		await owner?.close();
		process.send({ state: "closed" });
	} else if (message === "fail-close") {
		try {
			await owner.close(() => {
				throw new Error("Storage close failed");
			});
		} catch (error) {
			owner = undefined;
			globalThis.gc?.();
			process.send({ state: "failed-close", code: error.code });
		}
	}
});
process.send({ state: "ready" });
