import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { getCurrentSystemPrompt, validateToolArguments } from "@earendil-works/pi-ai";
import { makeStrictJsonSchema } from "@earendil-works/pi-ai/api/constrained-sampling";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { prepareToolCall } from "../../../node_modules/@earendil-works/pi-agent-core/dist/harness/execution/tools.js";
import {
	applyInstalledMultiloopWaitSkill,
	applyMultiloopWaitSkill,
	lanesPath,
	skillPath,
	transformMultiloopArchive,
} from "../../../scripts/apply-multiloop-wait-skill.mjs";
import { assistant, createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { observedWaitToolReceipt } from "../dist/flow-control/wait-tool-response.js";
import { createFlowWaitExtension, FLOW_WAIT_GUIDANCE } from "../dist/flow-control/wait-tools.js";

const handle = { producer: "bg", handle: "bg-1", execution: "exec-1", until: "exit" };
const request = () => ({ work: "work", reason: "process must exit", deadline: "8h", on: [handle] });
const policy = {
	name: "sweep-progress-v1",
	evidence: "sweep step counter",
	freshnessMs: 60_000,
	probeTimeoutMs: 5_000,
	graceMs: 10_000,
	cadenceMs: 30_000,
};
async function fixture(t, snapshot, healthPolicies) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-wait-tools-"));
	let attachment,
		active = true,
		clock = Date.now(),
		revision = 2,
		state = "pending";
	const tools = new Map(),
		errors = [];
	const extension = createFlowWaitExtension({
		attachment: () => attachment,
		currentWork: () => ({ id: "work", revision }),
		maxDurationMs: 5000,
		now: () => clock,
		authorize(work) {
			if (work !== "work") throw new Error("unauthorized work");
			return {
				actor: "lane",
				revision,
				assertActive() {
					if (!active) throw new Error("invocation retired");
				},
			};
		},
	});
	const { session, requests } = await createFlowSession(t, {
		persist: true,
		tools: ["agent_wait", "agent_wait_cancel"],
		extensions: [
			{
				name: extension.name,
				factory(pi) {
					const proxy = Object.create(pi);
					proxy.registerTool = (tool) => {
						tools.set(tool.name, tool);
						pi.registerTool(tool);
					};
					extension.factory(proxy);
				},
			},
		],
	});
	await session.bindExtensions({ onError: (error) => errors.push(error) });
	attachment = await PiFlowAttachment.open(root, { sessionId: session.sessionId, branchId: "branch" });
	await attachment.waits.registerWork("work", "lane", clock);
	await attachment.waits.shareWork("work", "lane", 1, "bg", clock);
	const listeners = new Set();
	const registration = attachment.waitProducers.register(
		{
			version: 1,
			namespace: "bg",
			subscribe(_identity, changed) {
				listeners.add(changed);
				return () => listeners.delete(changed);
			},
			async snapshot(identity) {
				if (identity.handle !== handle.handle || identity.execution !== handle.execution)
					throw new Error("unknown execution");
				await snapshot?.();
				return { ...identity, revision: state === "pending" ? 1 : 2, predicates: [{ until: "exit", state }] };
			},
			...(healthPolicies ? { healthPolicies } : {}),
		},
		(error) => errors.push(error),
	);
	t.after(async () => {
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	const call = (name, args, signal) =>
		tools.get(name).execute("call", args, signal, undefined, { sessionManager: session.sessionManager });
	const preparedCall = (args) => {
		const prepared = prepareToolCall({ id: "call", name: "agent_wait", arguments: args }, [tools.get("agent_wait")]);
		if (prepared.kind === "immediate") throw new Error(prepared.result.content[0].text);
		return call("agent_wait", prepared.args);
	};
	return {
		session,
		requests,
		tools,
		errors,
		registration,
		attachment,
		listeners,
		call,
		preparedCall,
		get now() {
			return clock;
		},
		advance(ms) {
			clock += ms;
		},
		retire() {
			active = false;
		},
		set revision(value) {
			revision = value;
		},
		set state(value) {
			state = value;
		},
	};
}

test("wait schema keeps optional fields optional and strict providers derive a nullable form", () => {
	const tools = new Map();
	createFlowWaitExtension({ maxDurationMs: 5000 }).factory({
		on() {},
		getActiveTools: () => [],
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
	});
	const wait = tools.get("agent_wait");
	assert.deepEqual(wait.parameters.required, ["reason", "deadline", "on"]);
	assert.deepEqual(Object.keys(wait.parameters.properties).sort(), [
		"checkAfter",
		"deadline",
		"mode",
		"on",
		"reason",
		"replaceToken",
		"work",
	]);
	assert.deepEqual(wait.parameters.properties.on.items.required, ["producer", "handle", "execution", "until"]);
	assert.deepEqual(wait.constrainedSampling, { type: "json_schema", strict: "prefer" });
	// A strict-capable provider may require every property, but optional fields must stay
	// nullable so the model can decline them instead of inventing a placeholder token.
	const strict = makeStrictJsonSchema(wait.parameters);
	assert.deepEqual([...strict.required].sort(), Object.keys(strict.properties).sort());
	for (const key of ["work", "checkAfter", "mode", "replaceToken"])
		assert.ok(
			strict.properties[key].anyOf?.some((variant) => variant.type === "null"),
			`${key} must stay nullable instead of requiring a placeholder`,
		);
	assert.equal(strict.properties.reason.anyOf, undefined);
	assert.equal(strict.properties.deadline.anyOf, undefined);
	for (const key of ["health", "work", "scope"])
		assert.ok(
			strict.properties.on.items.properties[key].anyOf?.some((variant) => variant.type === "null"),
			`on[].${key} must stay nullable`,
		);
	const tool = {
		name: wait.name,
		description: wait.description,
		parameters: wait.parameters,
		constrainedSampling: wait.constrainedSampling,
	};
	const optional = convertResponsesTools([tool], { supportsStrictMode: false })[0];
	assert.deepEqual(optional.parameters.required, ["reason", "deadline", "on"]);
	assert.equal(optional.strict, undefined);
	const required = convertResponsesTools([tool], { supportsStrictMode: true })[0];
	assert.equal(required.strict, true);
	assert.deepEqual([...required.parameters.required].sort(), Object.keys(required.parameters.properties).sort());
	assert.ok(required.parameters.properties.replaceToken.anyOf?.some((variant) => variant.type === "null"));
	assert.equal(required.parameters.properties.reason.anyOf, undefined);
});

test("wait tool subscribes exact executions, caps expiry, rejects accidental renewal, and cancels only its gate", async (t) => {
	const f = await fixture(t);
	const result = (await f.call("agent_wait", request())).details;
	assert.equal(result.state, "waiting");
	assert.equal(result.work, "work");
	assert.equal(result.expiresAt, f.now + 5000);
	assert.equal(result.health, "deadline-only");
	assert.equal(f.listeners.size, 1);
	await assert.rejects(f.call("agent_wait", request()), { code: "transition" });
	assert.equal((await f.attachment.waits.snapshot()).length, 1);
	const cancelled = (await f.call("agent_wait_cancel", { token: result.token, reason: "redirected" })).details;
	assert.equal(cancelled.state, "cancelled");
	assert.deepEqual((await f.call("agent_wait_cancel", { token: result.token, reason: "repeat" })).details, cancelled);
	const authority = await f.attachment.waits.authoritySnapshot();
	assert.equal(authority.executions[0].predicates[0].state, "pending");
	assert.equal(authority.work[0].lifecycle, undefined);
	assert.equal(f.listeners.size, 1);
	assert.deepEqual(f.requests, []);
});

test("failed replacements leave the live wait and expiry intact; explicit valid replacement is atomic", async (t) => {
	const f = await fixture(t);
	const original = (await f.call("agent_wait", request())).details;
	for (const change of [
		{ replaceToken: "unknown" },
		{ on: [{ ...handle, until: "output" }] },
		{ on: [{ ...handle, execution: "unknown" }] },
	]) {
		await assert.rejects(f.call("agent_wait", { ...request(), replaceToken: original.token, ...change }));
		assert.equal((await f.attachment.waits.snapshot())[0].state, "waiting");
		assert.equal((await f.attachment.waits.snapshot())[0].expiresAt, original.expiresAt);
	}
	f.advance(100);
	const replacement = (await f.call("agent_wait", { ...request(), replaceToken: original.token, deadline: "2s" }))
		.details;
	assert.notEqual(replacement.token, original.token);
	assert.equal(replacement.expiresAt, f.now + 2000);
	assert.deepEqual(
		(await f.attachment.waits.snapshot()).map((wait) => wait.state),
		["cancelled", "waiting"],
	);
});

test("already terminal evidence resolves immediately and can be used after its source closes", async (t) => {
	const f = await fixture(t);
	f.state = "satisfied";
	const result = (await f.call("agent_wait", request())).details;
	assert.equal(result.state, "resolved");
	await f.registration.close();
	assert.equal((await f.call("agent_wait", request())).details.state, "resolved");
	assert.deepEqual(f.requests, []);
});

test("terminal dependencies accept launch health receipts even after their source detaches", async (t) => {
	const f = await fixture(t);
	f.state = "satisfied";
	const args = { ...request(), checkAfter: "1s", on: [{ ...handle, health: policy.name }] };
	assert.equal((await f.call("agent_wait", args)).details.state, "resolved");
	await f.registration.close();
	assert.equal((await f.call("agent_wait", args)).details.state, "resolved");
	assert.deepEqual(f.errors, []);
});

for (const state of ["satisfied", "failed", "cancelled"])
	test(`completion during health lookup resolves exact ${state} evidence`, async (t) => {
		let f;
		f = await fixture(t, undefined, () => {
			f.state = state;
			return [];
		});
		const result = await f.call("agent_wait", { ...request(), on: [{ ...handle, health: policy.name }] });
		assert.equal(result.details.state, state === "satisfied" ? "resolved" : "failed");
		assert.equal((await f.attachment.waits.snapshot())[0].observations[0].state, state);
		assert.deepEqual(f.errors, []);
	});

test("invalid health leaves an existing wait subscription intact", async (t) => {
	const f = await fixture(t);
	const initial = (await f.call("agent_wait", request())).details;
	await assert.rejects(
		f.call("agent_wait", {
			...request(),
			replaceToken: initial.token,
			on: [{ ...handle, health: "unknown" }],
		}),
		/not registered/,
	);
	assert.equal(f.listeners.size, 1);
	assert.equal((await f.attachment.waits.snapshot())[0].state, "waiting");
});

test("a replacement token that names no live wait declares a new wait", async (t) => {
	const f = await fixture(t);
	// A provider that requires every property leaves the model no way to omit replaceToken, so a
	// placeholder declares the wait it asked for instead of dead-ending the call.
	for (const replaceToken of ["unused", "null", "pending", "x", "0", "785", "/", "new"]) {
		const declared = (await f.call("agent_wait", { ...request(), replaceToken })).details;
		assert.equal(declared.state, "waiting");
		assert.equal(f.listeners.size, 1);
		await f.call("agent_wait_cancel", { token: declared.token, reason: "next placeholder" });
	}
	assert.deepEqual(
		(await f.attachment.waits.snapshot()).filter((wait) => wait.state === "waiting"),
		[],
	);
});

test("a placeholder token cannot replace or renew a live wait", async (t) => {
	const f = await fixture(t);
	const created = (await f.call("agent_wait", request())).details;
	for (const replaceToken of ["unused", "null", "pending", "x", "785"]) {
		// The refusal names the live token, because a model that cannot omit the field cannot
		// otherwise comply with an instruction to copy it.
		await assert.rejects(f.call("agent_wait", { ...request(), replaceToken }), {
			code: "stale",
			message: new RegExp(`requires the active token ${created.token}`),
		});
		const [live] = await f.attachment.waits.snapshot();
		assert.equal(live.token, created.token);
		assert.equal(live.state, "waiting");
	}
	const replaced = (await f.call("agent_wait", { ...request(), replaceToken: created.token })).details;
	assert.equal(replaced.state, "waiting");
	assert.notEqual(replaced.token, created.token);
	assert.equal(f.listeners.size, 1);
});

test("none replacement sentinel creates a new wait but cannot replace or renew a live wait", async (t) => {
	const f = await fixture(t);
	const created = (await f.call("agent_wait", { ...request(), replaceToken: "none" })).details;
	assert.equal(created.state, "waiting");
	const before = await f.attachment.waits.snapshot();
	await assert.rejects(f.call("agent_wait", { ...request(), replaceToken: "none" }), /already has a live wait/);
	assert.deepEqual(await f.attachment.waits.snapshot(), before);
	assert.equal(f.listeners.size, 1);
	const replaced = (await f.call("agent_wait", { ...request(), replaceToken: created.token })).details;
	assert.equal(replaced.state, "waiting");
	assert.notEqual(replaced.token, created.token);
});

test("nullable optional arguments mean omission without weakening replacement identity", async (t) => {
	const f = await fixture(t);
	const nullable = {
		work: null,
		reason: "process must exit",
		deadline: "8h",
		checkAfter: null,
		mode: null,
		replaceToken: null,
		on: [{ ...handle, health: null, work: null, scope: null }],
	};
	// pi removes optional nulls before execution; the wait parser accepts the same shape directly.
	assert.deepEqual(validateToolArguments(f.tools.get("agent_wait"), { name: "agent_wait", arguments: nullable }), {
		reason: "process must exit",
		deadline: "8h",
		on: [handle],
	});
	const result = (await f.call("agent_wait", nullable)).details;
	assert.equal(result.state, "waiting");
	assert.equal(result.health, "deadline-only");
	assert.deepEqual((await f.attachment.waits.snapshot())[0].on, [handle]);
	// A null replacement token is omission, so a live wait is still not replaced silently.
	await assert.rejects(f.call("agent_wait", { ...nullable, deadline: "1s" }), { code: "transition" });
	const [live] = await f.attachment.waits.snapshot();
	assert.equal(live.token, result.token);
	assert.equal(live.state, "waiting");
});

test("the all-required argument shape a strict provider forces still declares a wait", async (t) => {
	const f = await fixture(t);
	// Production shape: the provider requires every property and supplies no nullable form, so the
	// model fills the optional fields with placeholders rather than declining them. None of the
	// fabricated values may dead-end the declaration or change what it records.
	const result = (
		await f.preparedCall({
			work: "",
			reason: "process must exit",
			deadline: "4s",
			checkAfter: "1s",
			mode: "all",
			replaceToken: "unused",
			on: [{ ...handle, health: "", work: null, scope: null }],
		})
	).details;
	assert.equal(result.state, "waiting");
	assert.equal(result.health, "deadline-only");
	assert.equal(result.checkAt, undefined);
	assert.equal(result.work, "work");
	assert.equal(result.mode, "all");
	assert.deepEqual((await f.attachment.waits.snapshot())[0].on, [handle]);
});

test("required wait fields stay required and unknown fields fail before a wait is installed", async (t) => {
	const f = await fixture(t);
	const wait = f.tools.get("agent_wait");
	for (const args of [
		{ reason: "process must exit", deadline: "8h" },
		{ ...request(), reason: undefined },
		{ ...request(), deadline: undefined },
		{ ...request(), on: undefined },
		{ ...request(), reason: null },
		{ ...request(), deadline: null },
		{ ...request(), on: null },
		{ ...request(), extra: true },
		{ ...request(), on: [{ ...handle, extra: true }] },
	]) {
		assert.throws(() => validateToolArguments(wait, { name: "agent_wait", arguments: args }));
		await assert.rejects(f.call("agent_wait", args), { code: "schema" });
	}
	assert.deepEqual(await f.attachment.waits.snapshot(), []);
});

test("wait tool rejects unsupported health, malformed dependencies, and foreign ownership without creating waits", async (t) => {
	const f = await fixture(t);
	for (const args of [
		{ ...request(), checkAfter: "8h" },
		{ ...request(), on: [{ ...handle, health: "heartbeat" }] },
		{ ...request(), on: [] },
		{ ...request(), on: [handle, handle] },
		{ ...request(), work: "foreign" },
		{ ...request(), deadline: "0s" },
		{ ...request(), deadline: "999999999999999999999h" },
		{ ...request(), on: [{ ...handle, handle: "unknown" }] },
		{ ...request(), mode: "none" },
		{ ...request(), on: [{ ...handle, work: { id: "foreign", revision: 1 } }] },
		{ ...request(), on: [{ ...handle, work: { id: "work", revision: 0 } }] },
		{ ...request(), on: [{ ...handle, scope: { sessionId: "foreign", branchId: "branch" } }] },
	])
		await assert.rejects(f.call("agent_wait", args));
	f.revision = 1;
	await assert.rejects(f.call("agent_wait", request()), { code: "stale" });
	assert.deepEqual(await f.attachment.waits.snapshot(), []);
	assert.equal(f.listeners.size, 0);
});

for (const abort of [false, true])
	test(`late wait invocation cannot register after ${abort ? "abort" : "work context retirement"}`, async (t) => {
		const entered = deferred(),
			proceed = deferred();
		const f = await fixture(t, async () => {
			entered.resolve();
			await proceed.promise;
		});
		const signal = new AbortController();
		const declaring = f.call("agent_wait", request(), signal.signal);
		await entered.promise;
		if (abort) signal.abort();
		else f.retire();
		proceed.resolve();
		await assert.rejects(declaring);
		assert.deepEqual(await f.attachment.waits.snapshot(), []);
	});

test("authorization is rechecked inside the serialized declaration and cancellation mutation", async (t) => {
	const f = await fixture(t);
	const original = f.attachment.waits.declareOwned.bind(f.attachment.waits);
	f.attachment.waits.declareOwned = (...args) => {
		f.retire();
		return original(...args);
	};
	await assert.rejects(f.call("agent_wait", request()), /retired/);
	assert.deepEqual(await f.attachment.waits.snapshot(), []);
	const second = await fixture(t);
	const wait = (await second.call("agent_wait", request())).details;
	const cancel = second.attachment.waits.cancelOwned.bind(second.attachment.waits);
	second.attachment.waits.cancelOwned = (...args) => {
		second.retire();
		return cancel(...args);
	};
	await assert.rejects(second.call("agent_wait_cancel", { token: wait.token, reason: "cancel" }), /retired/);
	assert.equal((await second.attachment.waits.snapshot())[0].state, "waiting");
});

test("active wait tools add session guidance and a simulated model invokes the registered tool", async (t) => {
	const f = await fixture(t),
		contexts = [];
	f.session.agent.streamFunction = async (_model, context) => {
		contexts.push(context);
		const final =
			contexts.length === 1
				? {
						...assistant(),
						content: [{ type: "toolCall", id: "wait-call", name: "agent_wait", arguments: request() }],
						stopReason: "toolUse",
					}
				: assistant();
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "done", partial: final };
			},
			result: async () => final,
		};
	};
	await f.session.prompt("wait for the process");
	assert.equal(contexts.length, 2);
	assert.equal(getCurrentSystemPrompt(contexts[0].messages).split(FLOW_WAIT_GUIDANCE[2]).length - 1, 1);
	assert.equal((await f.attachment.waits.snapshot())[0].state, "waiting");
	const result = contexts[1].messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === "wait-call",
	);
	assert.equal(result.isError, false);
	const [wait] = await f.attachment.waits.snapshot();
	assert.ok(result.content[0].text.includes(`agent_wait waiting [${wait.token}]`));
	assert.ok(result.content[0].text.includes(`${handle.handle} (${handle.producer}/${handle.until})`));
	const saved = f.session.sessionManager
		.getBranch()
		.find(
			(entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "wait-call",
		);
	assert.equal(saved.message.details.health, "deadline-only");
	f.session.setActiveToolsByName([]);
	await f.session.prompt("status with wait tools disabled");
	assert.ok(!getCurrentSystemPrompt(contexts[2].messages).includes(FLOW_WAIT_GUIDANCE[2]));
	assert.deepEqual(f.errors, []);
});

