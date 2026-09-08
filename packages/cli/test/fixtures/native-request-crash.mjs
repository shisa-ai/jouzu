import { nativeRequests } from "./native-requests.mjs";

const [root, phase] = process.argv.slice(2);
const f = await nativeRequests({ after() {} }, { root, retainInputs: true });
const method = phase === "prepared" ? "begin" : phase === "handoff" ? "handoff" : "finish";
const original = f.store[method].bind(f.store);
f.store[method] = async (...args) => {
	if (phase !== "outcome") await original(...args);
	process.send({ scope: f.scope, sent: f.sent.length });
	await new Promise(() => {
		setInterval(() => {}, 1000);
	});
};
await f.session.prompt("crash boundary");
