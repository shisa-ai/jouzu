import { nativeRequests } from "./native-requests.mjs";

const [root] = process.argv.slice(2);
const f = await nativeRequests({ after() {} }, { root, retainInputs: true });
await f.session.prompt("persisted source");
const [record] = await f.attachment.submissions.snapshot();
process.send({
	file: f.session.sessionManager.getSessionFile(),
	operationId: record.dispatch.operationId,
	sent: f.sent.length,
});
await new Promise(() => {
	setInterval(() => {}, 1000);
});