test("multiloop wait skill patch is pinned, idempotent, and rejects changed source", async (t) => {
	await applyInstalledMultiloopWaitSkill(true);
	const root = resolve(import.meta.dirname, "../../.."),
		installed = join(root, "packages/cli/node_modules/pi-multiloop");
	assert.equal(await applyMultiloopWaitSkill(installed), 0);
	const content = await readFile(join(installed, skillPath), "utf8");
	assert.ok(content.includes("exception to continuing immediately after decide/log"));
	const directory = await mkdtemp(join(tmpdir(), "jouzu-wait-skill-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await mkdir(join(directory, "skills/multiloop"), { recursive: true });
	await writeFile(join(directory, "package.json"), await readFile(join(installed, "package.json")));
	await writeFile(join(directory, skillPath), `${content}\nchanged`);
	await assert.rejects(applyMultiloopWaitSkill(directory), /hash differs/);
	assert.equal(await readFile(join(directory, skillPath), "utf8"), `${content}\nchanged`);
});

test("multiloop archive patch verifies original and installed lanes before writing", async (t) => {
	const root = resolve(import.meta.dirname, "../../..");
	const installed = join(root, "packages/cli/node_modules/pi-multiloop");
	const directory = await mkdtemp(join(tmpdir(), "jouzu-archive-patch-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	for (const path of [
		"package.json",
		skillPath,
		lanesPath,
		"extensions/pi-multiloop/index.ts",
		"extensions/pi-multiloop/jouzu-flow.ts",
	]) {
		await mkdir(join(directory, path, ".."), { recursive: true });
		await writeFile(join(directory, path), await readFile(join(installed, path)));
	}
	const patched = await readFile(join(directory, lanesPath), "utf8");
	const original = patched.replace(
		"  mkdirSync(base, { recursive: true });\n  renameSync(src, dest);",
		"  mkdirSync(dest, { recursive: true });\n  renameSync(src, dest);",
	);
	assert.notEqual(original, patched);
	assert.equal(transformMultiloopArchive(original), patched);
	assert.throws(() => transformMultiloopArchive(patched), /anchor differs/);
	await writeFile(join(directory, lanesPath), original);
	await assert.rejects(applyMultiloopWaitSkill(directory, true), /lanes source hash differs/);
	assert.equal(await applyMultiloopWaitSkill(directory), 1);
	assert.equal(await applyMultiloopWaitSkill(directory), 0);
	assert.equal(await readFile(join(directory, lanesPath), "utf8"), patched);
	await writeFile(join(directory, lanesPath), `${patched}\nchanged`);
	await assert.rejects(applyMultiloopWaitSkill(directory), /lanes source hash differs/);
	assert.equal(await readFile(join(directory, lanesPath), "utf8"), `${patched}\nchanged`);
});

test("a declared policy is accepted, reported per dependency, and bounds its expected check", async (t) => {
	const f = await fixture(t, undefined, () => [policy]);
	const monitored = { ...handle, health: "sweep-progress-v1" };
	const result = await f.call("agent_wait", {
		...request(),
		deadline: "4s",
		checkAfter: "1s",
		on: [monitored],
	});
	assert.equal(result.details.state, "waiting");
	assert.equal(result.details.checkAt, f.now + 1000);
	// Health is named per dependency so a reader can tell which handles are monitored.
	assert.deepEqual(result.details.health, [{ handle: "bg-1", policy: "sweep-progress-v1" }]);
	const [wait] = await f.attachment.waits.snapshot();
	assert.equal(wait.on[0].health, "sweep-progress-v1");
	assert.equal(wait.checkAt, f.now + 1000);
});

test("an unregistered policy is refused before any producer subscription is parked", async (t) => {
	const f = await fixture(t, undefined, () => [policy]);
	await assert.rejects(f.call("agent_wait", { ...request(), on: [{ ...handle, health: "heartbeat-v1" }] }), {
		code: "identity",
		message: /not registered for this execution/,
	});
	// The contract requires an unsupported handle to fail without parking; a leaked subscription
	// would otherwise outlive the refused declaration.
	assert.equal(f.listeners.size, 0);
	assert.deepEqual(await f.attachment.waits.snapshot(), []);
});

test("a producer that declares no policy keeps its waits deadline-only", async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.call("agent_wait", { ...request(), on: [{ ...handle, health: "sweep-progress-v1" }] }), {
		code: "identity",
	});
	// An expected check has nothing to reconcile without a monitored dependency, so an inapplicable
	// checkAfter is dropped instead of refused: a provider that requires every field leaves the model
	// no way to omit it, and the deadline-only wait it asked for is still declared exactly.
	const checked = (await f.call("agent_wait", { ...request(), deadline: "4s", checkAfter: "1s" })).details;
	assert.equal(checked.health, "deadline-only");
	assert.equal(checked.checkAt, undefined);
	assert.equal((await f.attachment.waits.snapshot())[0].checkAt, undefined);
	const result = await f.call("agent_wait", { ...request(), replaceToken: checked.token });
	assert.equal(result.details.health, "deadline-only");
	assert.equal(result.details.checkAt, undefined);
});

