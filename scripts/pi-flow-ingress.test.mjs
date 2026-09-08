import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSessionRuntime, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import { assistant, createFlowSession, deferred, message, tick } from "./fixtures/pi-flow-session.mjs";

function inbox(submit) {
	const entries = [];
	return {
		entries,
		handler: {
			version: 1,
			submit: async (input, dispatch) => {
				entries.push({ input, dispatch });
				await submit?.(input, dispatch);
			},
		},
	};
}

test("SDK attachment completes before returning and cleanup is awaited once", async (t) => {
	const entered = deferred(),
		release = deferred(),
		closing = deferred(),
		closed = deferred();
	let attached,
		returned = false,
		disposed = 0;
	const creating = createFlowSession(t, {
		ingress: {
			version: 1,
			async attach(session) {
				attached = session;
				entered.resolve();
				await release.promise;
			},
			submit() {},
			async dispose() {
				disposed++;
				closing.resolve();
				await closed.promise;
			},
		},
	}).then((result) => {
		returned = true;
		return result;
	});
	await entered.promise;
	assert.equal(returned, false);
	release.resolve();
	const { session } = await creating;
	assert.equal(session, attached);
	let complete = false;
	const disposal = session.dispose().then(() => {
		complete = true;
	});
	await closing.promise;
	assert.equal(complete, false);
	await assert.rejects(session.prompt("after disposal"), /closed/);
	const again = session.dispose();
	closed.resolve();
	await Promise.all([disposal, again]);
	assert.equal(disposed, 1);
});

for (const cleanupFails of [false, true])
	test(`attachment failure closes the partial session, cleanupFails=${cleanupFails}`, async (t) => {
		let session,
			disposed = 0;
		const creating = createFlowSession(t, {
			ingress: {
				version: 1,
				submit() {},
				attach(value) {
					session = value;
					throw new Error("attach failed");
				},
				dispose() {
					disposed++;
					if (cleanupFails) throw new Error("cleanup failed");
				},
			},
		});
		await assert.rejects(creating, (error) =>
			cleanupFails
				? error instanceof AggregateError &&
					error.errors.map((item) => item.message).join(",") === "attach failed,cleanup failed"
				: error.message === "attach failed",
		);
		assert.equal(disposed, 1);
		await assert.rejects(session.prompt("stale"), /closed/);
	});

test("runtime replacement waits for disposal and services forward the new ingress", async (t) => {
	const closing = deferred(),
		release = deferred();
	const first = await createFlowSession(t, {
		ingress: {
			version: 1,
			submit() {},
			async dispose() {
				closing.resolve();
				await release.promise;
			},
		},
	});
	const services = {
		cwd: first.session.sessionManager.getCwd(),
		agentDir: first.session.sessionManager.getCwd(),
		modelRuntime: first.session.modelRuntime,
		resourceLoader: first.session.resourceLoader,
		settingsManager: first.session.settingsManager,
		diagnostics: [],
	};
	let factories = 0,
		attachedId,
		capturedId,
		disposed = 0;
	const runtime = new AgentSessionRuntime(first.session, services, async ({ sessionManager, sessionStartEvent }) => {
		factories++;
		const result = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: first.session.model,
			flowIngress: {
				version: 1,
				attach(session) {
					attachedId = session.sessionId;
				},
				submit(input) {
					capturedId = input.scope.sessionId;
				},
				dispose() {
					disposed++;
				},
			},
		});
		return { ...result, services, diagnostics: [] };
	});
	t.after(() => runtime.dispose());
	const replacing = runtime.newSession();
	await closing.promise;
	assert.equal(factories, 0);
	release.resolve();
	await replacing;
	assert.equal(factories, 1);
	assert.notEqual(attachedId, first.session.sessionId);
	await runtime.session.prompt("retained in replacement");
	assert.equal(capturedId, attachedId);
	await runtime.dispose();
	assert.equal(disposed, 1);
});

