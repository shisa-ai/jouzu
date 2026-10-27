import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { client, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

async function within(promise, milliseconds = 20_000) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("ACP integration deadline exceeded")), milliseconds);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("ACP CLI drives real Jouzu RPC tools and reloads persisted sessions", { timeout: 60_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-acp-cli-"));
	const home = join(root, "home");
	const cwd = join(root, "workspace");
	await mkdir(join(home, "agent"), { recursive: true });
	await mkdir(cwd);
	await writeFile(join(cwd, "evidence.txt"), "ACP_REAL_RPC_EVIDENCE");
	const requests = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		requests.push(JSON.parse(Buffer.concat(chunks).toString()));
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const first = requests.length === 1;
		const delta = first
			? {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "acp-read",
							type: "function",
							function: { name: "read", arguments: JSON.stringify({ path: join(cwd, "evidence.txt") }) },
						},
					],
				}
			: { role: "assistant", content: "ACP answer: 日本語\u2028jouzu --session preserved." };
		res.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
		res.write(
			`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	await writeFile(
		join(home, "agent", "models.json"),
		JSON.stringify({
			providers: {
				"acp-fixture": {
					baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
					api: "openai-completions",
					apiKey: "fixture-only",
					models: [
						{
							id: "fixture",
							name: "ACP fixture",
							reasoning: false,
							input: ["text"],
							contextWindow: 32000,
							maxTokens: 512,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	await writeFile(
		join(home, "agent", "settings.json"),
		JSON.stringify({ defaultProvider: "acp-fixture", defaultModel: "fixture", defaultThinkingLevel: "off" }),
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) => !/^(JOUZU_|PI_|SHISA_|AI_AGENT|TEXTGUARD_|OPENAI_|ANTHROPIC_)/u.test(key),
		),
	);
	env.PI_OFFLINE = "1";
	const processes = [];
	async function connect() {
		// A relative override must stay anchored to the adapter launch directory,
		// not the workspace supplied by session/new.
		const child = spawn(process.execPath, [cli, "--jouzu-home", "home", "acp"], {
			cwd: root,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const closed = once(child, "close");
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk) => {
			stderr += chunk;
		});
		const updates = [];
		const app = client().onNotification("session/update", ({ params }) => {
			updates.push(params);
		});
		const connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
		const request = (method, params) =>
			within(connection.agent.request(method, params)).catch((error) => {
				throw new Error(`${method}: ${error.message}\n${stderr}`, { cause: error });
			});
		const entry = { child, closed, connection, updates, request };
		processes.push(entry);
		const initialized = await request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
		assert.equal(initialized.agentInfo.name.toLowerCase(), "jouzu");
		assert.equal(initialized.agentCapabilities.loadSession, true);
		return entry;
	}
	async function disconnect(entry) {
		entry.child.stdin.end();
		const [code, signal] = await within(entry.closed, 10_000);
		assert.equal(signal, null);
		assert.equal(code, 0);
	}
	try {
		const first = await connect();
		const session = await first.request("session/new", { cwd, mcpServers: [] });
		assert.ok(session.sessionId);
		const result = await first.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "Read evidence.txt, then report." }],
		});
		assert.equal(result.stopReason, "end_turn");
		assert.equal(requests.length, 2);
		assert.match(JSON.stringify(requests[1].messages), /ACP_REAL_RPC_EVIDENCE/u);
		assert.ok(first.updates.some(({ update }) => update.sessionUpdate === "tool_call"));
		assert.ok(
			first.updates.some(({ update }) => update.sessionUpdate === "tool_call_update" && update.status === "completed"),
		);
		const text = first.updates
			.filter(({ update }) => update.sessionUpdate === "agent_message_chunk")
			.map(({ update }) => update.content.text)
			.join("");
		assert.equal(text, "ACP answer: 日本語\u2028jouzu --session preserved.");
		await disconnect(first);
		const second = await connect();
		await second.request("session/load", { sessionId: session.sessionId, cwd, mcpServers: [] });
		assert.match(JSON.stringify(second.updates), /ACP answer/u);
		assert.equal(
			(
				await second.request("session/prompt", {
					sessionId: session.sessionId,
					prompt: [{ type: "text", text: "Continue." }],
				})
			).stopReason,
			"end_turn",
		);
		assert.match(JSON.stringify(requests.at(-1).messages), /ACP_REAL_RPC_EVIDENCE/u);
		await disconnect(second);
	} finally {
		for (const entry of processes) {
			entry.connection.close();
			if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill("SIGKILL");
			await entry.closed;
		}
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await rm(root, { recursive: true, force: true });
	}
});