test("an invalid policy definition is rejected rather than trusted from the producer", async (t) => {
	const f = await fixture(t, undefined, () => [{ ...policy, cadenceMs: 120_000 }]);
	await assert.rejects(f.call("agent_wait", { ...request(), on: [{ ...handle, health: "sweep-progress-v1" }] }), {
		code: "schema",
	});
	const duplicate = await fixture(t, undefined, () => [policy, { ...policy, evidence: "other" }]);
	await assert.rejects(
		duplicate.call("agent_wait", { ...request(), on: [{ ...handle, health: "sweep-progress-v1" }] }),
		{ code: "identity" },
	);
});

test("workflow guidance follows active extensions and does not duplicate itself", () => {
	let active = ["agent_wait", "bg_task", "TaskUpdate", "schedule_prompt"],
		before;
	createFlowWaitExtension({ maxDurationMs: 5000 }).factory({
		on(name, handler) {
			if (name === "before_agent_start") before = handler;
		},
		getActiveTools: () => active,
		registerTool() {},
	});
	const first = before({ systemPrompt: "Custom system prompt" }).systemPrompt;
	assert.match(first, /notifyOnExit: false/);
	assert.match(first, /TaskUpdate waitForUser: true/);
	assert.match(first, /schedule_prompt for an action due/);
	assert.match(first, /older job does not describe its replacement/);
	assert.equal(before({ systemPrompt: first }), undefined);
	active = ["agent_wait"];
	const reduced = before({ systemPrompt: "Custom system prompt" }).systemPrompt;
	assert.doesNotMatch(reduced, /bg_task|TaskUpdate|schedule_prompt/);
	active = ["bg_task", "TaskUpdate", "schedule_prompt"];
	assert.equal(before({ systemPrompt: "Custom system prompt" }), undefined);
});

