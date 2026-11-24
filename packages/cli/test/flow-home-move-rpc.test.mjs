import assert from "node:assert/strict";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { count, launchRpc, response, rpcHome } from "./fixtures/rpc-runtime.mjs";

/** An OpenAI-compatible provider that answers every request at once. */
async function provider(t) {
	const bodies = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			if (!req.url.includes("chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			const { model, messages } = JSON.parse(body);
			bodies.push(messages);
			const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model };
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "done" } }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	t.after(() => server.closeAllConnections?.());
	return { port: server.address().port, bodies };
}

/** Every Flow journal under `root`, by path relative to it, with its size. */
async function journals(root) {
	const found = new Map();
	for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const path = join(entry.parentPath ?? entry.path, entry.name);
		found.set(relative(root, path), (await stat(path)).size);
	}
	return found;
}

async function prompt(f, id, message) {
	const settled = count(f.frames, "agent_settled");
	f.send({ id, type: "prompt", message });
	const reply = await f.waitFor(() => response(f.frames, id), `${id} response`);
	assert.equal(reply.success, true, JSON.stringify(reply));
	await f.waitFor(() => count(f.frames, "agent_settled") > settled, `${id} settled`);
	const end = f.frames.findLast((frame) => frame.type === "agent_end");
	assert.equal(end.messages.at(-1)?.stopReason, "stop", JSON.stringify(end.messages.at(-1)));
}

test("a session continues with its Flow state after the Jouzu home moves", async (t) => {
	const fixture = await provider(t);
	const paths = await rpcHome(t, fixture.port);
	// Keep Pi's sessions inside the Jouzu home, so the move carries the transcript with the Flow state.
	paths.sessions = join(paths.jouzu, "sessions");
	await mkdir(paths.sessions, { recursive: true, mode: 0o700 });

	const before = launchRpc(t, paths);
	before.send({ id: "state", type: "get_state" });
	const state = (await before.waitFor(() => response(before.frames, "state"), "first state")).data;
	await prompt(before, "p1", "remember the word lantern");
	await before.close();
	const flowRoot = join(paths.jouzu, "state", "flow");
	const written = await journals(flowRoot);
	assert.ok(written.size >= 2, `the session registry and branch journal exist: ${[...written.keys()]}`);

	const moved = join(dirname(paths.jouzu), "jouzu-moved");
	await rename(paths.jouzu, moved);
	const sessionFile = join(moved, relative(paths.jouzu, state.sessionFile));
	paths.jouzu = moved;
	paths.sessions = join(moved, "sessions");

	const after = launchRpc(t, paths, ["--session", sessionFile]);
	after.send({ id: "state", type: "get_state" });
	const reopened = (await after.waitFor(() => response(after.frames, "state"), "reopened state")).data;
	assert.equal(reopened.sessionId, state.sessionId);
	await prompt(after, "p2", "which word?");
	await after.close();

	// The second request carries the first exchange, so the session itself continued.
	assert.equal(fixture.bodies.length, 2);
	assert.ok(JSON.stringify(fixture.bodies[1]).includes("lantern"));
	// The same journals took the new records: none was replaced, set aside, or started over.
	const continued = await journals(join(moved, "state", "flow"));
	assert.deepEqual([...continued.keys()].sort(), [...written.keys()].sort());
	assert.ok(
		[...written].some(([path, size]) => continued.get(path) > size),
		"the second prompt appended to an existing journal",
	);
	const errors = after.frames.filter(
		(frame) => frame.type === "extension_ui_request" && frame.method === "notify" && frame.notifyType === "error",
	);
	assert.deepEqual(errors, []);
});