for (const mode of ["help", "print"])
	test(`CLI ${mode} awaits attachment and cleanup through the main factory`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "jouzu-flow-main-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const log = join(root, "lifecycle.jsonl");
		const module = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href;
		const args = [
			"--offline",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			...(mode === "help"
				? ["--help"]
				: ["--mode", "json", "--provider", "openai", "--model", "gpt-4o-mini", "--api-key", "fixture", "held input"]),
		];
		const script = `
import { appendFileSync } from 'node:fs';
import { main } from ${JSON.stringify(module)};
const record = (stage) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(stage)+'\\n');
await main(${JSON.stringify(args)}, {
 flowIngressFactory({ sessionManager }) {
  record('factory');
  const id = sessionManager.getSessionId();
  return { version: 1,
   async attach(session) { if(session.sessionId !== id) throw new Error('scope mismatch'); await new Promise(r=>setTimeout(r,5)); record('attach'); },
   submit() { record('submit'); },
   async dispose() { await new Promise(r=>setTimeout(r,15)); record('dispose'); }
  };
 }
});`;
		await new Promise((resolve, reject) => {
			const child = execFile(
				process.execPath,
				["--input-type=module", "-e", script],
				{
					cwd: root,
					env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "state"), PI_OFFLINE: "1" },
					timeout: 30000,
				},
				(error) => (error ? reject(error) : resolve()),
			);
			child.stdin.end();
		});
		assert.deepEqual(
			(await readFile(log, "utf8")).trim().split("\n").map(JSON.parse),
			mode === "help" ? ["factory", "attach", "dispose"] : ["factory", "attach", "submit", "dispose"],
		);
	});

