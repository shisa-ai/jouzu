import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { count, lastStatus, launchRpc, response, rpcHome } from "./fixtures/rpc-runtime.mjs";

// A 256x1 PNG: below the minimum side a provider accepts.
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAQAAAAABCAYAAAAxWXB3AAAAFElEQVR4nGP4z8DwfxSP4lE8MjEAPtT+ELMvmaEAAAAASUVORK5CYII=";
const REJECTION =
	'{"code":"invalid_parameter_error","message":"The image length and width do not meet the model restrictions. [height:1 or width:256 must be larger than 10]","type":"invalid_request_error"}';

/** Rejects any request that carries an image, as a provider does for an image below its minimum size. */
async function imageRejectingProvider(t) {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			const { model, messages } = JSON.parse(body);
			const text = JSON.stringify(messages);
			const images = (text.match(/"type":"image_url"/gu) ?? []).length;
			requests.push({ images, omitted: text.includes("[image omitted]") });
			if (images) {
				res.writeHead(400, { "content-type": "application/json" }).end(REJECTION);
				return;
			}
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
	return { port: server.address().port, requests };
}

async function turn(f, id, message, extra = {}) {
	const settled = count(f.frames, "agent_settled");
	f.send({ id, type: "prompt", message, ...extra });
	await f.waitFor(() => response(f.frames, id), `${id} response`);
	await f.waitFor(() => count(f.frames, "agent_settled") > settled, `${id} settled`);
	return f.frames.findLast((frame) => frame.type === "agent_end").messages.at(-1);
}

async function command(f, id, message) {
	const notices = f.frames.filter((frame) => frame.method === "notify").length;
	f.send({ id, type: "prompt", message });
	await f.waitFor(() => response(f.frames, id), `${id} response`);
	await f.waitFor(() => f.frames.filter((frame) => frame.method === "notify").length > notices, `${id} notice`);
	return f.frames.findLast((frame) => frame.method === "notify");
}

test("a rejected image stays out of later requests only after the user omits it", async (t) => {
	const provider = await imageRejectingProvider(t);
	const home = await rpcHome(t, provider.port, { input: ["text", "image"] });
	const f = launchRpc(t, home);

	const rejected = await turn(f, "image", "what is this?", {
		images: [{ type: "image", data: TINY_PNG, mimeType: "image/png" }],
	});
	assert.equal(rejected.stopReason, "error");
	assert.deepEqual(lastStatus(f.frames, "jouzu-images"), {
		version: 1,
		rejected: { code: "image_rejected", images: 1 },
		omitted: 0,
	});
	const warning = f.frames.findLast((frame) => frame.method === "notify" && frame.notifyType === "warning");
	assert.match(warning.message, /\/images omit/u);

	// Nothing is dropped on its own: the next turn resends the image and fails the same way.
	assert.equal((await turn(f, "again", "hello")).stopReason, "error");
	assert.equal(provider.requests.at(-1).images, 1);

	assert.match((await command(f, "omit", "/images omit")).message, /One image/u);
	assert.deepEqual(lastStatus(f.frames, "jouzu-images"), { version: 1, omitted: 1 });
	assert.equal((await turn(f, "after", "hello")).stopReason, "stop");
	assert.deepEqual(provider.requests.at(-1), { images: 0, omitted: true });

	// The choice is part of the session: a restarted runtime keeps the image out.
	await f.stop();
	const resumed = launchRpc(t, home, ["--continue"]);
	assert.equal((await turn(resumed, "resumed", "still there?")).stopReason, "stop");
	assert.deepEqual(provider.requests.at(-1), { images: 0, omitted: true });

	// Restoring sends the image again.
	await command(resumed, "restore", "/images restore");
	assert.equal((await turn(resumed, "restored", "and now?")).stopReason, "error");
	assert.equal(provider.requests.at(-1).images, 1);
	assert.equal((await resumed.close()).code, 0);
});

test("a provider error that does not name an image is not an image rejection", async () => {
	const { isImageRejection } = await import("../dist/image-omission.js");
	assert.equal(isImageRejection(`400: ${REJECTION}`), true);
	assert.equal(isImageRejection("400: maximum context length exceeded"), false);
	assert.equal(isImageRejection("429: too many requests for image models"), false);
	assert.equal(isImageRejection("500: image service unavailable"), false);
	assert.equal(isImageRejection(undefined), false);
});
