import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { createScheduleWaitExtension } from "../dist/flow-control/schedule-waits.js";

const scope = { sessionId: "session", branchId: "branch" };
async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "schedule-waits-"));
	await mkdir(join(root, ".pi"));
	let attachment = await PiFlowAttachment.open(join(root, "flow"), scope);
	await attachment.waits.registerWork("work", "lane", 0);
	await attachment.waits.shareWork("work", "lane", 1, "schedule", 0);
	const events = createEventBus(),
		handlers = new Map(),
		errors = [];
	let current = { id: "work", revision: 2 },
		enabled = true;
	const job = { id: "job", createdAt: new Date().toISOString(), enabled: true, runCount: 0, session: "session" };
	const extension = createScheduleWaitExtension({
		ingress: () => ({ branch: () => ({ attachment, workContext: { current: () => current } }) }),
		enabled: () => enabled,
		onError: (error) => errors.push(error),
	});
	extension.factory({ events, on: (name, handler) => handlers.set(name, handler) });
	const save = (jobs = [job]) =>
		writeFile(join(root, ".pi/schedule-prompts.json"), JSON.stringify({ version: 1, jobs }));
	await save();
	extension.attach(attachment, root);
	const call = (id = "call", action = "add") =>
		handlers.get("tool_call")({ toolName: "schedule_prompt", toolCallId: id, input: { action } });
	const result = (isError = false, details = { action: "add", jobId: job.id, jobs: [job] }) =>
		handlers.get("tool_result")({
			toolName: "schedule_prompt",
			toolCallId: "call",
			isError,
			details,
			content: [{ type: "text", text: "Created" }],
		});
	t.after(async () => {
		await extension.detach();
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		errors,
		job,
		events,
		call,
		result,
		save,
		extension,
		get attachment() {
			return attachment;
		},
		setCurrent(value) {
			current = value;
		},
		setEnabled(value) {
			enabled = value;
		},
		async wait(dependency) {
			await attachment.waits.declareOwned(
				"lane",
				2,
				{
					scope,
					workId: "work",
					token: "wait",
					reason: "Schedule trigger",
					mode: "all",
					on: [dependency],
					expiresAt: Date.now() + 10000,
				},
				Date.now(),
				10000,
			);
		},
		async emit(event) {
			events.emit("cron:change", event);
			await attachment.waitProducers.probeExecution("schedule", `${job.id}@${job.createdAt}`);
		},
		async reopen() {
			await extension.detach();
			await attachment.close();
			attachment = await PiFlowAttachment.open(join(root, "flow"), scope);
			extension.attach(attachment, root);
			await attachment.waitProducers.restorePending();
		},
	};
}

test("first trigger settles once despite duplicate fires and one-shot auto-disable", async (t) => {
	const f = await fixture(t);
	f.call();
	const result = await f.result();
	const dependency = result.details.waitDependency;
	assert.deepEqual(dependency, {
		producer: "schedule",
		handle: "job",
		execution: `job@${f.job.createdAt}`,
		until: "first-trigger",
	});
	assert.match(result.content[1].text, /not completion/);
	await f.wait(dependency);
	await f.emit({ type: "fire", job: f.job });
	f.job.enabled = false;
	await f.save();
	await f.emit({ type: "update", job: f.job });
	await f.emit({ type: "fire", job: f.job });
	assert.equal((await f.attachment.waits.snapshot())[0].state, "resolved");
	await f.reopen();
	assert.equal((await f.attachment.waits.snapshot())[0].state, "resolved");
	assert.deepEqual(f.errors, []);
	const authority = await f.attachment.waits.authoritySnapshot();
	assert.equal(f.attachment.waitProducers.retirementCandidates(authority.executions).executions.length, 1);
});
for (const outcome of ["disable", "remove", "error"])
	test(`${outcome} before the first trigger fails the wait`, async (t) => {
		const f = await fixture(t);
		f.call();
		await f.wait((await f.result()).details.waitDependency);
		if (outcome === "disable") {
			f.job.enabled = false;
			await f.save();
		}
		if (outcome === "remove") await f.save([]);
		await f.emit(outcome === "disable" ? { type: "update", job: f.job } : { type: outcome, jobId: f.job.id });
		assert.equal((await f.attachment.waits.snapshot())[0].state, "failed");
		assert.deepEqual(f.errors, []);
	});
test("a trigger before tool_result is reconstructed from storage", async (t) => {
	const f = await fixture(t);
	f.call();
	f.job.lastStatus = "running";
	await f.save();
	await f.wait((await f.result()).details.waitDependency);
	assert.equal((await f.attachment.waits.snapshot())[0].state, "resolved");
});
test("pending schedule subscriptions restore and receive a trigger", async (t) => {
	const f = await fixture(t);
	f.call();
	await f.wait((await f.result()).details.waitDependency);
	await f.reopen();
	await f.emit({ type: "fire", job: f.job });
	assert.equal((await f.attachment.waits.snapshot())[0].state, "resolved");
	assert.deepEqual(f.errors, []);
});
test("authority is captured before add and errors or other actions return no receipt", async (t) => {
	const f = await fixture(t);
	f.setCurrent(undefined);
	assert.throws(() => f.call(), /owning work/);
	f.setCurrent({ id: "work", revision: 2 });
	f.call();
	assert.equal(await f.result(true), undefined);
	f.call("call", "list");
	assert.equal(await f.result(), undefined);
	f.call();
	f.setCurrent(undefined);
	assert.equal((await f.result()).details.waitDependency.producer, "schedule");
});
test("flow off leaves schedule creation alone", async (t) => {
	const f = await fixture(t);
	f.setEnabled(false);
	f.call();
	assert.equal(await f.result(), undefined);
});
for (const corrupt of ["{", '{"version":2,"jobs":[]}', '{"version":1,"jobs":[{}]}'])
	test(`corrupt storage refuses a receipt: ${corrupt}`, async (t) => {
		const f = await fixture(t);
		f.call();
		await writeFile(join(f.root, ".pi/schedule-prompts.json"), corrupt);
		const result = await f.result();
		assert.equal(result.isError, true);
		assert.match(result.content[1].text, /do not create a duplicate/);
		assert.equal(result.details?.waitDependency, undefined);
		assert.equal((await f.attachment.waits.authoritySnapshot()).executions.length, 0);
		assert.equal(f.errors.length, 1);
	});
test("a schedule without a creation receipt cannot acquire invented work ownership", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		f.attachment.waitProducers.bindForWait(
			"schedule",
			{ workId: "work", handle: f.job.id, execution: `${f.job.id}@${f.job.createdAt}` },
			2,
		),
		/registered launch receipt/,
	);
	assert.deepEqual((await f.attachment.waits.authoritySnapshot()).executions, []);
});

test("foreign-session jobs cannot issue receipts", async (t) => {
	const f = await fixture(t);
	f.call();
	f.job.session = "other";
	await f.save();
	assert.equal((await f.result()).isError, true);
	assert.equal((await f.attachment.waits.authoritySnapshot()).executions.length, 0);
});
