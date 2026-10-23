import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "./flow-session-ingress.mjs";

/**
 * Crash fixture for an external user-input record.
 *
 * "retained" stops after the adapter retained the message and admission held it, so the journal has
 * no dispatch intent. "intent" writes dispatch intent and kills the process before the native
 * callback can produce input. Both report the exact root, session file, target, and payload the
 * parent needs to reopen the same branch.
 */
const mode = process.argv[2];
if (mode !== "retained" && mode !== "intent") throw new Error(`Unknown external crash mode: ${mode}`);
const messageId = "crash";
const text = "crash retained";
const deliverAs = "followUp";
// The shared fixture registers cleanup through the test context; this process is killed instead.
const t = { after() {} };
const agentDir = await mkdtemp(join(tmpdir(), "jouzu-external-crash-config-"));
const extensionPath = join(agentDir, "extension.ts");
await writeFile(extensionPath, "export default () => {};\n");
const extensionId = await realpath(extensionPath);
await writeFile(
	join(agentDir, "user-input-adapters.json"),
	JSON.stringify({ schemaVersion: 1, grants: [{ extensionPath: extensionId, adapterId: "fixture" }] }),
);
const f = await fixture(t, { agentDir, admit: async () => false });
const adapter = await f.session._flowBinding.registerUserInputAdapter(extensionId, {
	id: "fixture",
	label: "Fixture",
});
const binding = await adapter.bind();
const receipt = await adapter.submit({ binding, messageId, text, deliverAs });
if (receipt.state !== "held") throw new Error(`External input was not held: ${receipt.state}`);
const [record] = (await f.ingress.branch().attachment.submissions.snapshot()).filter(
	(item) => item.submission.externalUser,
);
const report = {
	root: f.root,
	agentDir,
	extensionId,
	sessionFile: f.session.sessionManager.getSessionFile(),
	messageId,
	text,
	deliverAs,
	target: binding.target,
};
const send = (phase) =>
	new Promise((resolve, reject) => {
		process.send({ ...report, phase }, (error) => (error ? reject(error) : resolve()));
	});
if (mode === "intent") {
	await f.ingress.branch().attachment.submissions.dispatch(record.id, record.revision, "crash-operation", async () => {
		await send("intent");
		process.kill(process.pid, "SIGKILL");
		await new Promise(() => {});
	});
} else {
	await send("retained");
	setInterval(() => {}, 1000);
}
