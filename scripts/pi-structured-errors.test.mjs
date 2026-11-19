import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";

const cases = [
	[401, "invalid_api_key", false],
	[402, "insufficient_balance", false],
	[403, "model_not_in_plan", false],
	[429, "free_allowance_exhausted", false],
	[429, "rate_limit_exceeded", true],
	[429, "request_ingress_limited", true],
	[429, "backend_at_capacity", true],
	[503, "auth_verification_busy", true],
];
const inner = (code, message = "Try the account action at https://platform.shisa.ai.") => ({
	code,
	type: code,
	message,
});

for (const tree of ["../node_modules/", "../packages/cli/node_modules/"]) {
	const base = new URL(`${tree}@earendil-works/pi-ai/dist/utils/`, import.meta.url);
	const { normalizeProviderError, formatProviderError } = await import(new URL("error-body.js", base));
	const { isRetryableAssistantError, retryAssistantCall } = await import(new URL("retry.js", base));
	const { retryProviderRequest } = await import(new URL("provider-retry.js", base));
	const { isContextOverflow } = await import(new URL("overflow.js", base));
	const require = createRequire(new URL("../package.json", base));
	const { APIError } = require("openai");
	const sdk = (status, error, headers = new Headers()) => APIError.generate(status, { error }, undefined, headers);
	const display = (error, prefix) => formatProviderError(normalizeProviderError(error), prefix);
	const retry = (errorMessage, stopReason = "error") => isRetryableAssistantError({ stopReason, errorMessage });

	test(`${tree} SDK entry points resolve the patched unbundled modules`, async () => {
		const agentBase = new URL(`${tree}@earendil-works/pi-coding-agent/`, import.meta.url);
		const pkg = JSON.parse(await readFile(new URL("package.json", agentBase), "utf8"));
		assert.equal(pkg.exports["."].import, "./dist/index.js");
		const index = await readFile(new URL("dist/index.js", agentBase), "utf8");
		assert.match(index, /export \{ main \} from "\.\/main.js"/);
		const main = await readFile(new URL("dist/main.js", agentBase), "utf8");
		assert.match(main, /await runRpcMode\(runtime\)/);
		assert.doesNotMatch(main, /bundle\/|rpc-entry/);
		const compat = await import(new URL("../compat.js", base));
		const root = await import(new URL("../index.js", base));
		assert.equal(compat.isRetryableAssistantError, isRetryableAssistantError);
		assert.equal(root.retryAssistantCall, retryAssistantCall);
	});

	test(`${tree} structured HTTP errors retain one code and classify agent retries`, async () => {
		for (const [status, code, transient] of cases) {
			const value = inner(code);
			for (const prefix of [undefined, "Gateway API error"]) {
				const text = display(sdk(status, value), prefix);
				assert.equal(text, `${prefix === undefined ? status : `${prefix} (${status})`}: ${value.message} (${code})`);
				assert.equal(retry(text), transient);
				assert.equal(retry(text, "aborted"), false);
				assert.equal(retry(text, "stop"), false);
			}
			let attempts = 0;
			await retryAssistantCall(
				async () => {
					attempts++;
					return { stopReason: "error", errorMessage: display(sdk(status, value)) };
				},
				{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
			);
			assert.equal(attempts, transient ? 2 : 1);
		}
	});

	test(`${tree} source shapes require exact code, status and type`, () => {
		const value = inner("free_allowance_exhausted");
		const expected = `429: ${value.message} (${value.code})`;
		for (const fields of [
			{ statusCode: 429, body: JSON.stringify({ error: value }) },
			{ $metadata: { httpStatusCode: 429 }, $response: { body: { error: value } } },
			{ $response: { statusCode: 429, body: JSON.stringify({ error: value }) } },
		])
			assert.equal(display(Object.assign(new Error("SDK failure"), fields)), expected);
		for (const rejected of [
			{ ...value, code: 126 },
			{ ...value, code: "FREE_ALLOWANCE_EXHAUSTED" },
			{ ...value, code: "unknown" },
			{ ...value, code: undefined },
			{ ...value, type: "other_provider" },
			{ ...value, type: undefined },
			{ ...value, message: "\r\n\u202e\u200b" },
			{ ...value, message: 1 },
			[],
			"failure",
		]) {
			const norm = normalizeProviderError(sdk(429, rejected));
			const fallback = norm.messageCarriesBody ? norm.message : `429: ${norm.body}`;
			assert.equal(formatProviderError(norm), fallback);
			assert.equal(retry(formatProviderError(norm)), retry(fallback));
		}
		for (const status of [undefined, 400, 503]) {
			const norm = normalizeProviderError(new APIError(status, value, undefined, new Headers()));
			assert.equal(
				formatProviderError(norm),
				norm.messageCarriesBody || status === undefined ? norm.message : `${status}: ${norm.body}`,
			);
		}
		for (const body of [
			JSON.stringify(value),
			'{"error":',
			JSON.stringify({ error: value, padding: "x".repeat(16384) }),
		]) {
			const norm = normalizeProviderError(Object.assign(new Error("SDK failure"), { status: 429, body }));
			assert.equal(formatProviderError(norm), `429: ${norm.body}`);
		}
	});

	test(`${tree} extracted messages are safe, bounded and deduplicated`, () => {
		const code = "free_allowance_exhausted";
		const text = "\ud800\r\n\t\ufeff\u2028\u2029\x1b[31m\u009b\u202e\u061c\u200b\u200e\u200f\u2066safe\u2069 👩‍💻 a‌b";
		assert.equal(display(sdk(429, inner(code, text))), `429: � [31msafe 👩‍💻 a‌b (${code})`);
		assert.equal(display(sdk(429, inner(code, `hello (${code}) (${code})`))), `429: hello (${code})`);
		assert.equal(display(sdk(429, inner(code, `hello (${code}) again`))), `429: hello (${code}) again (${code})`);
		for (const length of [1700, 1750, 1799, 1800, 1801, 4000, 20000]) {
			const result = display(sdk(429, inner(code, "😀".repeat(length))), "Gateway API error");
			assert.ok(result.length <= 1800, result.length);
			assert.ok(result.isWellFormed());
			assert.ok(result.endsWith(` (${code})`));
			assert.match(result, /\[truncated\]/);
		}
	});

	test(`${tree} canonical retry suffixes preserve exclusion precedence`, () => {
		assert.equal(retry("429 overloaded (free_allowance_exhausted)"), false);
		assert.equal(retry("no load words (backend_at_capacity)"), true);
		assert.equal(retry("https://example.invalid/billing (backend_at_capacity)"), false);
		assert.equal(retry("free allowance is low, retry after 429"), true);
		assert.equal(retry("no load words (backend_at_capacity) trailing"), false);
		for (const code of [1308, "1308", "GoUsageLimitError", "FreeUsageLimitError", "insufficient_quota"]) {
			assert.equal(retry(display(sdk(429, { code, type: code, message: `429 ${code}` }))), false);
		}
	});

	test(`${tree} existing retry and overflow families retain their behavior`, () => {
		const transient = [
			"overloaded",
			"server_busy",
			"servers are currently busy",
			"currently experiencing high demand",
			"model is at capacity",
			"rate limit",
			"too many requests",
			"429",
			"500",
			"502",
			"503",
			"504",
			"520",
			"524",
			"service is temporarily unavailable",
			"server error",
			"internal error",
			"provider returned an error",
			"exceeded request buffer limit while retrying upstream",
			"unable to forward upstream",
			"upstream request failed",
			"upstream_stream_read_error",
			"stream was interrupted",
			"http/2 stream failed",
			"network error",
			"connection error",
			"connection refused",
			"connection lost",
			"other side closed",
			"fetch failed",
			"request to https://fixture.invalid failed, reason:",
			"getaddrinfo",
			"ENOTFOUND",
			"EAI_AGAIN",
			"upstream connect",
			"reset before headers",
			"socket hang up",
			"socket connection was closed",
			"timed out",
			"timeout",
			"terminated",
			"websocket closed",
			"websocket error",
			"ended without",
			"stream ended before message_stop",
			"stream ended before a terminal response event",
			"http2 request did not get a response",
			"stream disconnected before completion",
			"cut short after the reply had begun",
			"pending stream has been canceled",
			"retry delay",
			"you can retry your request",
			"try your request again",
			"please retry your request",
			"ResourceExhausted",
			"subscription_sharing_usage_unavailable",
			"subscription_sharing_user_unavailable",
		];
		const terminal = [
			"GoUsageLimitError",
			"FreeUsageLimitError",
			"Monthly usage limit reached",
			"available balance",
			"insufficient_quota",
			"out of budget",
			"quota exceeded",
			"billing",
			"subscription_sharing_usage_limit_exceeded",
			"subscription_sharing_workplace_individual_usage_limit_exceeded",
			'{"code":1308}',
			'{"code":"1308"}',
		];
		for (const [messages, expected] of [
			[transient, true],
			[terminal, false],
		])
			for (const message of messages) {
				assert.equal(display(new Error(message)), message);
				assert.equal(retry(display(new Error(message))), expected, message);
				const norm = normalizeProviderError(sdk(400, { message }));
				assert.equal(formatProviderError(norm), `400: ${JSON.stringify({ message })}`);
				// Numeric code patterns are already covered through SDK objects above.
				if (!message.startsWith("{")) assert.equal(retry(formatProviderError(norm)), expected, message);
			}
		const overflow = [
			"prompt is too long",
			"prompt exceeds max length",
			"request_too_large",
			"input is too long for requested model",
			"exceeds the context window",
			"exceeds the model's maximum context length of 100 tokens",
			"context window exceeded",
			"input token count 200 exceeds the maximum",
			"maximum prompt length is 100",
			"reduce the length of the messages",
			"maximum context length is 100 tokens",
			"exceeds the maximum allowed input length of 100 tokens",
			"input (200 tokens) is longer than the model's context length (100 tokens)",
			"exceeds the limit of 100",
			"exceeds the available context size",
			"greater than the context length",
			"context window exceeds limit",
			"exceeded model token limit",
			"too large for model with 100 maximum context length",
			"prompt has 200 tokens, but the configured context size is 100 tokens",
			"model_context_window_exceeded",
			"prompt too long; exceeded max context length",
			"range of input length should be",
			"context_length_exceeded",
			"too many tokens",
			"token limit exceeded",
			"413 status code (no body)",
		];
		for (const message of overflow) {
			const errorMessage = display(new Error(message));
			assert.equal(errorMessage, message);
			assert.equal(isContextOverflow({ stopReason: "error", errorMessage }), true, message);
		}
		const copilot = display(sdk(413, { message: "failed to parse request", code: "" }), "github-copilot API error");
		assert.equal(copilot, 'github-copilot API error (413): {"message":"failed to parse request","code":""}');
		assert.equal(isContextOverflow({ stopReason: "error", errorMessage: copilot }), true);
		for (const message of [
			"Throttling error: too many tokens",
			"Service unavailable: too many tokens",
			"rate limit too many tokens",
			"too many requests too many tokens",
		]) {
			assert.equal(isContextOverflow({ stopReason: "error", errorMessage: display(new Error(message)) }), false);
		}
	});

	test(`${tree} raw input byte limits and formatted output boundaries are exact`, () => {
		const code = "free_allowance_exhausted";
		const value = inner(code);
		for (const size of [16383, 16384, 16385]) {
			const wrapper = JSON.stringify({ error: value, pad: "" });
			const body = JSON.stringify({ error: value, pad: "x".repeat(size - Buffer.byteLength(wrapper)) });
			assert.equal(Buffer.byteLength(body), size);
			const norm = normalizeProviderError(Object.assign(new Error("SDK error"), { status: 429, body }));
			assert.equal(!!norm.structuredError, size <= 16384);
		}
		const body = JSON.stringify({ error: value, pad: "😀".repeat(5000) });
		assert.ok(body.length < 16384);
		assert.equal(
			normalizeProviderError(Object.assign(new Error("SDK error"), { status: 429, body })).structuredError,
			undefined,
		);
		for (const prefix of [undefined, "Gateway API error", "😀".repeat(2000)]) {
			const heading = prefix === undefined ? "429: " : `${prefix} (429): `;
			for (const size of [1799, 1800, 1801]) {
				const message = "x".repeat(Math.max(1, size - heading.length - ` (${code})`.length));
				const result = display(sdk(429, inner(code, message)), prefix);
				assert.ok(result.length <= 1800);
				assert.ok(result.isWellFormed());
				if (heading.length < 1800) assert.equal(result.includes("[truncated]"), size > 1800);
			}
		}
		const norm = normalizeProviderError(sdk(429, value));
		assert.equal(formatProviderError({ ...norm, messageCarriesBody: true }), `429: ${value.message} (${code})`);
	});

	test(`${tree} HTTP adapters and SSE errors exercise the installed SDK`, async (t) => {
		const value = inner("free_allowance_exhausted");
		const model = {
			id: "fixture",
			name: "fixture",
			provider: "fixture",
			reasoning: false,
			input: ["text"],
			contextWindow: 4096,
			maxTokens: 32,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
			await t.test(api, async (t) => {
				const server = createServer((_req, res) => {
					res.writeHead(429, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: value }));
				});
				await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
				t.after(() => new Promise((resolve) => server.close(resolve)));
				const { stream } = await import(new URL(`../api/${api}.js`, base));
				const result = await stream(
					{ ...model, api, baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
					{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
					{ apiKey: "fixture", maxTokens: 32 },
				).result();
				assert.equal(result.stopReason, "error");
				if (api === "anthropic-messages") {
					assert.match(result.errorMessage, /"type":/);
					assert.equal(retry(result.errorMessage), true);
				} else {
					assert.ok(result.errorMessage.endsWith(`${value.message} (${value.code})`), result.errorMessage);
					assert.doesNotMatch(result.errorMessage, /"type":/);
					assert.equal(retry(result.errorMessage), false);
				}
			});
		}
		const { stream } = await import(new URL("../api/openai-completions.js", base));
		for (const event of ["event: error\n", ""])
			for (const body of [value, { error: value }]) {
				const result = await stream(
					{ ...model, api: "openai-completions", baseUrl: "https://fixture.invalid/v1" },
					{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
					{
						apiKey: "fixture",
						maxTokens: 32,
						fetch: async () =>
							new Response(`${event}data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`, {
								headers: { "content-type": "text/event-stream" },
							}),
					},
				).result();
				if (event || body.error) {
					assert.equal(result.stopReason, "error");
					assert.equal(result.errorMessage, value.message);
				} else assert.equal(result.errorMessage, "Stream ended without finish_reason");
			}
		const result = await stream(
			{ ...model, api: "openai-completions", baseUrl: "https://fixture.invalid/v1" },
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{
				apiKey: "fixture",
				maxTokens: 32,
				fetch: async () =>
					new Response(JSON.stringify({ error: { ...value, metadata: { raw: `\u001b[31m${"x".repeat(3000)}` } } }), {
						status: 429,
						headers: { "content-type": "application/json" },
					}),
			},
		).result();
		assert.equal(result.errorMessage, `429: ${value.message} (${value.code})`);
	});

	test(`${tree} the interactive bug hint remains conditional for account errors`, async () => {
		const { InteractiveMode } = await import(
			new URL(`${tree}@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`, import.meta.url)
		);
		for (const [status, code, transient] of cases) {
			let hints = 0;
			const host = {
				maybeShowInstallChangeWarning: () => false,
				suggestBugReport: () => {
					hints++;
				},
			};
			InteractiveMode.prototype.maybeSuggestBugReport.call(host, {
				stopReason: "error",
				errorMessage: display(sdk(status, inner(code))),
			});
			assert.equal(hints, transient ? 0 : 1);
		}
	});

	test(`${tree} compaction uses the same classifier without changing its budget`, async () => {
		const { completeSummarization } = await import(
			new URL(`${tree}@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js`, import.meta.url)
		);
		for (const [status, code, transient] of cases) {
			let calls = 0;
			const result = await completeSummarization(
				{},
				{},
				{ apiKey: "fixture", sessionId: "fixture-session" },
				async (_model, _context, options) => {
					assert.equal(options.sessionId, "fixture-session");
					assert.equal(options.cacheRetention, "none");
					calls++;
					return { result: async () => ({ stopReason: "error", errorMessage: display(sdk(status, inner(code))) }) };
				},
				{ enabled: true, maxRetries: 2, baseDelayMs: 0 },
			);
			assert.equal(calls, transient ? 3 : 1);
			assert.ok(result.errorMessage.endsWith(` (${code})`));
		}
	});

	test(`${tree} funding transport retries remain controlled by options and headers`, async () => {
		for (const maxRetries of [0, 1])
			for (const header of [undefined, "true", "false"]) {
				const headers = new Headers({ "retry-after-ms": "0" });
				if (header !== undefined) headers.set("x-should-retry", header);
				const error = sdk(429, inner("free_allowance_exhausted"), headers);
				let attempts = 0;
				await assert.rejects(
					retryProviderRequest(
						async () => {
							attempts++;
							throw error;
						},
						{ maxRetries },
					),
					(caught) => caught === error,
				);
				assert.equal(attempts, maxRetries === 1 && header !== "false" ? 2 : 1);
			}
	});
}
