import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";

test(
	"CLI RPC replacement and restore recheck skill resources and historical expansions",
	{ timeout: 30000 },
	async () => {
		const dir = await mkdtemp(join(tmpdir(), "jouzu-textguard-rpc-"));
		let child;
		let closed;
		try {
			const skill = join(dir, "SKILL.md");
			const extension = join(dir, "fixture.mjs");
			const captured = join(dir, "contexts.jsonl");
			await writeFile(skill, "---\nname: rpc-fixture\ndescription: CLEAR_RPC_DESCRIPTION\n---\nCLEAR_RPC_BODY\n");
			await writeFile(
				extension,
				`
import { createAssistantMessageEventStream } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/utils/event-stream"))};
import { appendFileSync } from 'node:fs';
export default function(pi) {
 pi.registerProvider('rpc-fixture',{
  baseUrl:'http://127.0.0.1:1',apiKey:'fixture',api:'openai-completions',
  models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:256}],
  streamSimple(model,context){
   appendFileSync(${JSON.stringify(captured)},JSON.stringify({systemPrompt:context.systemPrompt,messages:context.messages})+'\\n');
   const message={role:'assistant',content:[{type:'text',text:'Done.'}],api:model.api,provider:model.provider,model:model.id,
    usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
   const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:'done',reason:'stop',message});stream.end(message)});return stream;
  }
 });
}
`,
			);
			const env = Object.fromEntries(
				Object.entries(process.env).filter(
					([key]) => !/^(JOUZU_|PI_|SHISA_|AI_AGENT|TEXTGUARD_|OPENAI_|ANTHROPIC_)/u.test(key),
				),
			);
			env.PI_OFFLINE = "1";
			child = spawn(
				process.execPath,
				[
					fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
					"--jouzu-home",
					join(dir, "home"),
					"--no-extensions",
					"--no-skills",
					"--no-context-files",
					"--no-prompt-templates",
					"--extension",
					extension,
					"--skill",
					skill,
					"--provider",
					"rpc-fixture",
					"--model",
					"fixture",
					"--mode",
					"rpc",
				],
				{ cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] },
			);
			closed = once(child, "close");
			const events = new EventEmitter();
			let buffer = "",
				stderr = "";
			const seen = [];
			child.stderr.setEncoding("utf8").on("data", (chunk) => {
				stderr += chunk;
			});
			child.stdout.setEncoding("utf8").on("data", (chunk) => {
				buffer += chunk;
				while (buffer.includes("\n")) {
					const newline = buffer.indexOf("\n");
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (!line.trim()) continue;
					const value = JSON.parse(line);
					seen.push(value);
					events.emit("event", value);
				}
			});
			let sequence = 0;
			const wait = (match) =>
				new Promise((resolve, reject) => {
					const timer = setTimeout(() => {
						cleanup();
						reject(new Error(`RPC timeout: ${stderr}`));
					}, 10000);
					const receive = (event) => {
						if (match(event)) {
							cleanup();
							resolve(event);
						}
					};
					const exit = () => {
						cleanup();
						reject(new Error(`RPC exited: ${stderr}`));
					};
					function cleanup() {
						clearTimeout(timer);
						events.off("event", receive);
						child.off("close", exit);
					}
					events.on("event", receive);
					child.on("close", exit);
				});
			const command = async (type, args = {}) => {
				const id = String(++sequence);
				const response = wait((event) => event.type === "response" && event.id === id);
				child.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);
				const result = await response;
				assert.equal(result.success, true, JSON.stringify(result));
				return result.data;
			};
			const prompt = async (message) => {
				const settled = wait((event) => event.type === "agent_settled");
				await Promise.all([command("prompt", { message }), settled]);
			};
			const contexts = async () => (await readFile(captured, "utf8")).trim().split("\n").map(JSON.parse);
			const first = await command("get_state");
			await prompt("/skill:rpc-fixture");
			assert.match(JSON.stringify((await contexts())[0]), /CLEAR_RPC_BODY/);
			await writeFile(
				skill,
				"---\nname: rpc-fixture\ndescription: CHANGED_RPC_DESCRIPTION\u202e\n---\nCHANGED_RPC_BODY\u202e\n",
			);
			assert.equal((await command("new_session")).cancelled, false);
			const second = await command("get_state");
			assert.notEqual(second.sessionId, first.sessionId);
			assert.ok(!(await command("get_commands")).commands.some((item) => item.name === "skill:rpc-fixture"));
			await prompt("Check changed resources");
			assert.doesNotMatch(
				JSON.stringify((await contexts())[1]),
				/CHANGED_RPC_DESCRIPTION|CHANGED_RPC_BODY|CLEAR_RPC_BODY/,
			);
			const saved = SessionManager.open(first.sessionFile);
			saved.appendMessage({
				role: "user",
				content: '<skill name="restored">RESTORED_RPC_SECRET\u202e</skill>',
				timestamp: Date.now(),
			});
			assert.match(await readFile(first.sessionFile, "utf8"), /RESTORED_RPC_SECRET/);
			assert.equal((await command("switch_session", { sessionPath: first.sessionFile })).cancelled, false);
			assert.equal((await command("get_state")).sessionId, first.sessionId);
			await prompt("Continue restored session");
			const restored = (await contexts())[2];
			assert.doesNotMatch(JSON.stringify(restored), /RESTORED_RPC_SECRET|CHANGED_RPC_DESCRIPTION|CHANGED_RPC_BODY/);
			assert.match(JSON.stringify(restored), /TextGuard withheld/);
			assert.equal(seen.filter((event) => event.type === "extension_error").length, 0);
		} finally {
			child?.kill("SIGKILL");
			if (closed) await closed;
			await rm(dir, { recursive: true, force: true });
		}
	},
);