test("preparation accepts empty optional fields without changing original arguments", async (t) => {
	const f = await fixture(t);
	const args = {
		reason: "wait",
		deadline: "4s",
		work: "",
		mode: "",
		checkAfter: "",
		replaceToken: "",
		on: [{ ...handle, health: "", work: "", scope: "" }],
	};
	const original = structuredClone(args);
	const result = await f.preparedCall(args);
	assert.equal(result.details.state, "waiting");
	assert.deepEqual(args, original);
	for (const patch of [{ reason: "" }, { deadline: "" }, { unknown: true }, { on: [{ ...handle, execution: "" }] }]) {
		assert.throws(() => f.preparedCall({ ...original, ...patch }), /Validation failed/);
	}
});

test("retained finished tokens cannot silently create another hold", async (t) => {
	const f = await fixture(t);
	const created = (await f.preparedCall(request())).details;
	await f.call("agent_wait_cancel", { token: created.token, reason: "user redirected work" });
	const before = await f.attachment.waits.snapshot();
	await assert.rejects(
		f.preparedCall({ ...request(), replaceToken: created.token }),
		/finished wait.*omit replaceToken/,
	);
	assert.deepEqual(await f.attachment.waits.snapshot(), before);
	const recovered = await f.preparedCall({ ...request(), replaceToken: null });
	assert.equal(recovered.details.state, "waiting");
	assert.notEqual(recovered.details.token, created.token);
});

