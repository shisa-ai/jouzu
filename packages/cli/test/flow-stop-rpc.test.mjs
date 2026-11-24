import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { count, lastStatus, launchRpc, quiet, response, rpcHome } from "./fixtures/rpc-runtime.mjs";

/** An OpenAI-compatible provider that streams slowly, so a Stop always lands inside the run. */
async function slowProvider(t) {
	const requests = [];
	const bodies = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", async () => {
			if (!req.url.includes("chat/completions")) {
				res.writeHead(404).end();
				return;
			}
			const { model, messages } = JSON.parse(body);
			requests.push(model);
			bodies.push(messages);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const base = { id: "fixture", object: "chat.completion.chunk", created: 1, model };
			let closed = false;
			res.on("close", () => {
				closed = true;
			});
			for (let i = 1; i <= 50 && !closed; i++) {
				res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: `part${i} ` } }] })}\n\n`);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (closed) return;
			res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	t.after(() => server.closeAllConnections?.());
	return { port: server.address().port, requests, bodies };
}

test("Stop is final at every point of a prompt and never leaves Flow work behind", async (t) => {
	const provider = await slowProvider(t);
	const f = launchRpc(t, await rpcHome(t, provider.port));
	f.send({ id: "ready", type: "get_state" });
	await f.waitFor(() => response(f.frames, "ready"), "rpc ready");

	// Stop delivered together with the prompt: the prompt is cancelled before any run starts.
	const runsBefore = count(f.frames, "agent_start");
	f.send({ id: "p0", type: "prompt", message: "first" }, { id: "a0", type: "abort" });
	const p0 = await f.waitFor(() => response(f.frames, "p0"), "immediate stop response");
	assert.equal(p0.success, true, JSON.stringify(p0));
	assert.equal(p0.data?.disposition, "aborted");
	await quiet(500);
	assert.equal(count(f.frames, "agent_start"), runsBefore, "an aborted prompt must not start a run");
	assert.equal(provider.requests.length, 0);

	// Stop shortly after the prompt and while the reply streams: each run ends aborted.
	for (const [index, delay] of [30, 60, 400].entries()) {
		const id = `p${index + 1}`;
		const settled = count(f.frames, "agent_settled");
		f.send({ id, type: "prompt", message: `prompt ${id}` });
		await quiet(delay);
		f.send({ id: `a${index + 1}`, type: "abort" });
		const reply = await f.waitFor(() => response(f.frames, id), `${id} response`);
		assert.equal(reply.success, true, JSON.stringify(reply));
		if (reply.data?.disposition === "aborted") continue;
		await f.waitFor(() => count(f.frames, "agent_settled") > settled, `${id} settled`);
		const end = f.frames.findLast((frame) => frame.type === "agent_end");
		assert.equal(end.messages.at(-1)?.stopReason, "aborted", `${id} after ${delay}ms`);
	}

	// Nothing runs on its own after the Stops, and Flow holds nothing back.
	const runsAfterStops = count(f.frames, "agent_start");
	await quiet(1000);
	assert.equal(count(f.frames, "agent_start"), runsAfterStops, "Flow must not start work after Stop");

	// The next message runs normally instead of being held for a recovery decision.
	const settled = count(f.frames, "agent_settled");
	f.send({ id: "next", type: "prompt", message: "after the stops" });
	const next = await f.waitFor(() => response(f.frames, "next"), "next response");
	assert.equal(next.data?.disposition, "started", JSON.stringify(next));
	await f.waitFor(() => count(f.frames, "agent_settled") > settled, "next settled", 15_000);
	assert.equal(f.frames.findLast((frame) => frame.type === "agent_end").messages.at(-1)?.stopReason, "stop");
	const status = lastStatus(f.frames, "jouzu-flow");
	assert.ok(status, "flow status published");
	assert.equal(status.recovery, undefined, JSON.stringify(status));
	assert.deepEqual(status.held, []);
	assert.deepEqual(status.withheld, []);
	assert.deepEqual(status.uncertain, []);
	assert.equal((await f.close()).code, 0, "the runtime shuts down cleanly after the Stops");
});

test("a message sent together with a Stop runs after it, without a hold and with the stopped message kept", async (t) => {
	const provider = await slowProvider(t);
	const f = launchRpc(t, await rpcHome(t, provider.port));
	f.send({ id: "ready", type: "get_state" });
	await f.waitFor(() => response(f.frames, "ready"), "rpc ready");
	// A conversation already stored, so the Stop lands at the same point of every later prompt.
	f.send({ id: "warm", type: "prompt", message: "warm up" });
	await f.waitFor(() => count(f.frames, "agent_settled") > 0, "warm-up answered", 20_000);
	for (const [index, delay] of [10, 30, 400].entries()) {
		const stopped = `stop me ${index}`;
		const next = `right after the stop ${index}`;
		const settled = count(f.frames, "agent_settled");
		f.send({ id: `p${index}`, type: "prompt", message: stopped });
		await quiet(delay);
		f.send({ id: `a${index}`, type: "abort" }, { id: `n${index}`, type: "prompt", message: next });
		const reply = await f.waitFor(() => response(f.frames, `n${index}`), "next response", 20_000);
		assert.equal(reply.success, true, `${delay} ms: ${JSON.stringify(reply)}`);
		await f.waitFor(
			() =>
				f.frames
					.filter((frame) => frame.type === "agent_end")
					.at(-1)
					?.messages.at(-1)?.stopReason === "stop" && count(f.frames, "agent_settled") > settled,
			`${delay} ms: next message answered`,
			20_000,
		);
		const sent = JSON.stringify(provider.bodies.at(-1));
		assert.ok(sent.includes(next), `${delay} ms: the next message reaches the model`);
		// A prompt the Stop cancelled before its turn started never entered the conversation; one whose
		// turn had started stays in it, as it does after a Stop without flow control.
		const cancelled = response(f.frames, `p${index}`)?.data?.disposition === "aborted";
		f.send({ id: `m${index}`, type: "get_messages" });
		const history = JSON.stringify((await f.waitFor(() => response(f.frames, `m${index}`), "messages")).data);
		assert.equal(history.includes(stopped), !cancelled, `${delay} ms: transcript`);
		assert.equal(
			sent.includes(stopped),
			!cancelled,
			`${delay} ms: the stopped message is sent as the transcript holds it`,
		);
	}
	const holds = f.frames.filter(
		(frame) =>
			frame.type === "extension_ui_request" && frame.method === "notify" && /holding your message/.test(frame.message),
	);
	assert.deepEqual(holds, [], "no message is reported as held");
	assert.equal((await f.close()).code, 0);
});

test("a message sent after a stopped run ended but before it settled is not reported held", async (t) => {
	const provider = await slowProvider(t);
	const home = await rpcHome(t, provider.port);
	// Pi clears the run's abort signal when the run ends and emits agent_settled only after every
	// extension's handler for it. Holding the handler open keeps the run in that interval, so a
	// message sent then is admitted while the stopped run's outcome is not yet recorded.
	const extension = join(home.workspace, "delayed-settle.mjs");
	await writeFile(
		extension,
		[
			"export default function (pi) {",
			'\tpi.on("before_provider_request", (event, ctx) => {',
			'\t\tctx.ui.notify("fixture: preparing", "info");',
			"\t\treturn new Promise((resolve) => setTimeout(() => resolve(event.payload), 1000));",
			"\t});",
			'\tpi.on("agent_settled", (_event, ctx) => {',
			'\t\tctx.ui.notify("fixture: settling", "info");',
			"\t\treturn new Promise((resolve) => setTimeout(resolve, 1500));",
			"\t});",
			"}",
			"",
		].join("\n"),
	);
	const f = launchRpc(t, home, ["--extension", extension]);
	f.send({ id: "ready", type: "get_state" });
	await f.waitFor(() => response(f.frames, "ready"), "rpc ready");
	f.send({ id: "warm", type: "prompt", message: "warm up" });
	await f.waitFor(() => count(f.frames, "agent_settled") > 0, "warm-up answered", 20_000);

	const ends = count(f.frames, "agent_end");
	const settled = count(f.frames, "agent_settled");
	const requests = provider.requests.length;
	const notices = (message) =>
		f.frames.filter((frame) => frame.method === "notify" && frame.message === message).length;
	const settling = () => notices("fixture: settling");
	const preparing = notices("fixture: preparing");
	const before = settling();
	f.send({ id: "p", type: "prompt", message: "stop me" });
	// Stop while the request is still being prepared, so it is never handed to the provider.
	await f.waitFor(() => notices("fixture: preparing") > preparing, "stopped request in preparation");
	f.send({ id: "a", type: "abort" });
	await f.waitFor(() => count(f.frames, "agent_end") > ends && settling() > before, "stopped run settling");
	assert.equal(count(f.frames, "agent_settled"), settled, "the stopped run has not settled yet");
	f.send({ id: "n", type: "prompt", message: "sent before the stop settled" });
	const reply = await f.waitFor(() => response(f.frames, "n"), "next response", 20_000);
	assert.equal(reply.success, true, JSON.stringify(reply));
	await f.waitFor(
		() =>
			f.frames
				.filter((frame) => frame.type === "agent_end")
				.at(-1)
				?.messages.at(-1)?.stopReason === "stop",
		"next message answered",
		20_000,
	);
	assert.ok(JSON.stringify(provider.bodies.at(-1)).includes("sent before the stop settled"));
	assert.equal(provider.requests.length, requests + 1, "the stopped request is never sent");
	const holds = f.frames.filter(
		(frame) =>
			frame.type === "extension_ui_request" && frame.method === "notify" && /holding your message/.test(frame.message),
	);
	assert.deepEqual(holds, [], "no message is reported as held");
	assert.equal((await f.close()).code, 0);
});

test("a Stop stays the user's when compaction aborts the run again before it settles", async (t) => {
	const provider = await slowProvider(t);
	const home = await rpcHome(t, provider.port);
	// As above: the request is stopped while it is still being prepared, and the run is held in its
	// settle handler. Compaction aborts the run again in that interval, keeping prompts.
	const extension = join(home.workspace, "delayed-settle.mjs");
	await writeFile(
		extension,
		[
			"export default function (pi) {",
			'\tpi.on("before_provider_request", (event, ctx) => {',
			'\t\tctx.ui.notify("fixture: preparing", "info");',
			"\t\treturn new Promise((resolve) => setTimeout(() => resolve(event.payload), 1000));",
			"\t});",
			'\tpi.on("agent_settled", (_event, ctx) => {',
			'\t\tctx.ui.notify("fixture: settling", "info");',
			"\t\treturn new Promise((resolve) => setTimeout(resolve, 1500));",
			"\t});",
			"}",
			"",
		].join("\n"),
	);
	const f = launchRpc(t, home, ["--extension", extension]);
	f.send({ id: "ready", type: "get_state" });
	await f.waitFor(() => response(f.frames, "ready"), "rpc ready");
	f.send({ id: "warm", type: "prompt", message: "warm up" });
	await f.waitFor(() => count(f.frames, "agent_settled") > 0, "warm-up answered", 20_000);

	const notices = (message) =>
		f.frames.filter((frame) => frame.method === "notify" && frame.message === message).length;
	const preparing = notices("fixture: preparing");
	const settling = notices("fixture: settling");
	const settled = count(f.frames, "agent_settled");
	f.send({ id: "p", type: "prompt", message: "stop me" });
	await f.waitFor(() => notices("fixture: preparing") > preparing, "stopped request in preparation");
	f.send({ id: "a", type: "abort" });
	await f.waitFor(() => notices("fixture: settling") > settling, "stopped run settling");
	f.send({ id: "c", type: "compact" });
	await f.waitFor(() => count(f.frames, "agent_settled") > settled && response(f.frames, "c"), "stop settled");
	await quiet(500);
	const status = lastStatus(f.frames, "jouzu-flow");
	assert.ok(status, "flow status published");
	assert.deepEqual(status.withheld, [], JSON.stringify(status));
	assert.deepEqual(status.held, [], JSON.stringify(status));
	assert.equal(status.recovery, undefined, JSON.stringify(status));

	const ends = count(f.frames, "agent_end");
	f.send({ id: "n", type: "prompt", message: "after the stop" });
	await f.waitFor(
		() =>
			count(f.frames, "agent_end") > ends &&
			f.frames
				.filter((frame) => frame.type === "agent_end")
				.at(-1)
				?.messages.at(-1)?.stopReason === "stop",
		"next message answered",
		20_000,
	);
	const holds = f.frames.filter(
		(frame) =>
			frame.type === "extension_ui_request" && frame.method === "notify" && /holding your message/.test(frame.message),
	);
	assert.deepEqual(holds, [], "no message is reported as held");
	assert.equal((await f.close()).code, 0);
});