test("every AgentSession send API can be retained without native queue, history, or provider writes", async (t) => {
	const held = inbox();
	const { session, requests } = await createFlowSession(t, { ingress: held.handler });
	const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
	const preflight = [];
	await session.prompt("manual", { images: [image], preflightResult: (accepted) => preflight.push(accepted) });
	await session.steer("steer", [image]);
	await session.followUp("follow-up", [image]);
	await session.sendCustomMessage(
		{ customType: "result", content: "result", display: true, details: { id: "result" } },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	await session.sendCustomMessage(
		{ customType: "context", content: "aside", display: false },
		{ deliverAs: "nextTurn" },
	);
	await session.sendUserMessage([{ type: "text", text: "extension" }, image], { deliverAs: "followUp" });
	assert.equal(held.entries.length, 6);
	assert.equal(new Set(held.entries.map(({ input }) => input.id)).size, 6);
	assert.deepEqual(
		held.entries.map(({ input }) => input.origin.kind),
		["host", "host", "host", "sdk", "sdk", "sdk"],
	);
	assert.equal(held.entries[0].input.args[1].preflightResult, undefined);
	assert.deepEqual(held.entries[0].input.args[1].images, [image]);
	assert.deepEqual(preflight, [true]);
	assert.equal(requests.length, 0);
	assert.deepEqual(session.agent.inspectQueuedMessages(), []);
	assert.equal(
		session.sessionManager.getBranch().filter((entry) => ["message", "custom_message"].includes(entry.type)).length,
		0,
	);
});

test("retained dispatch uses captured bytes once and sendUserMessage forwarding is captured once", async (t) => {
	const held = inbox();
	const { session, requests } = await createFlowSession(t, { ingress: held.handler });
	const content = [{ type: "text", text: "original" }];
	await session.sendUserMessage(content);
	content[0].text = "caller mutation";
	held.entries[0].input.args[0][0].text = "observer mutation";
	const results = await Promise.allSettled([held.entries[0].dispatch(), held.entries[0].dispatch()]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.match(results.find((result) => result.status === "rejected").reason.message, /already dispatched/);
	assert.equal(held.entries.length, 1);
	assert.equal(requests.length, 1);
	assert.equal(requests[0][0].content[0].text, "original");
});

test("held prompt calls its preflight callback once across later dispatch", async (t) => {
	const held = inbox();
	const { session } = await createFlowSession(t, { ingress: held.handler });
	const results = [];
	await session.prompt("held", { preflightResult: (value) => results.push(value) });
	await held.entries[0].dispatch();
	assert.deepEqual(results, [true]);
});

test("handler rejection revokes its dispatch permit and never restores direct sending", async (t) => {
	const held = inbox(() => {
		throw new Error("Controller unavailable");
	});
	const { session, requests } = await createFlowSession(t, { ingress: held.handler });
	const preflight = [];
	await assert.rejects(
		session.prompt("held", { preflightResult: (value) => preflight.push(value) }),
		/Controller unavailable/,
	);
	await assert.rejects(held.entries[0].dispatch(), /rejected/);
	assert.deepEqual(preflight, [false]);
	assert.equal(requests.length, 0);
});

for (const reverse of [false, true]) {
	test(`loader assigns extension origins independently of caller labels and load order (${reverse})`, async (t) => {
		const held = inbox();
		const apis = new Map();
		const factories = ["alpha", "beta"].map((name) => ({ name, factory: (api) => apis.set(name, api) }));
		const { session, requests } = await createFlowSession(t, {
			ingress: held.handler,
			extensions: reverse ? factories.reverse() : factories,
		});
		apis.get("alpha").sendUserMessage("same", { source: "interactive", userCommand: { id: "forged" } });
		apis
			.get("beta")
			.sendMessage(
				{ customType: "same", content: "same", display: false, details: { origin: "host" } },
				{ triggerTurn: true },
			);
		await tick();
		assert.deepEqual(
			held.entries.map(({ input }) => input.origin),
			[
				{ kind: "extension", id: "<inline:alpha>" },
				{ kind: "extension", id: "<inline:beta>" },
			],
		);
		assert.ok(held.entries.every(({ input }) => input.userCommand === undefined));
		assert.ok(held.entries.every(({ input }) => input.scope.sessionId === session.sessionId));
		assert.equal(requests.length, 0);
	});
}

test("native dispatch does not grant bypass to nested agent_end continuation callbacks", async (t) => {
	const held = inbox((input, dispatch) => (input.origin.kind === "host" ? dispatch() : undefined));
	const { session, requests } = await createFlowSession(t, {
		ingress: held.handler,
		extensions: [
			{
				name: "cadence",
				factory: (api) => {
					api.on("agent_end", () => api.sendUserMessage("continue", { deliverAs: "followUp" }));
				},
			},
		],
	});
	await session.prompt("user");
	await tick();
	assert.equal(requests.length, 1);
	assert.equal(held.entries.length, 2);
	assert.equal(held.entries[1].input.origin.id, "<inline:cadence>");
	assert.equal(held.entries[1].input.userCommand, undefined);
	assert.deepEqual(session.agent.inspectQueuedMessages(), []);
});

test("user-command origin belongs only to the registered owner while its handler is active", async (t) => {
	const held = inbox((input, dispatch) => (input.origin.kind === "host" ? dispatch() : undefined));
	const late = deferred();
	let beta;
	const { session, requests } = await createFlowSession(t, {
		ingress: held.handler,
		extensions: [
			{
				name: "beta",
				factory: (api) => {
					beta = api;
				},
			},
			{
				name: "alpha",
				factory: (api) =>
					api.registerCommand("trigger", {
						flowExtensionPath: "<inline:beta>",
						sourceInfo: { path: "<inline:beta>" },
						handler: () => {
							api.sendUserMessage("owner");
							beta.sendUserMessage("other");
							late.promise.then(() => api.sendUserMessage("later"));
						},
					}),
			},
		],
	});
	await session.prompt("/trigger");
	late.resolve();
	await tick();
	const [root, owner, other, later] = held.entries.map(({ input }) => input);
	assert.equal(owner.userCommand.submissionId, root.id);
	assert.equal(owner.userCommand.name, "trigger");
	assert.equal(other.userCommand, undefined);
	assert.equal(later.userCommand, undefined);
	assert.equal(requests.length, 0);
});

test("an extension invoking a slash command cannot acquire user-command priority", async (t) => {
	let api;
	const held = inbox((input, dispatch) => (input.args[0] === "/trigger" ? dispatch() : undefined));
	const { requests } = await createFlowSession(t, {
		ingress: held.handler,
		extensions: [
			{
				name: "alpha",
				factory: (extension) => {
					api = extension;
					api.registerCommand("trigger", { handler: () => api.sendUserMessage("owner") });
				},
			},
		],
	});
	api.sendUserMessage("/trigger", { expandPromptTemplates: true });
	await tick();
	assert.equal(held.entries.length, 2);
	assert.ok(held.entries.every(({ input }) => input.origin.kind === "extension" && input.userCommand === undefined));
	assert.equal(requests.length, 0);
});

test("disposed attachment rejects retained dispatch while another session remains usable", async (t) => {
	const held = inbox();
	const first = await createFlowSession(t, { ingress: held.handler });
	const second = await createFlowSession(t, { ingress: { version: 1, submit: (_input, dispatch) => dispatch() } });
	await first.session.sendUserMessage("old");
	first.session.dispose();
	await assert.rejects(held.entries[0].dispatch(), /closed/);
	await second.session.prompt("new");
	assert.equal(first.requests.length, 0);
	assert.equal(second.requests.length, 1);
});

test("dispose during asynchronous input preflight prevents the pending native run", async (t) => {
	const entered = deferred();
	const release = deferred();
	const { session, requests } = await createFlowSession(t, {
		ingress: { version: 1, submit: (_input, dispatch) => dispatch() },
		extensions: [
			{
				name: "preflight",
				factory: (api) => {
					api.on("input", async () => {
						entered.resolve();
						await release.promise;
						return { action: "continue" };
					});
				},
			},
		],
	});
	const running = session.prompt("user");
	await entered.promise;
	session.dispose();
	release.resolve();
	await assert.rejects(running);
	assert.equal(requests.length, 0);
});

test("branch change fences held sends and refuses to carry native queued input", async (t) => {
	const held = inbox((input, dispatch) => (input.api === "followUp" ? dispatch() : undefined));
	const { session, requests } = await createFlowSession(t, { ingress: held.handler });
	const target = session.sessionManager.appendMessage(message("branch point"));
	session.sessionManager.appendMessage(assistant());
	await session.sendUserMessage("old branch");
	await session.followUp("queued user");
	await assert.rejects(session.navigateTree(target), /must settle or be cancelled/);
	assert.deepEqual(session.clearQueue().followUp, ["queued user"]);
	await session.navigateTree(target);
	await assert.rejects(held.entries[0].dispatch(), /replaced attachment/);
	await session.sendUserMessage("new branch");
	assert.notEqual(held.entries[0].input.scope.attachmentId, held.entries.at(-1).input.scope.attachmentId);
	assert.equal(requests.length, 0);
});

test("unsupported ingress versions fail initialization rather than creating an uncaptured session", async (t) => {
	await assert.rejects(
		createFlowSession(t, { ingress: { version: 2, submit() {} } }),
		/Unsupported flow ingress protocol/,
	);
});

for (const reject of [false, true]) {
	test(`submission joins an unawaited dispatch when handler rejects: ${reject}`, async (t) => {
		const entered = deferred();
		const release = deferred();
		const held = inbox((_input, dispatch) => {
			dispatch();
			if (reject) throw new Error("Handler failed after dispatch");
		});
		const { session } = await createFlowSession(t, { ingress: held.handler });
		session.agent.streamFunction = async () => {
			entered.resolve();
			await release.promise;
			const final = assistant();
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "done", partial: final };
				},
				result: async () => final,
			};
		};
		let settled = false;
		const sending = session.prompt("joined");
		const outcome = sending.then(
			() => {
				settled = true;
			},
			(error) => {
				settled = true;
				return error;
			},
		);
		await entered.promise;
		await tick();
		assert.equal(settled, false);
		release.resolve();
		const error = await outcome;
		if (reject) assert.match(error.message, /Handler failed after dispatch/);
		else assert.equal(error, undefined);
		await assert.rejects(held.entries[0].dispatch(), reject ? /rejected/ : /already dispatched/);
	});
}

