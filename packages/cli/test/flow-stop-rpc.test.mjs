import assert from "node:assert/strict";
import { createServer } from "node:http";
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

test("a request cut off by a killed process is reported as uncertain after a restart", async (t) => {
	const provider = await slowProvider(t);
	const home = await rpcHome(t, provider.port);
	const first = launchRpc(t, home);
	first.send({ id: "p", type: "prompt", message: "interrupted" });
	await first.waitFor(() => provider.requests.length > 0, "provider request");
	await quiet(300);
	await first.stop();

	const second = launchRpc(t, home, ["--continue"]);
	second.send({ id: "ready", type: "get_state" });
	await second.waitFor(() => response(second.frames, "ready"), "rpc ready");
	const status = await second.waitFor(() => {
		const latest = lastStatus(second.frames, "jouzu-flow");
		return latest?.recovery ? latest : undefined;
	}, "recovery status");
	assert.ok(status.uncertain.length > 0, JSON.stringify(status));
	assert.equal(provider.requests.length, 1, "the cut-off request is never resent");
	assert.equal((await second.close()).code, 0);
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
