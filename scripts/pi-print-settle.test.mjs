import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const printModule = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/print-mode.js", import.meta.url)
	.href;
function run(mode, behavior = "complete") {
	return spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		import { runPrintMode } from ${JSON.stringify(printModule)};
		let disposed = false;
		const session = {
			state: { messages: [] },
			sessionManager: { getHeader: () => ({type: "session"}) },
			agent: { subscribe: () => () => {} },
			bindExtensions: async () => {}, subscribe: () => () => {},
			prompt: async () => { session.state.messages = [{role: "assistant", content: [{type:"text", text:"WAITING"}]}]; },
			_flowBinding: { settlePrint: async (signal) => {
				if (${JSON.stringify(behavior)} === "signal") {
					const keepAlive = setInterval(() => {}, 1000);
					setTimeout(() => process.kill(process.pid, "SIGTERM"), 20);
					await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once:true}));
				}
				await new Promise(resolve => setTimeout(resolve, 20));
				if (disposed) throw Error("disposed before settlement");
				if (${JSON.stringify(behavior)} === "failure") throw Error("settlement failure");
				session.state.messages = [{role:"assistant", content:[{type:"text", text:"COMPLETED"}]}];
				process.stderr.write("settled\\n");
			} },
		};
		const runtime = { session, setRebindSession() {}, dispose: async () => { disposed = true; process.stderr.write("disposed\\n"); } };
		process.exitCode = await runPrintMode(runtime, { mode: ${JSON.stringify(mode)}, messages:["fixture"] });
	`,
		],
		{ encoding: "utf8", timeout: 5000 },
	);
}

for (const mode of ["text", "json"]) {
	test(`print ${mode} settles before disposal and final output`, () => {
		const result = run(mode);
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "settled\ndisposed\n");
		assert.doesNotMatch(result.stdout, /WAITING/);
		if (mode === "text") assert.equal(result.stdout, "COMPLETED\n");
	});
}
test("print settlement failure exits nonzero and still disposes", () => {
	const result = run("text", "failure");
	assert.ifError(result.error);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /settlement failure\ndisposed/);
	assert.equal(result.stdout, "");
});
test("print SIGTERM cancels settlement and disposes without a success answer", () => {
	const result = run("text", "signal");
	assert.ifError(result.error);
	assert.equal(result.status, 143, result.stderr);
	assert.match(result.stderr, /disposed/);
	assert.doesNotMatch(result.stdout, /COMPLETED/);
});