test("adjustment notices are bounded and immediate-result receipts match returned content", async (t) => {
	const f = await fixture(t);
	f.state = "satisfied";
	const result = await f.preparedCall({ ...request(), replaceToken: "private-placeholder", checkAfter: "1s" });
	const text = result.content.map((part) => part.text).join("\n");
	assert.match(text, /checkAfter ignored/);
	assert.match(text, /Unmatched replaceToken ignored/);
	assert.doesNotMatch(text, /private-placeholder/);
	assert.equal(result.details.state, "resolved");
	const receipts = await f.attachment.waits.toolReceipts();
	assert.ok(
		observedWaitToolReceipt(
			{ role: "toolResult", toolCallId: "call", toolName: "agent_wait", content: result.content },
			receipts,
		),
	);
});

test("expired tokens cannot renew a deadline and omission allows explicit recovery", async (t) => {
	const f = await fixture(t);
	const created = (await f.preparedCall(request())).details;
	f.advance(5001);
	await f.attachment.waits.expireDue(f.now);
	await assert.rejects(f.preparedCall({ ...request(), replaceToken: created.token }), /finished wait/);
	assert.equal((await f.attachment.waits.snapshot()).length, 1);
	assert.equal((await f.attachment.waits.snapshot())[0].expiresAt, created.expiresAt);
	const next = await f.preparedCall(request());
	assert.equal(next.details.state, "waiting");
	assert.ok(next.details.expiresAt > created.expiresAt);
});
