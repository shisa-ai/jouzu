import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join, relative } from "node:path";
import { test } from "node:test";
import { count, launchRpc, response, rpcHome } from "./fixtures/rpc-runtime.mjs";

/** An OpenAI-compatible provider that answers every request with one short reply. */
async function provider(t) {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const { model } = JSON.parse(body);
			const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model };
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		return new Promise((resolve) => server.close(resolve));
	});
	return server.address().port;
}

async function files(root) {
	const found = [];
	const walk = async (dir) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else found.push(relative(root, path));
		}
	};
	await walk(root);
	return found.sort();
}

async function openAndClose(t, home, args = []) {
	const f = launchRpc(t, home, args);
	f.send({ id: "state", type: "get_state" });
	const state = await f.waitFor(() => response(f.frames, "state"), "get_state");
	assert.equal((await f.close()).code, 0);
	return state.data;
}

test("a session opened and closed without a message leaves nothing behind", async (t) => {
	const home = await rpcHome(t, await provider(t));
	const root = join(home.jouzu, "..");

	// The first start sets up the profile once; later empty sessions add nothing.
	await openAndClose(t, home);
	const settled = await files(root);
	for (let run = 0; run < 3; run++) await openAndClose(t, home);
	assert.deepEqual(await files(root), settled);
	assert.deepEqual(await files(home.sessions), []);

	// The first real message creates the session, and the session resumes with it.
	// A setting recorded before the first message moves the transcript, but the session stays unused.
	const f = launchRpc(t, home);
	f.send({ id: "name", type: "set_session_name", name: "named before the first message" });
	await f.waitFor(() => response(f.frames, "name"), "set_session_name");
	f.send({ id: "first", type: "prompt", message: "hello" });
	await f.waitFor(() => response(f.frames, "first"), "first response");
	await f.waitFor(() => count(f.frames, "agent_settled") > 0, "first settled");
	assert.equal(f.frames.findLast((frame) => frame.type === "agent_end").messages.at(-1)?.stopReason, "stop");
	assert.equal((await f.close()).code, 0);
	assert.equal((await files(home.sessions)).filter((path) => path.endsWith(".jsonl")).length, 1);
	const flowFiles = (await files(root)).filter((path) => !settled.includes(path) && path.endsWith("_flow.jsonl"));
	assert.equal(flowFiles.length, 2, "the first message writes the session registry and its branch journal");

	const resumed = launchRpc(t, home, ["--continue"]);
	resumed.send({ id: "messages", type: "get_messages" });
	const messages = await resumed.waitFor(() => response(resumed.frames, "messages"), "get_messages");
	const user = messages.data.messages.find((message) => message.role === "user");
	assert.match(JSON.stringify(user?.content), /hello/u);
	assert.equal((await resumed.close()).code, 0);
	assert.equal((await files(home.sessions)).filter((path) => path.endsWith(".jsonl")).length, 1);
});

test("a second process with the same new session id cannot record a second copy of it", async (t) => {
	const home = await rpcHome(t, await provider(t));
	const root = join(home.jouzu, "..");
	const args = ["--session-id", "shared-session-id"];
	const first = launchRpc(t, home, args);
	const second = launchRpc(t, home, args);
	for (const [f, id] of [
		[first, "first"],
		[second, "second"],
	]) {
		f.send({ id, type: "get_state" });
		await f.waitFor(() => response(f.frames, id), `${id} get_state`);
	}
	first.send({ id: "a", type: "prompt", message: "from the first process" });
	await first.waitFor(() => count(first.frames, "agent_settled") > 0, "first settled");
	assert.equal((await first.close()).code, 0);

	second.send({ id: "b", type: "prompt", message: "from the second process" });
	const refused = await second.waitFor(() => response(second.frames, "b"), "second response");
	assert.equal(refused.success, false, JSON.stringify(refused));
	assert.equal((await second.close()).code, 0);
	const registries = (await files(root)).filter(
		(path) => path.includes("session-registry-v1") && path.endsWith(".jsonl"),
	);
	assert.equal(registries.length, 1, "the session keeps one registry journal");

	// The session still opens.
	const again = launchRpc(t, home, args);
	again.send({ id: "state", type: "get_state" });
	assert.equal((await again.waitFor(() => response(again.frames, "state"), "reopen")).success, true);
	assert.equal((await again.close()).code, 0);
});
