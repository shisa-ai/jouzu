import assert from "node:assert/strict";
import { test } from "node:test";
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
