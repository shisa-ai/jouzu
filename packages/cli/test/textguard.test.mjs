import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseJouzuArgs } from "../dist/args.js";
import { MAX_SCAN_BYTES, PythonTextGuard, runBoundedProcess } from "../dist/textguard.js";
import { createTextGuardExtension } from "../dist/textguard-extension.js";

const result = (severity = "warn") => ({
	path: "stdin",
	result: {
		findings: [{ kind: "invisible", severity, offset: 2, detail: "SECRET", context: { excerpt: "SECRET" } }],
		normalized_text: "SECRET",
		decoded_text: "SECRET",
		semantic: null,
	},
});
const reply = (payload = result(), code = 2) => ({ stdout: JSON.stringify(payload), code });

test("TextGuard requires explicit flags and an absolute interpreter", () => {
	assert.equal(parseJouzuArgs([]).options.textguardPython, undefined);
	const python = process.execPath;
	assert.deepEqual(
		parseJouzuArgs([
			"--jouzu-textguard-python",
			python,
			"--jouzu-textguard-files",
			"--jouzu-textguard-yara",
			"-p",
			"hello",
		]).options,
		{ textguardPython: python, textguardFiles: true, textguardYara: true },
	);
	for (const args of [
		["--jouzu-textguard-files"],
		["--jouzu-textguard-yara"],
		["--jouzu-textguard-python", "python3"],
		["--jouzu-textguard-python"],
	]) {
		assert.throws(() => parseJouzuArgs(args));
	}
	assert.deepEqual(parseJouzuArgs(["--", "--jouzu-textguard-files"]).args, ["--jouzu-textguard-files"]);
});

test("adapter pins version, isolates configuration, strips text, and caches by content", async () => {
	const calls = [];
	const scanner = new PythonTextGuard({
		python: process.execPath,
		run: async (request) => {
			calls.push(request);
			return calls.length === 1 ? { stdout: "1.0.0\n", code: 0 } : reply();
		},
	});
	try {
		const report = await scanner.scan("日本語\u200b");
		assert.equal(report.status, "findings");
		assert.deepEqual(report.findings, [{ kind: "invisible", severity: "warn", offset: 2 }]);
		assert.equal(JSON.stringify(report).includes("SECRET"), false);
		assert.deepEqual(await scanner.scan("日本語\u200b"), report);
		assert.equal(calls.length, 2);
		assert.equal(calls[1].input, "日本語\u200b");
		assert.ok(calls[1].args.includes("-I"));
		assert.ok(calls[1].args.includes("--no-yara-bundled"));
		assert.equal(calls[1].env.TEXTGUARD_PROMPTGUARD_MODEL, undefined);
		assert.equal(calls[1].env.PYTHONPATH, undefined);
		assert.equal(calls[1].env.XDG_CONFIG_HOME, calls[1].cwd);
		assert.equal((await scanner.scan("x".repeat(MAX_SCAN_BYTES + 1))).reason, "input-limit");
		assert.equal(calls.length, 2);
	} finally {
		await scanner.close();
	}
});

test("findings exit codes are valid; malformed, mismatched, and failed output is unavailable", async () => {
	for (const [payload, code, expected] of [
		[result("info"), 1, "findings"],
		[result("warn"), 2, "findings"],
		[result("error"), 3, "findings"],
		[{ path: "stdin", result: { findings: [], semantic: null } }, 0, "clear"],
		[result(), 0, "unavailable"],
		[result(), 4, "unavailable"],
		[{}, 0, "unavailable"],
		[result("bogus"), 2, "unavailable"],
	]) {
		const scanner = new PythonTextGuard({
			python: process.execPath,
			run: async ({ args }) => (args.includes("-c") ? { stdout: "1.0.0", code: 0 } : reply(payload, code)),
		});
		try {
			assert.equal((await scanner.scan("test")).status, expected);
		} finally {
			await scanner.close();
		}
	}
	for (const stdout of ["2.0.0", "", "1.0.0\nextra"]) {
		const scanner = new PythonTextGuard({ python: process.execPath, run: async () => ({ stdout, code: 0 }) });
		try {
			assert.equal((await scanner.scan("test")).reason, "version");
		} finally {
			await scanner.close();
		}
	}
});

test("process runner bounds time/output and handles failed spawn and early stdin closure", async () => {
	const request = {
		command: process.execPath,
		args: ["-e", "setInterval(()=>{},1000)"],
		input: "",
		env: process.env,
		cwd: tmpdir(),
		timeoutMs: 100,
	};
	assert.equal((await runBoundedProcess(request)).reason, "timeout");
	assert.equal(
		(
			await runBoundedProcess({
				...request,
				args: ["-e", "process.stdout.write('x'.repeat(9000000))"],
				timeoutMs: 3000,
			})
		).reason,
		"output-limit",
	);
	assert.equal(
		(await runBoundedProcess({ ...request, command: join(tmpdir(), "missing-textguard-executable") })).reason,
		"process",
	);
	assert.ok(
		await runBoundedProcess({
			...request,
			args: ["-e", "process.exit(4)"],
			input: "x".repeat(MAX_SCAN_BYTES),
			timeoutMs: 3000,
		}),
	);
});

