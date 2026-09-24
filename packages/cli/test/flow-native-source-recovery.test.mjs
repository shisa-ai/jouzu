import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { recoverNativeSources } from "../dist/flow-control/pi-native-source-recovery.js";
import { afterCleanup } from "./fixtures/cleanup.mjs";
import { nativeRequests } from "./fixtures/native-requests.mjs";

async function reopen(t, first, change) {
	const file = first.session.sessionManager.getSessionFile();
	await first.bridge.close();
	await first.dispatch.close();
	await first.attachment.close();
	await change?.(file);
	return nativeRequests(t, { root: first.root, manager: SessionManager.open(file), retainInputs: true });
}

test("native source recovery rebinds exact duplicate transcript entries for later requests", async (t) => {
	const first = await nativeRequests(t, { retainInputs: true });
	first.session.agent.followUpMode = "all";
	await first.session.followUp("same");
	await first.session.followUp("same");
	await first.session.continueQueued();
	const original = await first.attachment.submissions.snapshot();
	const next = await reopen(t, first);
	assert.deepEqual(await next.dispatch.sources(next.session.agent.state.messages), []);
	const before = structuredClone(next.session.agent.state.messages);
	assert.deepEqual(await next.dispatch.recoverSources(), { recovered: 2, unresolved: 0 });
	assert.deepEqual(next.session.agent.state.messages, before);
	assert.deepEqual(
		(await next.dispatch.sources(next.session.agent.state.messages)).map((source) => source.operationId),
		original.map((record) => record.dispatch.operationId),
	);
	await next.session.prompt("later");
	const request = (await next.store.snapshot()).at(-1);
	assert.deepEqual(
		request.sourceCapture.members.slice(0, 2).map((source) => source.operationId),
		original.map((record) => record.dispatch.operationId),
	);
	assert.equal(next.sent.length, 1);
});

test("native custom-message recovery uses Pi's persisted renderer data and timestamp", async (t) => {
	const first = await nativeRequests(t, { retainInputs: true });
	await first.session.sendCustomMessage(
		{ customType: "fixture", content: [{ type: "text", text: "custom" }], display: true, details: { exact: 1 } },
		{ triggerTurn: true },
	);
	const next = await reopen(t, first);
	const before = structuredClone(next.session.agent.state.messages);
	assert.deepEqual(await next.dispatch.recoverSources(), { recovered: 1, unresolved: 0 });
	assert.deepEqual(next.session.agent.state.messages, before);
	assert.equal((await next.dispatch.sources(next.session.agent.state.messages)).length, 1);
	assert.deepEqual(next.session.agent.state.messages[0].details, { exact: 1 });
});

test("custom recovery preserves live timestamps and rejects changed renderer content", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	await f.session.sendCustomMessage(
		{ customType: "fixture", content: [{ type: "text", text: "custom" }], display: true, details: { exact: 1 } },
		{ triggerTurn: true },
	);
	const messages = f.session.agent.state.messages;
	const custom = messages.find((message) => message.role === "custom");
	// Force the two host clocks apart without changing the persisted entry or its receipt.
	custom.timestamp += 1000;
	const before = structuredClone(messages);
	assert.deepEqual(await f.dispatch.recoverSources(), { recovered: 1, unresolved: 0 });
	assert.equal(f.session.agent.state.messages, messages);
	assert.equal(messages[0], custom);
	assert.deepEqual(messages, before);
	await f.session.prompt("next");
	assert.equal(f.sent.length, 2);
	custom.details.exact = 2;
	await assert.rejects(f.dispatch.recoverSources(), { code: "identity" });
	assert.equal(f.session.agent.state.messages, messages);
});

test("native source recovery respects Pi compaction context selection", async (t) => {
	const first = await nativeRequests(t, { retainInputs: true });
	await first.session.prompt("old");
	await first.session.prompt("kept");
	const records = await first.attachment.submissions.snapshot();
	const keptId = records[1].dispatch.promptHistory[0].entryId;
	first.session.sessionManager.appendCompaction("summary", keptId, 100);
	const next = await reopen(t, first);
	assert.deepEqual(await next.dispatch.recoverSources(), { recovered: 1, unresolved: 0 });
	assert.deepEqual(
		(await next.dispatch.sources(next.session.agent.state.messages)).map((source) => source.operationId),
		[records[1].dispatch.operationId],
	);
});

