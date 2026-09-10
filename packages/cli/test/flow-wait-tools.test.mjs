import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
	applyInstalledMultiloopWaitSkill,
	applyMultiloopWaitSkill,
	skillPath,
} from "../../../scripts/apply-multiloop-wait-skill.mjs";
import { assistant, createFlowSession, deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
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
	return {
		session,
		requests,
		tools,
		errors,
		registration,
		attachment,
		listeners,
		call,
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

test("wait tool rejects unsupported health, malformed dependencies, and foreign ownership without creating waits", async (t) => {
	const f = await fixture(t);
	for (const args of [
		{ ...request(), checkAfter: "1h" },
		{ ...request(), on: [{ ...handle, health: "heartbeat" }] },
		{ ...request(), on: [] },
		{ ...request(), on: [handle, handle] },
		{ ...request(), work: "foreign" },
		{ ...request(), deadline: "0s" },
		{ ...request(), deadline: "999999999999999999999h" },
		{ ...request(), on: [{ ...handle, handle: "unknown" }] },
		{ ...request(), mode: "none" },
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
	assert.equal(contexts[0].systemPrompt.split(FLOW_WAIT_GUIDANCE[2]).length - 1, 1);
	assert.equal((await f.attachment.waits.snapshot())[0].state, "waiting");
	const result = contexts[1].messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === "wait-call",
	);
	assert.equal(result.isError, false);
	assert.ok(result.content[0].text.includes('"health":"deadline-only"'));
	f.session.setActiveToolsByName([]);
	await f.session.prompt("status with wait tools disabled");
	assert.ok(!contexts[2].systemPrompt.includes(FLOW_WAIT_GUIDANCE[2]));
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
	// An expected check has nothing to reconcile without a monitored dependency.
	await assert.rejects(f.call("agent_wait", { ...request(), deadline: "4s", checkAfter: "1s" }), {
		code: "identity",
		message: /expected check requires a dependency/,
	});
	const result = await f.call("agent_wait", request());
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
