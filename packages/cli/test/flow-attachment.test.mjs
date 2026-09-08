import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context, JsonlSessionRepo, MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { FlowOwnership } from "../dist/flow-control/ownership.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";

const scope = { sessionId: "parent", branchId: "branch" };
const member = { id: "result", revision: "1", kind: "result", required: false, contentHash: "a".repeat(64) };
const deferred = () => {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-attachment-"));
	const repo = new MemorySessionRepo();
	const attachments = [];
	t.after(async () => {
		for (const attachment of attachments) await attachment.close();
		await repo.close(context);
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		repo,
		async open(openSession = () => repo.create({}, context), selectedScope = scope) {
			const attachment = await PiFlowAttachment.open(root, selectedScope, openSession);
			attachments.push(attachment);
			return attachment;
		},
	};
}

test("attachment obtains ownership before opening Pi storage and fences stale writes", async (t) => {
	const { root, open } = await fixture(t);
	const attachment = await open();
	await assert.rejects(
		open(() => assert.fail("Competing opener executed")),
		{ code: "busy" },
	);
	await attachment.ledger.select("attempt", [member]);
	await attachment.close();
	const replacement = await open();
	await assert.rejects(attachment.ledger.cancel("attempt", "Late cancellation"), { code: "closed" });
	await assert.rejects(attachment.ledger.snapshot(), { code: "closed" });
	assert.equal((await replacement.ledger.snapshot()).attempts.length, 0);
	assert.throws(() => FlowOwnership.acquire(root, scope), { code: "busy" });
});

test("attachment drains Pi mutation before closing the session and releasing ownership", async (t) => {
	const { root, repo, open } = await fixture(t);
	const session = await repo.create({}, context);
	const attachment = await open(async () => session);
	const entered = deferred();
	const release = deferred();
	const originalMutate = session.mutate.bind(session);
	t.mock.method(session, "mutate", (update, currentContext) =>
		originalMutate(async (mutation, mutationContext) => {
			entered.resolve();
			await release.promise;
			return update(mutation, mutationContext);
		}, currentContext),
	);
	const originalClose = session.close.bind(session);
	let sessionClosed = false;
	t.mock.method(session, "close", async (currentContext) => {
		assert.throws(() => FlowOwnership.acquire(root, scope), { code: "busy" });
		await originalClose(currentContext);
		sessionClosed = true;
	});
	const saving = attachment.ledger.select("attempt", [member]);
	await entered.promise;
	const closed = attachment.close();
	assert.equal(attachment.close(), closed);
	assert.equal(sessionClosed, false);
	await assert.rejects(attachment.ledger.select("late", [member]), { code: "closed" });
	assert.throws(() => FlowOwnership.acquire(root, scope), { code: "busy" });
	release.resolve();
	await saving;
	await closed;
	assert.equal(sessionClosed, true);
	const next = FlowOwnership.acquire(root, scope);
	await next.close();
});

test("failed opener releases ownership and failed reconciliation closes opened storage", async (t) => {
	const { root, repo, open } = await fixture(t);
	await assert.rejects(
		open(async () => {
			throw new Error("Open failed");
		}),
		/Open failed/,
	);
	const session = await repo.create({}, context);
	t.mock.method(session, "mutate", async () => {
		throw new Error("Read failed");
	});
	const close = t.mock.method(session, "close", session.close.bind(session));
	await assert.rejects(
		open(async () => session),
		/Read failed/,
	);
	assert.equal(close.mock.callCount(), 1);
	const next = FlowOwnership.acquire(root, scope);
	await next.close();
});

test("closing one branch leaves another branch's pending receipts intact", async (t) => {
	const { open } = await fixture(t);
	const first = await open();
	const other = await open(undefined, { ...scope, branchId: "other" });
	await other.ledger.select("attempt", [member]);
	await first.close();
	assert.equal((await other.ledger.snapshot()).activeAttemptId, "attempt");
	await other.ledger.cancel("attempt", "User cancelled");
});

test("process death releases attachment ownership and reconciles durable handoff as uncertain", {
	timeout: 15000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-flow-owned-kill-"));
	let attachment;
	let repo;
	const child = fork(new URL("./fixtures/flow-attachment-crash.mjs", import.meta.url), [root], {
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const ended = once(child, "exit");
			child.kill("SIGKILL");
			await ended;
		}
		await attachment?.close();
		await repo?.close(context);
		await rm(root, { recursive: true, force: true });
	});
	let stderr = "";
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	const { metadata } = await new Promise((resolve, reject) => {
		child.once("message", resolve);
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`Attachment fixture exited ${code}: ${stderr}`)));
	});
	await assert.rejects(
		PiFlowAttachment.open(root, scope, () => assert.fail("Second writer opened")),
		{ code: "busy" },
	);
	const ended = once(child, "exit");
	child.kill("SIGKILL");
	await ended;
	const reopen = async (directory) => {
		repo = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: directory }), sessionsRoot: directory });
		return repo.open(metadata, context);
	};
	attachment = await PiFlowAttachment.open(root, scope, reopen);
	const state = await attachment.ledger.snapshot();
	assert.equal(state.generation, 2);
	assert.equal(state.activeAttemptId, undefined);
	assert.equal(state.attempts[0].phase, "uncertain");
	assert.equal(state.attempts[0].requests[0].handedOff, true);
	assert.deepEqual(state.attempts[0].members, [member]);
	await attachment.close();
	await repo.close(context);
	attachment = await PiFlowAttachment.open(root, scope, reopen);
	assert.equal((await attachment.ledger.snapshot()).attempts[0].phase, "uncertain");
});