for (const stopReason of ["error", "length"]) {
	test(`request recovery accepts Pi's persisted ${stopReason} omissions after compaction`, async (t) => {
		const f = await nativeRequests(t, { retainInputs: true });
		await f.session.prompt("kept input");
		const [record] = await f.attachment.submissions.snapshot();
		const terminal = { ...f.session.agent.state.messages.at(-1), stopReason };
		const terminalId = f.session.sessionManager.appendMessage(terminal);
		const resultId = f.session.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "recovery-tool",
			toolName: "fixture",
			content: [{ type: "text", text: "failed attempt result" }],
			isError: true,
			timestamp: 1,
		});
		f.session.sessionManager.appendCompaction("summary", record.dispatch.promptHistory[0].entryId, 100);
		f.session.sessionManager.appendContextEdit(terminalId, null);
		f.session.sessionManager.appendContextEdit(resultId, null);
		// Pi 0.87 persists recovery omissions and refreshes state from that projection.
		f.session.agent.state.messages = f.session.sessionManager.buildSessionProjection().messages;
		const live = f.session.agent.state.messages;
		const recovered = await recoverNativeSources(f.session, f.attachment.submissions, true);
		assert.equal(recovered.recovered, 1);
		assert.equal(recovered.unresolved, 0);
		assert.equal(recovered.apply().get(live.find((message) => message.role === "user")).length, 1);
		assert.equal(f.session.agent.state.messages, live);
		assert.equal(f.session.sessionManager.getEntry(terminalId).message.stopReason, stopReason);
		assert.equal(f.session.sessionManager.getEntry(resultId).message.role, "toolResult");
		assert.ok(!live.some((message) => message === terminal || message.toolCallId === "recovery-tool"));
		live.find((message) => message.role === "user").content[0].text = "changed input";
		await assert.rejects(recoverNativeSources(f.session, f.attachment.submissions, true), { code: "identity" });
	});
}

test("request recovery still rejects omitted successful assistant messages", async (t) => {
	const f = await nativeRequests(t, { retainInputs: true });
	await f.session.prompt("kept input");
	f.session.agent.state.messages = f.session.agent.state.messages.slice(0, -1);
	await assert.rejects(recoverNativeSources(f.session, f.attachment.submissions, true), { code: "identity" });
});

test("changed native transcript receipts stop recovery without replacing live context", async (t) => {
	const first = await nativeRequests(t, { retainInputs: true });
	await first.session.prompt("original");
	const next = await reopen(t, first, async (file) => {
		const entries = (await readFile(file, "utf8")).trimEnd().split("\n").map(JSON.parse);
		entries.find((entry) => entry.type === "message" && entry.message.role === "user").message.content[0].text =
			"changed on disk";
		await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	});
	const messages = next.session.agent.state.messages;
	await assert.rejects(next.dispatch.recoverSources(), { code: "identity" });
	assert.equal(next.session.agent.state.messages, messages);
	assert.equal(messages.find((message) => message.role === "user").content[0].text, "changed on disk");
	assert.deepEqual(await next.dispatch.sources(messages), []);
});

test("native source recovery preserves unpersisted live edits", async (t) => {
	const first = await nativeRequests(t, { retainInputs: true });
	await first.session.prompt("persisted");
	const next = await reopen(t, first);
	next.session.agent.state.messages = [
		...next.session.agent.state.messages,
		{ role: "user", content: "local only", timestamp: 1 },
	];
	const messages = next.session.agent.state.messages;
	await assert.rejects(next.dispatch.recoverSources(), { code: "identity" });
	assert.equal(next.session.agent.state.messages, messages);
});

test("missing native history remains unresolved despite matching transcript content", async (t) => {
	const first = await nativeRequests(t, { retainInputs: true });
	t.mock.method(first.attachment.submissions, "recordPromptHistory", async () => {});
	await first.session.prompt("no receipt");
	const next = await reopen(t, first);
	assert.deepEqual(await next.dispatch.recoverSources(), { recovered: 0, unresolved: 1 });
	assert.deepEqual(await next.dispatch.sources(next.session.agent.state.messages), []);
});

test("closing during native source recovery drains it without applying late bindings", async (t) => {
	const first = await nativeRequests(t, { retainInputs: true });
	await first.session.prompt("source");
	const next = await reopen(t, first);
	const entered = deferred(),
		release = deferred();
	const snapshot = next.attachment.submissions.snapshot.bind(next.attachment.submissions);
	t.mock.method(next.attachment.submissions, "snapshot", async () => {
		entered.resolve();
		await release.promise;
		return snapshot();
	});
	const messages = next.session.agent.state.messages;
	const recovering = next.dispatch.recoverSources();
	const rejected = assert.rejects(recovering, { code: "stale" });
	await entered.promise;
	const closing = next.dispatch.close();
	release.resolve();
	await rejected;
	await closing;
	assert.equal(next.session.agent.state.messages, messages);
});

test("process death restores native source identity for a later request without replay", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-source-recovery-kill-"));
	const child = fork(new URL("./fixtures/native-source-recovery-crash.mjs", import.meta.url), [root], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const exited = once(child, "exit");
	afterCleanup(t, async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	});
	const [saved] = await Promise.race([
		once(child, "message"),
		exited.then(() => {
			throw new Error("Source recovery fixture exited before checkpoint");
		}),
	]);
	assert.equal(saved.sent, 1);
	child.kill("SIGKILL");
	await exited;
	const next = await nativeRequests(t, { root, manager: SessionManager.open(saved.file), retainInputs: true });
	assert.deepEqual(await next.dispatch.recoverSources(), { recovered: 1, unresolved: 0 });
	assert.equal(next.sent.length, 0);
	await next.session.prompt("later request");
	const requests = await next.store.snapshot();
	assert.equal(requests.length, 2);
	assert.equal(requests[1].sourceCapture.members[0].operationId, saved.operationId);
	assert.equal(next.sent.length, 1);
});
