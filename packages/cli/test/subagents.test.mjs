import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SubagentManager, workerEnvironment } from "../dist/subagents/manager.js";
import { AgentRoleStore, defaultAgentConfig, parseAgentConfig, resolveAgentModel } from "../dist/subagents/roles.js";
import { childResourceLoader, requireWorkspacePath } from "../dist/subagents/worker.js";

function paths() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-agents-test-"));
	return { configDir: join(root, "config"), stateDir: join(root, "state"), cwd: root };
}
const model = { id: "test", provider: "test", api: "openai-completions" };
function fixture(maxConcurrent = 2) {
	const p = paths();
	const children = [];
	const manager = new SubagentManager(p, "parent", maxConcurrent, (launch, emit, exit) => {
		const child = {
			launch,
			emit,
			exit,
			commands: [],
			send(command) {
				this.commands.push(command);
			},
			async stop() {
				exit(false);
			},
		};
		children.push(child);
		return child;
	});
	return {
		p,
		manager,
		children,
		launch(role = defaultAgentConfig().roles[1]) {
			return manager.launch({ role, model, auth: { apiKey: "secret-never-persist" }, cwd: p.cwd, task: "Do the task" });
		},
	};
}

test("role definitions are arbitrary, revision checked, and judging tools cannot escalate", () => {
	const p = paths();
	const store = new AgentRoleStore(p);
	const first = store.load();
	first.config.roles.push({ ...first.config.roles[2], id: "security-audit" });
	store.save(first.config, first.revision);
	assert.equal(store.load().config.roles.length, 4);
	assert.throws(() => store.save(defaultAgentConfig(), first.revision), /changed/);
	assert.throws(
		() => parseAgentConfig({ ...first.config, roles: [{ ...first.config.roles[2], tools: ["bash"] }] }),
		/reviewing/,
	);
	assert.throws(
		() => parseAgentConfig({ ...first.config, roles: [{ ...first.config.roles[2], id: "../escape" }] }),
		/role IDs/,
	);
	assert.equal(resolveAgentModel("test", [model]).provider, "test");
	assert.throws(() => resolveAgentModel("test", [model, { ...model, provider: "other" }]), /multiple/);
});
test("writer children serialize; result is terminal only after process exit; secrets stay out of records", async () => {
	const f = fixture();
	const first = f.launch();
	const second = f.launch();
	assert.equal(f.children.length, 1);
	assert.equal(f.manager.get(second.id).status, "queued");
	f.children[0].emit({ type: "result", status: "completed", text: "done" });
	assert.equal(f.manager.get(first.id).status, "starting");
	f.children[0].exit(true);
	assert.equal(f.manager.get(first.id).status, "completed");
	assert.equal(f.children.length, 2);
	const stored = JSON.stringify(f.manager.list());
	assert.equal(stored.includes("secret-never-persist"), false);
	assert.match(f.manager.read(first.id).text, /done/);
	await f.manager.dispose();
});
test("read-only children run concurrently, cancellation frees capacity, foreign IDs fail", async () => {
	const f = fixture();
	const role = defaultAgentConfig().roles[2];
	const a = f.launch(role);
	f.launch(role);
	const c = f.launch(role);
	assert.equal(f.children.length, 2);
	assert.equal(f.manager.get(c.id).status, "queued");
	await f.manager.stop(a.id);
	assert.equal(f.manager.get(a.id).status, "cancelled");
	assert.equal(f.children.length, 3);
	assert.throws(() => f.manager.get("foreign"), /parent session/);
	await f.manager.dispose();
});
test("child configuration excludes ambient resources and reviewer instructions", () => {
	const p = paths();
	writeFileSync(join(p.cwd, "AGENTS.md"), "PROJECT_INJECTION");
	const launch = { role: defaultAgentConfig().roles[2], directory: join(p.cwd, "child"), cwd: p.cwd };
	const loader = childResourceLoader(launch);
	assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
	assert.deepEqual(loader.getExtensions().extensions, []);
	assert.deepEqual(loader.getSkills().skills, []);
	assert.equal(
		childResourceLoader({ ...launch, role: defaultAgentConfig().roles[1] })
			.getAgentsFiles()
			.agentsFiles.some((entry) => entry.content.includes("PROJECT_INJECTION")),
		true,
	);
	assert.deepEqual(workerEnvironment({ PATH: "/bin", OPENAI_API_KEY: "secret", NODE_OPTIONS: "--require bad.js" }), {
		PATH: "/bin",
		PI_SKIP_VERSION_CHECK: "1",
		NO_COLOR: "1",
	});
});
test("file tools refuse traversal and symlink escapes", () => {
	const p = paths();
	const outside = paths();
	mkdirSync(join(p.cwd, "inside"));
	requireWorkspacePath(p.cwd, "inside/new.txt");
	assert.throws(() => requireWorkspacePath(p.cwd, "../bad.txt"), /outside/);
	symlinkSync(outside.cwd, join(p.cwd, "linked"));
	assert.throws(() => requireWorkspacePath(p.cwd, "linked/new.txt"), /outside/);
});
test("failure and timeout never become empty successful results", async () => {
	const f = fixture();
	const run = f.launch();
	f.children[0].exit(false);
	assert.equal(f.manager.get(run.id).status, "failed");
	assert.match(f.manager.get(run.id).result, /before a complete result/);
	await f.manager.dispose();
});