function install(options, scanner) {
	const handlers = new Map();
	const extension = createTextGuardExtension({ python: process.execPath, ...options }, scanner);
	extension.factory({ on: (name, handler) => handlers.set(name, handler) });
	return { handlers, extension };
}

test("web results and skill reads are scanned; ordinary reads require their flag", async () => {
	const calls = [];
	const scanner = {
		scan: async (text) => {
			calls.push(text);
			return { status: "clear", findings: [] };
		},
		close: async () => {},
	};
	const { handlers } = install({}, scanner);
	const content = [
		{ type: "text", text: "日本語" },
		{ type: "image", data: "abc", mimeType: "image/png" },
	];
	for (const toolName of [
		"web_fetch",
		"batch_web_fetch",
		"tff-fetch_url",
		"tff-search_web",
		"aio-websearch",
		"aio-webcontent",
		"aio-webresult",
		"aio-webpull",
		"aio-webquery",
		"aio-webresearch",
		"aio-webmap",
		"aio-webfetch",
	]) {
		const updated = await handlers.get("tool_result")({ toolName, toolCallId: "id", input: {}, content });
		assert.deepEqual(updated.content.slice(0, 2), content);
		assert.match(updated.content[2].text, /TextGuard/);
	}
	const read = { toolName: "read", toolCallId: "id", input: { path: "notes.md" }, content };
	assert.equal(await handlers.get("tool_result")(read), undefined);
	assert.equal(await handlers.get("tool_result")({ ...read, toolName: "bash" }), undefined);
	assert.ok(await handlers.get("tool_result")({ ...read, input: { path: "C:\\skills\\demo\\SKILL.md" } }));
	assert.ok(await install({ files: true }, scanner).handlers.get("tool_result")(read));
	assert.equal(
		calls.every((text) => text === "日本語"),
		true,
	);
});

