import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fresh = spawnSync(process.execPath, [fileURLToPath(new URL("./check-dist-fresh.mjs", import.meta.url))], {
	stdio: "inherit",
});
if (fresh.error) console.error(fresh.error.message);
if (fresh.status !== 0) {
	process.exitCode = fresh.status ?? 1;
} else {
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL("./run-tests.mjs", import.meta.url)),
			fileURLToPath(new URL("../packages/cli/test/flow-task-continuation-integration.test.mjs", import.meta.url)),
		],
		{ stdio: "inherit", env: process.env },
	);
	if (result.error) console.error(result.error.message);
	process.exitCode = result.status ?? 1;
}