test(
	"real child process completes through the pinned Pi SDK and persists a recoverable session",
	{ timeout: 20000 },
	async () => {
		const { createServer } = await import("node:http");
		const { once } = await import("node:events");
		const requests = [];
		const server = createServer(async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			requests.push(JSON.parse(Buffer.concat(chunks).toString()));
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(
				`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Verified fixture result." }, finish_reason: null }] })}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n`,
			);
			res.end("data: [DONE]\n\n");
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const p = paths();
		let completed;
		const done = new Promise((resolve) => {
			completed = resolve;
		});
		const manager = new SubagentManager(p, "real-parent", 2, undefined, (run) => completed(run));
		try {
			const role = { ...defaultAgentConfig().roles[2], model: "fixture/test", thinking: "off" };
			const selectedModel = {
				...model,
				provider: "fixture",
				name: "Fixture",
				baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32000,
				maxTokens: 512,
			};
			manager.launch({
				role,
				model: selectedModel,
				auth: { apiKey: "fixture-key" },
				cwd: p.cwd,
				task: "Report fixture result.",
			});
			const result = await done;
			assert.equal(result.status, "completed", result.result);
			assert.match(result.result, /Verified fixture/);
			assert.ok(result.sessionFile);
			assert.match(readFileSync(result.sessionFile, "utf8"), /Verified fixture/);
			assert.equal(requests.length, 1);
			assert.ok(requests[0].tools.every((tool) => ["read", "grep", "find", "ls"].includes(tool.function.name)));
			assert.equal(JSON.stringify(manager.list()).includes("fixture-key"), false);
			const resumedDone = new Promise((resolve) => {
				completed = resolve;
			});
			const resumed = manager.launch(
				{
					role,
					model: selectedModel,
					auth: { apiKey: "fixture-key" },
					cwd: p.cwd,
					task: "Continue from your prior answer.",
				},
				undefined,
				result.id,
			);
			const followup = await resumedDone;
			assert.equal(followup.status, "completed", followup.result);
			assert.equal(followup.previousRunId, result.id);
			assert.equal(followup.childSessionId, result.childSessionId);
			assert.notEqual(resumed.id, result.id);
			assert.ok(
				requests[1].messages.some(
					(message) => message.role === "assistant" && JSON.stringify(message.content).includes("Verified fixture"),
				),
			);
		} finally {
			await manager.dispose();
			server.closeAllConnections();
			server.close();
		}
	},
);

test("output pagination preserves Japanese UTF-8 and resume refuses a session outside storage", async () => {
	const f = fixture();
	const run = f.launch();
	f.children[0].emit({ type: "message", role: "assistant", text: "日本語の検証" });
	let offset = 0;
	let text = "";
	do {
		const page = f.manager.read(run.id, offset, 5);
		text += page.text;
		offset = page.nextOffset;
	} while (offset !== null);
	assert.match(text, /日本語の検証/);
	assert.doesNotMatch(text, /\ufffd/);
	f.children[0].emit({ type: "ready", sessionFile: join(f.p.cwd, "outside.jsonl"), sessionId: "child" });
	writeFileSync(join(f.p.cwd, "outside.jsonl"), "{}");
	f.children[0].exit(false);
	assert.throws(
		() => f.manager.launch({ role: run.role, model, auth: {}, cwd: f.p.cwd, task: "Continue" }, undefined, run.id),
		/unavailable/,
	);
	await f.manager.dispose();
});

test("review identity changes for tracked and untracked edits", async () => {
	const { execFileSync } = await import("node:child_process");
	const { captureReviewCandidate } = await import("../dist/subagents/review.js");
	const f = fixture();
	const git = (...args) => execFileSync("git", ["-C", f.p.cwd, ...args], { stdio: "ignore" });
	git("init");
	writeFileSync(join(f.p.cwd, "tracked"), "before");
	git("add", "tracked");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
	const before = captureReviewCandidate(f.p.cwd);
	assert.equal(before.coverage, "git-worktree");
	writeFileSync(join(f.p.cwd, "tracked"), "after");
	assert.notEqual(captureReviewCandidate(f.p.cwd).identity, before.identity);
	const modified = captureReviewCandidate(f.p.cwd);
	writeFileSync(join(f.p.cwd, "new-file"), "new");
	assert.notEqual(captureReviewCandidate(f.p.cwd).identity, modified.identity);
	const run = f.launch(defaultAgentConfig().roles[2]);
	writeFileSync(join(f.p.cwd, "tracked"), "after review starts");
	f.children[0].emit({ type: "result", status: "completed", text: "No findings." });
	f.children[0].exit(true);
	assert.equal(f.manager.get(run.id).review.status, "changed");
	assert.match(f.manager.get(run.id).result, /does not establish/);
	await f.manager.dispose();
});

test("review identity follows directory aliases and rejects subdirectory coverage", async () => {
	const { execFileSync } = await import("node:child_process");
	const { captureReviewCandidate } = await import("../dist/subagents/review.js");
	const root = mkdtempSync(join(tmpdir(), "jouzu-review-alias-"));
	const repo = join(root, "repo");
	const alias = join(root, "alias");
	try {
		mkdirSync(repo);
		const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
		git("init");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--allow-empty",
			"-m",
			"fixture",
		);
		symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
		const before = captureReviewCandidate(repo);
		assert.equal(before.coverage, "git-worktree");
		assert.deepEqual(captureReviewCandidate(alias), before);
		writeFileSync(join(alias, "new-file"), "changed through alias");
		assert.notEqual(captureReviewCandidate(alias).identity, before.identity);
		const nested = join(repo, "nested");
		mkdirSync(nested);
		assert.equal(captureReviewCandidate(nested).coverage, "unavailable");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("real child cancellation aborts a running shell and its process", { timeout: 20000 }, async () => {
	const { createServer } = await import("node:http");
	const { once } = await import("node:events");
	const p = paths();
	const server = createServer(async (req, res) => {
		for await (const _chunk of req) {
		}
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const delta = {
			role: "assistant",
			tool_calls: [
				{
					index: 0,
					id: "call_fixture",
					type: "function",
					function: {
						name: "bash",
						arguments: JSON.stringify({
							command: `node -e 'require("node:fs").writeFileSync("worker-shell.pid", String(process.pid)); setInterval(() => {}, 1000)'`,
						}),
					},
				},
			],
		};
		res.write(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
		res.write(
			`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const manager = new SubagentManager(p, "cancel-parent", 1);
	try {
		const selectedModel = {
			...model,
			provider: "fixture",
			name: "Fixture",
			baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32000,
			maxTokens: 512,
		};
		const run = manager.launch({
			role: { ...defaultAgentConfig().roles[1], thinking: "off" },
			model: selectedModel,
			auth: { apiKey: "fixture-key" },
			cwd: p.cwd,
			task: "Run the assigned command",
		});
		let pid;
		for (let i = 0; i < 150; i++) {
			try {
				pid = Number(readFileSync(join(p.cwd, "worker-shell.pid"), "utf8"));
				break;
			} catch {}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.ok(pid, manager.read(run.id).text);
		await manager.stop(run.id);
		assert.equal(manager.get(run.id).status, "cancelled");
		assert.throws(() => process.kill(pid, 0), /ESRCH/);
	} finally {
		await manager.dispose();
		server.closeAllConnections();
		server.close();
	}
});

test("large Unicode records reload and overlarge definition files fail before writing", async () => {
	const f = fixture();
	const role = { ...defaultAgentConfig().roles[1], instructions: "日".repeat(32000) };
	const run = f.manager.launch({ role, model, auth: {}, cwd: f.p.cwd, task: "語".repeat(32000) });
	role.instructions = "mutated after launch";
	assert.equal(f.children[0].launch.role.instructions, "日".repeat(32000));
	f.children[0].emit({ type: "result", status: "completed", text: "結".repeat(32000) });
	f.children[0].exit(true);
	await f.manager.dispose();
	const reopened = new SubagentManager(f.p, "parent", 2);
	reopened.attach();
	assert.equal(reopened.get(run.id).status, "completed");
	await reopened.dispose();
	const store = new AgentRoleStore(f.p);
	const snapshot = store.load();
	snapshot.config.roles = Array.from({ length: 64 }, (_, index) => ({
		...role,
		id: `role-${index}`,
		instructions: "日".repeat(32000),
	}));
	assert.throws(() => store.save(snapshot.config, snapshot.revision), /2 MB/);
	assert.equal(store.load().config.roles.length, 3);
});

test("a resumed conversation cannot start twice before its worker is ready", async () => {
	const f = fixture();
	const run = f.launch();
	const sessionFile = join(f.children[0].launch.directory, "session.jsonl");
	writeFileSync(sessionFile, "{}");
	f.children[0].emit({ type: "ready", sessionFile, sessionId: "child" });
	f.children[0].emit({ type: "result", status: "completed", text: "Done" });
	f.children[0].exit(true);
	const resume = () =>
		f.manager.launch({ role: run.role, model, auth: {}, cwd: f.p.cwd, task: "Continue" }, undefined, run.id);
	resume();
	assert.throws(resume, /active follow-up/);
	await f.manager.dispose();
});
