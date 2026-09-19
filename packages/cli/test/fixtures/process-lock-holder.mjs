import { acquireProcessLock } from "../../dist/process-lock.js";

const [path] = process.argv.slice(2);
let lock;
process.on("message", (message) => {
	if (message === "acquire") {
		try {
			lock = acquireProcessLock(path);
			process.send({ state: "held" });
		} catch (error) {
			process.send({ state: "failed", reason: error.reason ?? null, message: error.message });
		}
	} else if (message === "release") {
		lock?.release();
		lock = undefined;
		process.send({ state: "released" });
	}
});
process.send({ state: "ready" });
