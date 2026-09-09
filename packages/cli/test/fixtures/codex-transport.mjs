import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	stream,
} from "@earendil-works/pi-ai/api/openai-codex-responses";

export const codexKey = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64")}.fixture`;
export const codexMessage = (id, text = "Done") => ({
	type: "message",
	role: "assistant",
	content: [{ type: "output_text", text, annotations: [] }],
	status: "completed",
	id,
});

/** Simulate the server's cached response context independently of Pi's client cache. */
export function codexTransport(t, { transport = "auto", reply, fail, onRequest, sessionId = randomUUID() } = {}) {
	const requests = [],
		cache = new Map(),
		sockets = new Set();
	let connections = 0;
	const receive = (body, transport, socket) => {
		const request = { body, transport };
		requests.push(request);
		onRequest?.(request, requests.length);
		const failure = fail?.(request, requests.length);
		if (failure === "close") {
			socket?.close(1006, "fixture transport failure");
			return;
		}
		if (failure === "after-start" && socket) {
			socket.dispatchEvent(
				new MessageEvent("message", {
					data: JSON.stringify({ type: "response.created", response: { id: "broken", status: "in_progress" } }),
				}),
			);
			setImmediate(() => socket.close(1006, "fixture transport failure after start"));
			return;
		}
		if (failure) return [{ type: "error", code: failure, message: "fixture failure" }];
		const previous = body.previous_response_id ? cache.get(body.previous_response_id) : [];
		assert.ok(previous, "server received an unknown cached response reference");
		request.input = [...structuredClone(previous), ...structuredClone(body.input)];
		const id = `response_${requests.length}`;
		const output = reply?.(request, requests.length) ?? [codexMessage(`msg_${requests.length}`)];
		cache.set(id, [...request.input, ...structuredClone(output)]);
		return [
			...output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
			{ type: "response.completed", response: { id, status: "completed", output } },
		];
	};
	class Socket extends EventTarget {
		readyState = 0;
		constructor() {
			super();
			connections++;
			sockets.add(this);
			queueMicrotask(() => {
				this.readyState = 1;
				this.dispatchEvent(new Event("open"));
			});
		}
		send(value) {
			setImmediate(() => {
				const body = JSON.parse(value);
				assert.equal(body.type, "response.create");
				for (const event of receive(body, "websocket", this) ?? [])
					this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
			});
		}
		close(code = 1000, reason = "done") {
			if (this.readyState === 3) return;
			this.readyState = 3;
			sockets.delete(this);
			this.dispatchEvent(Object.assign(new Event("close"), { code, reason, wasClean: code === 1000 }));
		}
	}
	t.mock.method(globalThis, "WebSocket", function MockWebSocket() {
		return new Socket();
	});
	t.after(() => {
		closeOpenAICodexWebSocketSessions(sessionId);
		resetOpenAICodexWebSocketDebugStats(sessionId);
		for (const socket of sockets) socket.close();
	});
	const fetch = async (_url, init) => {
		const headers = new Headers(init.headers);
		const bytes = headers.get("content-encoding") === "zstd" ? zstdDecompressSync(init.body) : init.body;
		const events = receive(JSON.parse(bytes.toString()), "sse");
		requests.at(-1).encoding = headers.get("content-encoding");
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "Content-Type": "text/event-stream" },
		});
	};
	return {
		requests,
		sessionId,
		get connections() {
			return connections;
		},
		stats: () => getOpenAICodexWebSocketDebugStats(sessionId),
		close: () => closeOpenAICodexWebSocketSessions(sessionId),
		stream: (model, context, options) =>
			stream(model, context, {
				...options,
				apiKey: codexKey,
				transport,
				sessionId,
				fetch,
				maxRetries: 0,
				timeoutMs: 1000,
				websocketConnectTimeoutMs: 1000,
			}),
	};
}