test("invalid preflight callback rejects before submission", async (t) => {
	const held = inbox();
	const { session, requests } = await createFlowSession(t, { ingress: held.handler });
	await assert.rejects(session.prompt("invalid", { preflightResult: true }), /must be a function/);
	assert.equal(held.entries.length, 0);
	assert.equal(requests.length, 0);
});

test("branch callbacks drain and attach before tree events while sends remain fenced", async (t) => {
	const before = deferred(),
		releaseBefore = deferred(),
		after = deferred(),
		releaseAfter = deferred();
	const seen = [];
	const held = inbox();
	held.handler.beforeBranchChange = async (scope) => {
		seen.push(["before", scope]);
		before.resolve();
		await releaseBefore.promise;
	};
	held.handler.branchChanged = async (scope) => {
		seen.push(["after", scope]);
		after.resolve();
		await releaseAfter.promise;
	};
	const { session } = await createFlowSession(t, {
		ingress: held.handler,
		extensions: [
			(pi) =>
				pi.on("session_tree", () => {
					seen.push(["event"]);
				}),
		],
	});
	const target = session.sessionManager.appendMessage(message("target"));
	session.sessionManager.appendMessage(assistant());
	const oldLeaf = session.sessionManager.getLeafId();
	await session.sendUserMessage("old");
	const navigation = session.navigateTree(target);
	await before.promise;
	assert.equal(session.sessionManager.getLeafId(), oldLeaf);
	await assert.rejects(session.prompt("during detach"), /transition/);
	await assert.rejects(held.entries[0].dispatch(), /transition/);
	releaseBefore.resolve();
	await after.promise;
	assert.notEqual(session.sessionManager.getLeafId(), oldLeaf);
	assert.deepEqual(
		seen.map((item) => item[0]),
		["before", "after"],
	);
	await assert.rejects(session.prompt("during attach"), /transition/);
	releaseAfter.resolve();
	await navigation;
	assert.deepEqual(
		seen.map((item) => item[0]),
		["before", "after", "event"],
	);
	assert.equal(seen[0][1].attachmentId, held.entries[0].input.scope.attachmentId);
	assert.notEqual(seen[1][1].attachmentId, seen[0][1].attachmentId);
	await assert.rejects(held.entries[0].dispatch(), /replaced attachment/);
	await session.prompt("new");
	assert.deepEqual(held.entries[1].input.scope, seen[1][1]);
});