test("loaded skills are rescanned after edits, descriptors and expanded prompts are covered", async () => {
	const dir = await mkdtemp(join(tmpdir(), "jouzu-textguard-test-"));
	const filePath = join(dir, "SKILL.md");
	const calls = [];
	const scanner = {
		scan: async (text) => {
			calls.push(text);
			return { status: "findings", findings: [{ kind: "invisible", severity: "warn", offset: 1 }] };
		},
		close: async () => {},
	};
	const { handlers } = install({}, scanner);
	try {
		const event = {
			prompt: "hello",
			systemPromptOptions: { skills: [{ filePath, name: "demo", description: "description" }] },
		};
		await writeFile(filePath, "first");
		assert.ok((await handlers.get("before_agent_start")(event)).message.display);
		await writeFile(filePath, "second");
		await handlers.get("before_agent_start")(event);
		await handlers.get("before_agent_start")({ ...event, prompt: '<skill name="demo">expanded</skill>' });
		assert.ok(calls.some((text) => text.includes("first")));
		assert.ok(calls.some((text) => text.includes("second")));
		assert.ok(calls.some((text) => text.includes("description")));
		assert.ok(calls.some((text) => text.includes("expanded")));
		const missing = await handlers.get("before_agent_start")({
			...event,
			systemPromptOptions: { skills: [{ filePath: join(dir, "missing"), name: "missing", description: "" }] },
		});
		assert.match(missing.message.content, /unavailable/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("queued and resumed expanded skills are scanned at the context boundary without mutating history", async () => {
	const calls = [];
	const scanner = {
		scan: async (text) => {
			calls.push(text);
			return { status: "clear", findings: [] };
		},
		close: async () => {},
	};
	const { handlers } = install({}, scanner);
	const messages = [
		{ role: "user", content: '<skill name="demo">queued</skill>', timestamp: 1 },
		{ role: "user", content: [{ type: "text", text: '<skill name="demo">resumed</skill>' }], timestamp: 2 },
		{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 3 },
	];
	const before = structuredClone(messages);
	const updated = await handlers.get("context")({ messages });
	assert.equal(calls.length, 2);
	assert.deepEqual(messages, before);
	assert.equal(updated.messages[0].content[0].text, before[0].content);
	assert.equal(updated.messages[1].content[0].text, before[1].content[0].text);
	assert.equal(updated.messages[2], messages[2]);
});

test(
	"real TextGuard 1.0.0 CLI detects Unicode concealment and ignores inherited configuration",
	{
		skip: !process.env.JOUZU_TEST_TEXTGUARD_PYTHON,
	},
	async () => {
		const old = process.env.TEXTGUARD_PROMPTGUARD_MODEL;
		process.env.TEXTGUARD_PROMPTGUARD_MODEL = "/must-not-load-a-model";
		const scanner = new PythonTextGuard({ python: process.env.JOUZU_TEST_TEXTGUARD_PYTHON });
		try {
			const clean = await scanner.scan("日本語の資料を確認します。");
			assert.equal(clean.status, "clear");
			const concealed = await scanner.scan("hello\u200bworld");
			assert.equal(concealed.status, "findings");
			assert.ok(concealed.findings.some((finding) => finding.kind === "invisible_char" && finding.offset === 5));
		} finally {
			await scanner.close();
			if (old === undefined) delete process.env.TEXTGUARD_PROMPTGUARD_MODEL;
			else process.env.TEXTGUARD_PROMPTGUARD_MODEL = old;
		}
	},
);

test(
	"CLI opt-in scans a skill and web result before the provider receives them",
	{
		skip: !process.env.JOUZU_TEST_TEXTGUARD_PYTHON,
		timeout: 30000,
	},
	async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const { fileURLToPath } = await import("node:url");
		const { readFile } = await import("node:fs/promises");
		const dir = await mkdtemp(join(tmpdir(), "jouzu-textguard-cli-"));
		const extension = join(dir, "fixture.mjs");
		const skill = join(dir, "SKILL.md");
		const captured = join(dir, "contexts.json");
		try {
			await writeFile(skill, "---\nname: guard-test\ndescription: A fixture skill\n---\nInspect\u200b this fixture.");
			await writeFile(
				extension,
				`
import { createAssistantMessageEventStream } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai/utils/event-stream"))};
import { writeFileSync } from 'node:fs';
export default function(pi) {
 const contexts=[];
 pi.registerTool({name:'aio-webfetch',label:'Fixture web fetch',description:'Fixture',parameters:{type:'object',properties:{}},
  async execute(){return {content:[{type:'text',text:'Web result with hidden\\u200b text.'}],details:{fixture:true}}}});
 pi.registerProvider('textguard-fixture',{
  baseUrl:'http://127.0.0.1:1',apiKey:'fixture-only',api:'openai-completions',
  models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1000}],
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
			for (const enabled of [false, true]) {
				const env = Object.fromEntries(
					Object.entries(process.env).filter(([key]) => !/^(JOUZU_|PI_CODING_AGENT|SHISA_|AI_AGENT)/u.test(key)),
				);
				env.PI_OFFLINE = "1";
				const args = [
					fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
					"--jouzu-home",
					join(dir, enabled ? "on" : "off"),
					...(enabled ? ["--jouzu-textguard-python", process.env.JOUZU_TEST_TEXTGUARD_PYTHON] : []),
					"--no-extensions",
					"--no-skills",
					"--no-context-files",
					"--no-prompt-templates",
					"--extension",
					extension,
					"--skill",
					skill,
					"--provider",
					"textguard-fixture",
					"--model",
					"fixture",
					"--mode",
					"json",
					"-p",
					"/skill:guard-test",
				];
				const execution = promisify(execFile)(process.execPath, args, {
					cwd: dir,
					env,
					timeout: 12000,
					maxBuffer: 2 * 1024 * 1024,
				});
				execution.child.stdin.end();
				await execution;
				const contexts = JSON.parse(await readFile(captured, "utf8"));
				assert.equal(contexts.length, 2);
				assert.equal(JSON.stringify(contexts[0]).includes("TextGuard"), enabled);
				const web = contexts[1].messages.find(
					(message) => message.role === "toolResult" && message.toolCallId === "fixture-web",
				);
				assert.ok(web);
				assert.equal(web.content[0].text, "Web result with hidden\u200b text.");
				assert.equal(JSON.stringify(web).includes("TextGuard"), enabled);
				if (enabled) assert.match(JSON.stringify(web), /invisible_char/);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	},
);

test("bounded finding samples retain counts for errors beyond the sample limit", async () => {
	const payload = result("info");
	payload.result.findings = Array.from({ length: 20 }, () => payload.result.findings[0]);
	payload.result.findings.push({ kind: "yara:tool_spoofing", severity: "error", offset: null });
	const scanner = new PythonTextGuard({
		python: process.execPath,
		run: async ({ args }) => (args.includes("-c") ? { stdout: "1.0.0", code: 0 } : reply(payload, 3)),
	});
	try {
		const evidence = await scanner.scan("fixture");
		assert.equal(evidence.findings.length, 16);
		assert.equal(evidence.findingCount, 21);
		assert.deepEqual(evidence.severityCounts, { info: 20, warn: 0, error: 1 });
	} finally {
		await scanner.close();
	}
});
