import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { createSubagentWaitExtension, subagentWaitEvidence } from "../dist/flow-control/subagent-waits.js";

const scope = { sessionId: "session", branchId: "branch" };
async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-subagent-waits-"));
	let attachment = await PiFlowAttachment.open(root, scope);
	await attachment.waits.registerWork("work", "lane", 0);
	await attachment.waits.shareWork("work", "lane", 1, "subagent", 0);
	const handlers = new Map(),
		listeners = new Set(),
		errors = [];
	const run = { id: "run-1", parentSessionId: scope.sessionId, status: "running" };
	let current = { id: "work", revision: 2 },
		enabled = true;
	const branch = () => ({ attachment, workContext: { current: () => current } });
	const extension = createSubagentWaitExtension({
		ingress: () => ({ branch }),
		enabled: () => enabled,
		onError: (e) => errors.push(e),
	});
	extension.factory({
		on: (name, handler) => handlers.set(name, handler),
		events: {
			emit(_name, request) {
				request.accept({
					get(id) {
						assert.equal(id, run.id);
						return structuredClone(run);
					},
					subscribe(changed) {
						listeners.add(changed);
						return () => listeners.delete(changed);
					},
				});
			},
		},
	});
	const attach = () => extension.attach(attachment, { getSessionId: () => scope.sessionId });
	attach();
	const call = (id = "call-1", op = "launch") =>
		handlers.get("tool_call")({ toolName: "subagent", toolCallId: id, input: { op } });
	const result = (id = "call-1", isError = false) =>
		handlers.get("tool_result")({
			toolName: "subagent",
			toolCallId: id,
			content: [{ type: "text", text: JSON.stringify({ id: run.id }) }],
			details: { presentation: "retained" },
			isError,
		});
	t.after(async () => {
		await extension.detach();
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		extension,
		call,
		result,
		errors,
		listeners,
		get attachment() {
			return attachment;
		},
		setCurrent(value) {
			current = value;
		},
		setEnabled(value) {
			enabled = value;
		},
		async status(status) {
			run.status = status;
			for (const changed of listeners) changed();
			await attachment.waitProducers.probeExecution("subagent", run.id);
		},
		async reopen() {
			await attachment.close();
			attachment = await PiFlowAttachment.open(root, scope);
			attach();
			await attachment.waitProducers.restorePending();
		},
		request(dependency) {
			return {
				scope,
				workId: "work",
				token: "wait",
				reason: "Child result",
				mode: "all",
				on: [dependency],
				expiresAt: Date.now() + 10000,
			};
		},
	};
}
for (const status of ["completed", "failed", "cancelled", "interrupted"]) {
	test(`exact child ${status} evidence settles the registered wait`, async (t) => {
		const f = await fixture(t);
		f.call();
		const result = await f.result();
		const dependency = result.details.waitDependency;
		assert.deepEqual(dependency, { producer: "subagent", handle: "run-1", execution: "run-1", until: "terminal" });
		assert.equal(result.details.presentation, "retained");
		await f.attachment.waits.declareOwned("lane", 2, f.request(dependency), Date.now(), 10000);
		await f.status(status);
		const [wait] = await f.attachment.waits.snapshot();
		assert.notEqual(wait.state, "waiting");
		const authority = await f.attachment.waits.authoritySnapshot();
		assert.equal(
			authority.executions[0].predicates[0].state,
			status === "completed" ? "satisfied" : status === "cancelled" ? "cancelled" : "failed",
		);
		assert.deepEqual(f.errors, []);
	});
}
test("completion before result registration is retained and survives reopening", async (t) => {
	const f = await fixture(t);
	f.call();
	await f.status("completed");
	const result = await f.result();
	await f.reopen();
	await f.attachment.waits.declareOwned("lane", 2, f.request(result.details.waitDependency), Date.now(), 10000);
	assert.equal((await f.attachment.waits.snapshot())[0].state, "resolved");
	assert.deepEqual(f.errors, []);
});
test("pending child subscriptions restore and close on detach", async (t) => {
	const f = await fixture(t);
	f.call();
	const result = await f.result();
	await f.attachment.waits.declareOwned("lane", 2, f.request(result.details.waitDependency), Date.now(), 10000);
	await f.reopen();
	assert.equal(f.listeners.size, 1);
	await f.status("completed");
	assert.equal((await f.attachment.waits.snapshot())[0].state, "resolved");
	await f.extension.detach();
	assert.equal(f.listeners.size, 0);
});
test("launch authority is captured before execution and errors return no receipt", async (t) => {
	const f = await fixture(t);
	f.setCurrent(undefined);
	assert.throws(() => f.call(), /owning work/);
	f.setCurrent({ id: "work", revision: 2 });
	f.call();
	assert.equal(await f.result("call-1", true), undefined);
	assert.equal(f.listeners.size, 0);
	assert.equal(await f.result("untracked"), undefined);
	f.call("resume", "resume");
	f.setCurrent(undefined);
	assert.equal((await f.result("resume")).details.waitDependency.execution, "run-1");
});
test("flow off retains native child behavior without a wait receipt", async (t) => {
	const f = await fixture(t);
	f.setEnabled(false);
	f.call();
	assert.equal(await f.result(), undefined);
	assert.equal(f.listeners.size, 0);
});
test("a child run without a launch receipt cannot acquire invented work ownership", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		f.attachment.waitProducers.bindForWait("subagent", { workId: "work", handle: "run-1", execution: "run-1" }, 2),
		/registered launch receipt/,
	);
	assert.equal(f.listeners.size, 0);
	assert.deepEqual((await f.attachment.waits.authoritySnapshot()).executions, []);
});

test("child evidence rejects cross-session and mismatched handles", () => {
	const identity = { scope, workId: "work", handle: "run", execution: "run" };
	assert.throws(
		() => subagentWaitEvidence(identity, { id: "run", parentSessionId: "foreign", status: "completed" }),
		/exact run/,
	);
	assert.throws(
		() =>
			subagentWaitEvidence(
				{ ...identity, handle: "other" },
				{ id: "run", parentSessionId: "session", status: "completed" },
			),
		/exact run/,
	);
});