for (const phase of ["beforeBranchChange", "branchChanged"]) {
	test(`failed ${phase} keeps ingress fenced and prevents tree notification`, async (t) => {
		const held = inbox();
		held.handler[phase] = async () => {
			throw new Error("branch storage failed");
		};
		let events = 0;
		const { session } = await createFlowSession(t, {
			ingress: held.handler,
			extensions: [
				(pi) =>
					pi.on("session_tree", () => {
						events++;
					}),
			],
		});
		const target = session.sessionManager.appendMessage(message("target"));
		session.sessionManager.appendMessage(assistant());
		const oldLeaf = session.sessionManager.getLeafId();
		await assert.rejects(session.navigateTree(target), /branch storage failed/);
		assert.equal(session.sessionManager.getLeafId() === oldLeaf, phase === "beforeBranchChange");
		await assert.rejects(session.prompt("unsafe continuation"), /transition/);
		assert.equal(events, 0);
	});
	test(`disposal during ${phase} prevents transition completion`, async (t) => {
		const entered = deferred(),
			release = deferred();
		const held = inbox();
		let cleaned = false;
		held.handler.dispose = () => {
			cleaned = true;
		};
		held.handler[phase] = async () => {
			entered.resolve();
			await release.promise;
		};
		const { session } = await createFlowSession(t, { ingress: held.handler });
		const target = session.sessionManager.appendMessage(message("target"));
		session.sessionManager.appendMessage(assistant());
		const oldLeaf = session.sessionManager.getLeafId();
		const navigation = assert.rejects(session.navigateTree(target), /closed/);
		await entered.promise;
		const disposing = session.dispose();
		await tick();
		assert.equal(cleaned, false);
		release.resolve();
		await Promise.all([navigation, disposing]);
		assert.equal(cleaned, true);
		assert.equal(session.sessionManager.getLeafId() === oldLeaf, phase === "beforeBranchChange");
	});
}

test("cancelled and no-op tree navigation do not detach branch state", async (t) => {
	const held = inbox();
	let transitions = 0;
	held.handler.beforeBranchChange = () => {
		transitions++;
	};
	held.handler.branchChanged = () => {
		transitions++;
	};
	const { session } = await createFlowSession(t, {
		ingress: held.handler,
		extensions: [(pi) => pi.on("session_before_tree", () => ({ cancel: true }))],
	});
	const target = session.sessionManager.appendMessage(message("target"));
	const leaf = session.sessionManager.appendMessage(assistant());
	await session.navigateTree(leaf);
	assert.equal((await session.navigateTree(target)).cancelled, true);
	assert.equal(transitions, 0);
	await session.prompt("still attached");
	assert.equal(held.entries.length, 1);
});

test("native queue mutation during branch drainage prevents transcript mutation", async (t) => {
	const held = inbox();
	let session;
	held.handler.beforeBranchChange = () => {
		session.agent.followUp(message("late"));
	};
	({ session } = await createFlowSession(t, { ingress: held.handler }));
	const target = session.sessionManager.appendMessage(message("target"));
	const leaf = session.sessionManager.appendMessage(assistant());
	await assert.rejects(session.navigateTree(target), /must settle or be cancelled/);
	assert.equal(session.sessionManager.getLeafId(), leaf);
	await assert.rejects(session.prompt("fenced"), /transition/);
	session.clearQueue();
});

test("branch callbacks reject self-disposal instead of waiting on themselves", async (t) => {
	const held = inbox();
	let session;
	held.handler.beforeBranchChange = async () => {
		await session.dispose();
	};
	({ session } = await createFlowSession(t, { ingress: held.handler }));
	const target = session.sessionManager.appendMessage(message("target"));
	session.sessionManager.appendMessage(assistant());
	await assert.rejects(session.navigateTree(target), /cannot join its own disposal/);
	await session.dispose();
});
