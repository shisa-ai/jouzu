import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { acquireProcessLock } from "../../dist/process-lock.js";

// Contend for one lock, record the protected interval, and exit nonzero if the
// lock could not be acquired within the attempt budget.
const [path, ledger, id, holdMs] = process.argv.slice(2);
for (let attempt = 0; attempt < 2_000; attempt++) {
	let lock;
	try {
		lock = acquireProcessLock(path);
	} catch {
		await delay(5);
		continue;
	}
	appendFileSync(ledger, `start ${id}\n`);
	await delay(Number(holdMs));
	appendFileSync(ledger, `end ${id}\n`);
	lock.release();
	process.exit(0);
}
process.exit(3);
