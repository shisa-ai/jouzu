import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

for (const variant of ["clear", "major", "image"]) {
	test(
		`CLI default native policy checks skill metadata and complete web payloads: ${variant}`,
		{ timeout: 30000 },
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "jouzu-native-cli-"));
			try {
				const skill = join(dir, "SKILL.md"),
					extension = join(dir, "fixture.mjs"),
					captured = join(dir, "contexts.json"),
					home = join(dir, "home");
				const marker = variant === "major" ? "\u202e" : "";
				await writeFile(
					skill,
					`---\nname: native-fixture\ndescription: UNIQUE_SKILL_DESCRIPTION${marker}\n---\nUNIQUE_SKILL_BODY${marker}\n`,
				);
				const web = {
					content: [{ type: "text", text: `UNIQUE_WEB_BODY${marker}` }],
					details: { nested: { markdown: `UNIQUE_WEB_DETAILS${marker}` } },
				};
				if (variant === "image") web.content.push({ type: "image", mimeType: "image/png", data: "UNIQUE_IMAGE_BYTES" });
				await writeFile(
					extension,
					`
import { createAssistantMessageEventStream } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/utils/event-stream"))};
import { writeFileSync } from 'node:fs';
export default function(pi) {
 const contexts=[];
 pi.registerTool({name:'aio-webfetch',label:'Fixture fetch',description:'Fixture',parameters:{type:'object',properties:{}},
  async execute(){return ${JSON.stringify(web)}}});
 pi.registerProvider('native-fixture',{
  baseUrl:'http://127.0.0.1:1',apiKey:'fixture-only',api:'openai-completions',
  models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text','image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}],
  streamSimple(model,context){
   contexts.push(context);writeFileSync(${JSON.stringify(captured)},JSON.stringify(contexts));
   const tool=contexts.length===1;
   const message={role:'assistant',content:tool?[{type:'toolCall',id:'fixture-web',name:'aio-webfetch',arguments:{}}]:[{type:'text',text:'Done.'}],
    api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:tool?'toolUse':'stop',timestamp:Date.now()};
   const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:'done',reason:message.stopReason,message});stream.end(message)});return stream;
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
				const args = [
					fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
					"--jouzu-home",
					home,
					"--no-extensions",
					"--no-skills",
					"--no-context-files",
					"--no-prompt-templates",
					"--extension",
					extension,
					"--skill",
					skill,
					"--provider",
					"native-fixture",
					"--model",
					"fixture",
					"--mode",
					"json",
					"-p",
					"/skill:native-fixture",
				];
				const execution = promisify(execFile)(process.execPath, args, {
					cwd: dir,
					env,
					timeout: 20000,
					maxBuffer: 2 * 1024 * 1024,
				});
				execution.child.stdin.end();
				const { stderr } = await execution;
				const contexts = JSON.parse(await readFile(captured, "utf8"));
				assert.equal(contexts.length, 2);
				const first = JSON.stringify(contexts[0]);
				assert.equal(first.includes("UNIQUE_SKILL_DESCRIPTION"), variant !== "major");
				assert.equal(first.includes("UNIQUE_SKILL_BODY"), variant !== "major");
				const result = contexts[1].messages.find(
					(item) => item.role === "toolResult" && item.toolCallId === "fixture-web",
				);
				assert.ok(result);
				if (variant === "clear") {
					assert.equal(result.content[0].text, web.content[0].text);
					assert.equal(result.isError, false);
				} else {
					assert.equal(result.isError, true);
					assert.match(result.content[0].text, /withheld/);
					assert.doesNotMatch(JSON.stringify(contexts), /UNIQUE_WEB_BODY|UNIQUE_WEB_DETAILS|UNIQUE_IMAGE_BYTES/);
					assert.match(stderr, /pending reviews/);
					assert.match(stderr, /interactive session/);
				}
				const cache = JSON.parse(await readFile(join(home, "cache", "textguard", "scans.json"), "utf8"));
				assert.ok(cache.records.length > 0);
				assert.doesNotMatch(JSON.stringify(cache), /UNIQUE_SKILL_BODY|UNIQUE_WEB_BODY|example.com|approvals/);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	);
}
