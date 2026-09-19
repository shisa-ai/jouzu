import { DatabaseSync } from "node:sqlite";
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
	} else if (message === "fail-release") {
		const close = DatabaseSync.prototype.close;
		DatabaseSync.prototype.close = () => {
			throw new Error("Injected close failure");
		};
		let first;
		let repeated;
		try {
			try {
				lock.release();
			} catch (error) {
				first = error;
			}
			try {
				lock.release();
			} catch (error) {
				repeated = error;
			}
		} finally {
			DatabaseSync.prototype.close = close;
		}
		lock = undefined;
		global.gc();
		process.send({ state: "failed-release", reason: first?.reason, repeated: first === repeated });
	} else if (message === "fail-acquire-close") {
		const exec = DatabaseSync.prototype.exec;
		const close = DatabaseSync.prototype.close;
		DatabaseSync.prototype.exec = function (sql) {
			exec.call(this, sql);
			throw new Error("Injected acquisition failure after reservation");
		};
		DatabaseSync.prototype.close = () => {
			throw new Error("Injected cleanup failure");
		};
		let failure;
		try {
			try {
				acquireProcessLock(path);
			} catch (error) {
				failure = error;
			}
		} finally {
			DatabaseSync.prototype.exec = exec;
			DatabaseSync.prototype.close = close;
		}
		global.gc();
		process.send({ state: "failed-acquire-close", reason: failure?.reason, causes: failure?.cause?.errors?.length });
	} else if (message === "release") {
		lock?.release();
		lock = undefined;
		process.send({ state: "released" });
	}
});
process.send({ state: "ready" });
