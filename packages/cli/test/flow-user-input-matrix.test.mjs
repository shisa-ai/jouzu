import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { FlowOwnership } from "../dist/flow-control/ownership.js";
import { FlowSubmissionStore } from "../dist/flow-control/submission-store.js";
import { UserInputAdapters } from "../dist/flow-control/user-input-adapters.js";
import { SessionManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { afterCleanup } from "./fixtures/cleanup.mjs";
import { declareIngressWait, fixture, ingressWaitClock } from "./fixtures/flow-session-ingress.mjs";
import { BACKGROUND_CONTEXT, MemorySessionRepo } from "./fixtures/flow-storage.mjs";

/** Bounded wait for a state the host reaches asynchronously, with the expectation in the failure. */
async function until(predicate, message) {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(message);
}

/**
 * Real patched host with one authorized adapter.
 *
 * The sibling adapter suite owns the lifecycle regressions (suspension, reload, restart, archived
 * reopen). This file exercises the remaining matrix clauses through the same public adapter API, so
 * the setup stays deliberately small and independent of that file's internals.
 */
async function setup(t, options = {}) {
	const agentDir = await mkdtemp(join(tmpdir(), "jouzu-user-input-matrix-"));
	afterCleanup(t, () => rm(agentDir, { recursive: true, force: true }));
	const path = join(agentDir, "extension.ts");
	await writeFile(path, "export default () => {};\n");
	const extensionId = await realpath(path);
	await writeFile(
		join(agentDir, "user-input-adapters.json"),
		JSON.stringify({ schemaVersion: 1, grants: [{ extensionPath: extensionId, adapterId: "fixture" }] }),
	);
	const f = await fixture(t, { agentDir, ...options });
	const adapter = await f.session._flowBinding.registerUserInputAdapter(extensionId, {
		id: "fixture",
		label: "Fixture",
	});
	const binding = await adapter.bind();
	return { ...f, adapter, binding, agentDir, extensionId };
}

const input = (f, messageId = "one", text = "external instruction", deliverAs = "followUp") => ({
	binding: f.binding,
	messageId,
	text,
	deliverAs,
});
const lookup = (f, messageId) => f.adapter.lookup({ target: f.binding.target, messageId });
const externalRecords = async (f) =>
	(await f.ingress.branch().attachment.submissions.snapshot()).filter((record) => record.submission.externalUser);

/**
 * Adapter-boundary harness: a real submission store and the real adapter registry, without a host
 * session. It exists for receipt isolation and reset identity, which the adapter decides before any
 * native dispatch.
 */
async function adapterHarness(t) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-user-input-adapters-"));
	const agentDir = await mkdtemp(join(tmpdir(), "jouzu-user-input-adapters-config-"));
	const scope = { sessionId: "adapter-isolation", branchId: "main" };
	const owner = FlowOwnership.acquire(root, scope);
	const repo = new MemorySessionRepo();
	const session = await repo.create({}, BACKGROUND_CONTEXT);
	const store = await FlowSubmissionStore.attach(session, owner);
	const branch = { scope, attachment: { submissions: store } };
	const errors = [];
	let adapters;
	afterCleanup(t, async () => {
		adapters?.close();
		await owner.close(() => session.close(BACKGROUND_CONTEXT));
		await repo.close(BACKGROUND_CONTEXT);
		await rm(root, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	});
	const extensionPath = join(agentDir, "extension.ts");
	await writeFile(extensionPath, "export default () => {};\n");
	const extensionId = await realpath(extensionPath);
	await writeFile(
		join(agentDir, "user-input-adapters.json"),
		JSON.stringify({
			schemaVersion: 1,
			grants: [
				{ extensionPath: extensionId, adapterId: "first" },
				{ extensionPath: extensionId, adapterId: "second" },
			],
		}),
	);
	adapters = new UserInputAdapters({
		agentDir,
		branch: () => branch,
		enabled: () => true,
		liveQueue: () => new Map(),
		pending: () => false,
		retain: (submission, digest, epoch) => store.retainExternal(submission, digest, epoch),
		onError: (error) => errors.push(error),
	});
	const host = {
		extensionId,
		scope: () => ({ sessionId: scope.sessionId, leafId: null, attachmentId: "attachment" }),
		prepare: () => async () => {},
	};
	return { store, errors, register: (id, label) => adapters.register(host, { id, label }) };
}

test("external provenance is refused by the ordinary ingress path", async (t) => {
	const f = await setup(t);
	const scope = f.ingress.branch().scope;
	const submission = {
		version: 1,
		id: "forged-external",
		api: "prompt",
		origin: { kind: "extension", id: f.extensionId },
		scope: { sessionId: scope.sessionId, leafId: null, attachmentId: "forged" },
		externalUser: { version: 1, adapterId: "fixture", messageId: "forged" },
		args: ["forged external"],
	};
	let dispatched = 0;
	await assert.rejects(
		f.ingress.submit(submission, async () => {
			dispatched++;
		}),
		{ code: "unauthorized" },
	);
	// The refusal happens before retention: no record, no callback, no model request.
	assert.deepEqual(await externalRecords(f), []);
	assert.equal(dispatched, 0);
	assert.equal(f.sent.length, 0);
	// The same shape without external provenance is ordinary ingress input, not a rejected one.
	await f.ingress.submit(
		{ ...submission, id: "ordinary", origin: { kind: "host", id: "prompt" }, externalUser: undefined, args: ["typed"] },
		async () => {
			dispatched++;
		},
	);
	assert.equal(dispatched, 1);
});

test("host retry and compaction hold external input until the boundary clears", async (t) => {
	for (const state of ["isRetrying", "isCompacting"]) {
		const f = await setup(t, { admit: null });
		// The host getters read private turn state. Shadowing them with an own property keeps the
		// real ingress and the real admission decision while the boundary is deterministic.
		Object.defineProperty(f.session, state, { configurable: true, value: true });
		try {
			const held = await f.adapter.submit(input(f));
			assert.equal(held.state, "held", `${state} admitted external input`);
			assert.equal(f.sent.length, 0);
			const [record] = await externalRecords(f);
			assert.equal(record.holds.at(-1).reason, "Input is waiting for host retry or compaction.");
			delete f.session[state];
			await f.ingress.releaseReady();
			await f.ingress.joinPendingOperations();
			assert.equal((await lookup(f, "one")).state, "consumed");
			assert.equal(f.sent.length, 1);
		} finally {
			delete f.session[state];
			await f.ingress.dispose();
		}
	}
});

test("queued external input composes the wait context for its request", async (t) => {
	const entered = deferred(),
		proceed = deferred(),
		errors = [];
	let first = true;
	const f = await setup(t, {
		provider: true,
		admit: null,
		autoRelease: { clock: ingressWaitClock(), onError: (error) => errors.push(error) },
		onRequest: async () => {
			if (!first) return;
			first = false;
			entered.resolve();
			await proceed.promise;
		},
	});
	const turn = f.session.prompt("hold the turn open");
	await entered.promise;
	// A live wait is what makes the wait context carry content. External input still outranks it,
	// because it is the user speaking rather than unclassified automated work.
	await declareIngressWait(f.ingress.branch());
	await f.adapter.submit(input(f, "waited", "steer into the busy turn", "steer"));
	await until(
		async () => (await lookup(f, "waited")).state === "queued",
		"the external steer was never observed in the native queue",
	);
	proceed.resolve();
	await turn;
	await until(() => f.sent.length === 2, "the queued external steer was never claimed into a request");
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "waited")).state, "consumed");
	const second = JSON.stringify(f.sent[1]);
	assert.match(second, /steer into the busy turn/);
	// The composed context follows the queued message in the same request, so the model reads the
	// steer with the live wait snapshot rather than a stale one.
	const steerAt = second.indexOf("steer into the busy turn");
	const contextAt = second.indexOf("capturedAt");
	assert.ok(contextAt > steerAt, "the queued external request carries the composed wait context");
	assert.match(second, /liveWaits/);
	assert.deepEqual(errors, []);
});

test("an interrupt pause holds automated work while external input is admitted", async (t) => {
	const f = await setup(t, { provider: true, admit: null });
	f.ingress.pauseAutomated("explicit user pause");
	await f.session.sendUserMessage("automated continuation");
	assert.equal(f.sent.length, 0, "the pause did not hold the automated send");
	await f.adapter.submit(input(f));
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "one")).state, "consumed");
	// The user's request runs first and alone; admitting it clears the pause, so the held automated
	// send takes a later boundary instead of joining or preceding the user's turn.
	assert.match(JSON.stringify(f.sent[0]), /external instruction/);
	assert.ok(!JSON.stringify(f.sent[0]).includes("automated continuation"));
	await until(() => f.sent.length === 2, "the held automated send did not resume after the pause");
	assert.match(JSON.stringify(f.sent[1]), /automated continuation/);
});

test("aborting a turn leaves a queued external message unconfirmed, not consumed", async (t) => {
	const gate = deferred();
	const f = await setup(t, { provider: true, admit: null, onRequest: async () => gate.promise });
	const turn = f.session.prompt("keep running").catch(() => {});
	await until(() => f.sent.length === 1, "native turn did not start");
	await f.adapter.submit(input(f, "aborted", "queued then dropped", "followUp"));
	await until(
		async () => (await lookup(f, "aborted")).state === "queued",
		"the external input was never observed in the native queue",
	);
	// The abort path signals the turn and discards what the user had queued, which is what the
	// interactive host does with clearQueue. The fake provider ignores the abort signal, so unblock
	// it before awaiting the abort.
	const aborting = f.session.abort();
	gate.resolve();
	await aborting;
	await turn;
	f.session.clearQueue();
	await until(
		async () => (await lookup(f, "aborted")).state === "unknown",
		"the aborted queue entry never left its queued receipt",
	);
	const receipt = await lookup(f, "aborted");
	// The host dropped the queue entry instead of taking it, so the receipt must not claim delivery.
	assert.equal(receipt.reason.code, "queue-evidence-missing");
	assert.equal(f.sent.length, 1, "the dropped queue entry was dispatched again");
});

for (const mode of ["one-at-a-time", "all"]) {
	test(`slash text and template names stay literal external input: ${mode}`, async (t) => {
		const gate = deferred();
		const f = await setup(t, { provider: true, admit: null, onRequest: () => gate.promise });
		f.session.agent.followUpMode = mode;
		// The typed control must expand a real template, while external input stays literal.
		const sessionRoot = f.session.sessionManager.getCwd();
		await mkdir(join(sessionRoot, "prompts"), { recursive: true });
		await writeFile(join(sessionRoot, "prompts", "echo.md"), "---\ndescription: echo fixture\n---\nEXPANDED $@\n");
		await f.session.resourceLoader.reload();
		assert.ok(f.session.promptTemplates.some((template) => template.name === "echo"));
		const literal = ["/flow", "/flow details", "/flow reset confirm", "/about", "/goal", "/echo hello"];
		try {
			for (const [index, text] of literal.entries()) await f.adapter.submit(input(f, `literal-${index}`, text));
			await until(
				() => f.session.agent.inspectQueuedMessages().length === literal.length - 1,
				"the follow-up inputs were not queued behind the blocked provider",
			);
		} finally {
			gate.resolve();
		}
		await f.ingress.joinPendingOperations();
		// Several native inputs may share a provider request. Check exact user text, not a
		// one-request-per-submission index or substrings such as /flow inside /flow details.
		const texts = f.sent
			.flat()
			.filter((message) => message.role === "user")
			.flatMap((message) =>
				typeof message.content === "string"
					? [message.content]
					: message.content.filter((part) => part.type === "text").map((part) => part.text),
			);
		for (const [index, text] of literal.entries()) {
			assert.equal((await lookup(f, `literal-${index}`)).state, "consumed", `${text} was not consumed`);
			assert.ok(texts.includes(text), `${text} did not reach the model literally`);
		}
		assert.equal(JSON.stringify(f.sent).includes("EXPANDED"), false, "External input expanded a prompt template");
		assert.equal(f.sent.length, mode === "all" ? 2 : literal.length);
		await f.session.prompt("/echo hello");
		assert.match(JSON.stringify(f.sent.at(-1)), /EXPANDED hello/);
		// Literal `/flow reset confirm` did not reset the journal.
		assert.equal((await externalRecords(f)).length, literal.length);
	});
}

test("a forked session cannot reuse the source adapter binding", async (t) => {
	const source = await setup(t);
	await source.session.prompt("source history");
	const sourcePath = source.session.sessionManager.getSessionFile();
	const targetCwd = await mkdtemp(join(tmpdir(), "jouzu-user-input-fork-"));
	afterCleanup(t, () => rm(targetCwd, { recursive: true, force: true }));
	const manager = SessionManager.forkFrom(sourcePath, targetCwd, join(targetCwd, "history"));
	const forked = await fixture(t, { agentDir: source.agentDir, manager });
	const adapter = await forked.session._flowBinding.registerUserInputAdapter(source.extensionId, {
		id: "fixture",
		label: "Fixture",
	});
	const binding = await adapter.bind();
	assert.notEqual(binding.target, source.binding.target);
	// The copied transcript is not a new target: the source binding is stale in the fork.
	await assert.rejects(adapter.submit({ ...input({ ...forked, binding }, "forked"), binding: source.binding }), {
		code: "stale-target",
	});
	await assert.rejects(adapter.lookup({ target: source.binding.target, messageId: "forked" }), {
		code: "target-unavailable",
	});
	await adapter.submit(input({ ...forked, binding }, "forked"));
	await forked.ingress.joinPendingOperations();
	assert.equal((await adapter.lookup({ target: binding.target, messageId: "forked" })).state, "consumed");
	assert.equal(forked.sent.length, 1);
});

test("a competing attachment owner cannot take a retained external input", async (t) => {
	let allow = false;
	const f = await setup(t, { admit: async () => allow });
	assert.equal((await f.adapter.submit(input(f))).state, "held");
	const branch = f.ingress.branch();
	// A second attachment on the same branch is refused ownership outright; it cannot dispatch,
	// reattach, or overwrite the record the first owner holds.
	assert.throws(() => FlowOwnership.acquire(f.root, branch.scope), { code: "busy" });
	const [record] = await externalRecords(f);
	assert.equal(record.status, "retained");
	allow = true;
	await f.ingress.releaseReady();
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "one")).state, "consumed");
	assert.equal(f.sent.length, 1);
});

test("archiving pending external input keeps its receipt and dispatch", async (t) => {
	let allow = false;
	const f = await setup(t, { admit: async () => allow });
	assert.equal((await f.adapter.submit(input(f))).state, "held");
	const store = f.ingress.branch().attachment.submissions;
	// Pending input is not handled work, so a completion sweep must leave it dispatchable.
	assert.equal(await store.archiveCompleted(), 0);
	assert.equal((await externalRecords(f)).length, 1);
	assert.equal((await lookup(f, "one")).state, "held");
	allow = true;
	await f.ingress.releaseReady();
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "one")).state, "consumed");
	assert.equal(f.sent.length, 1);
});

test("archiving pending queued external input keeps it queued", async (t) => {
	const gate = deferred();
	t.after(() => gate.resolve());
	const f = await setup(t, { provider: true, onRequest: async () => gate.promise });
	const turn = f.session.prompt("keep running");
	await until(() => f.sent.length === 1, "native turn did not start");
	await f.adapter.submit(input(f));
	await until(
		async () => (await lookup(f, "one")).state === "queued",
		"the external input was never observed in the native queue",
	);
	assert.equal(await f.ingress.branch().attachment.submissions.archiveCompleted(), 0);
	assert.equal((await lookup(f, "one")).state, "queued");
	gate.resolve();
	await turn;
	await f.ingress.joinPendingOperations();
	assert.equal((await lookup(f, "one")).state, "consumed");
	assert.equal(f.sent.length, 2);
});

test("a failed external dispatch leaves no unhandled rejection", async (t) => {
	const unhandled = [];
	const listener = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", listener);
	t.after(() => process.off("unhandledRejection", listener));
	const errors = [];
	const f = await setup(t, {
		provider: true,
		response: () => new Response("unavailable", { status: 503 }),
		autoRelease: { onError: (error) => errors.push(error) },
	});
	await f.adapter.submit(input(f));
	await f.ingress.joinPendingOperations();
	// Native delivery is already consumed; only the model turn failed, and the ingress owns that
	// rejection rather than leaving it to the process.
	assert.equal((await lookup(f, "one")).state, "consumed");
	assert.equal(f.sent.length, 1);
	assert.equal(await f.adapter.submit(input(f)).then((receipt) => receipt.state), "consumed");
	await f.ingress.joinPendingOperations();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.deepEqual(unhandled, []);
	assert.equal(f.sent.length, 1);
});

/**
 * Per-adapter receipt isolation at the adapter boundary, without a host session.
 *
 * The store keys an external record by target, extension identity, adapter ID, and message ID, and
 * the adapter filters both lookup and subscriptions on its own provenance. Two adapters registered
 * by one extension therefore cannot observe or overwrite each other's message IDs.
 */
test("per-adapter receipts stay isolated by adapter identity", async (t) => {
	const h = await adapterHarness(t);
	const first = await h.register("first", "First");
	const second = await h.register("second", "Second");
	const firstBinding = await first.bind(),
		secondBinding = await second.bind();
	assert.equal(firstBinding.target, secondBinding.target);
	const seen = [];
	const unsubscribe = first.subscribe((receipt) => seen.push(receipt));
	afterCleanup(t, unsubscribe);
	// The same message ID from two adapters is two messages, not a conflict.
	await first.submit({ binding: firstBinding, messageId: "shared", text: "first text", deliverAs: "followUp" });
	await second.submit({ binding: secondBinding, messageId: "shared", text: "second text", deliverAs: "followUp" });
	await second.submit({ binding: secondBinding, messageId: "second-only", text: "only second", deliverAs: "followUp" });
	const records = await h.store.snapshot(false);
	assert.equal(records.length, 3);
	const firstReceipt = await first.lookup({ target: firstBinding.target, messageId: "shared" });
	const secondReceipt = await second.lookup({ target: secondBinding.target, messageId: "shared" });
	assert.equal(firstReceipt.adapterId, "first");
	assert.equal(secondReceipt.adapterId, "second");
	assert.notEqual(
		records.find((record) => record.submission.externalUser.adapterId === "first").id,
		records.find((record) => record.submission.externalUser.adapterId === "second").id,
	);
	// A message ID only the second adapter used does not resolve for the first.
	assert.equal(await first.lookup({ target: firstBinding.target, messageId: "second-only" }), undefined);
	await until(() => seen.some((receipt) => receipt.messageId === "shared"), "the first adapter saw no snapshot");
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(seen.every((receipt) => receipt.adapterId === "first"));
	assert.equal(
		seen.some((receipt) => receipt.messageId === "second-only"),
		false,
		"the first adapter observed the second adapter's receipt",
	);
	assert.deepEqual(h.errors, []);
	unsubscribe();
});

test("reset mints a new external target and cannot reuse the old message identity", async (t) => {
	const h = await adapterHarness(t);
	const adapter = await h.register("first", "First");
	const binding = await adapter.bind();
	await adapter.submit({ binding, messageId: "shared", text: "before reset", deliverAs: "followUp" });
	const [before] = await h.store.snapshot(false);
	assert.equal((await adapter.lookup({ target: binding.target, messageId: "shared" })).state, "retained");
	await h.store.reset();
	// The old target no longer names anything: its lookup is unavailable and its binding is stale.
	await assert.rejects(adapter.lookup({ target: binding.target, messageId: "shared" }), {
		code: "target-unavailable",
	});
	await assert.rejects(adapter.submit({ binding, messageId: "shared", text: "before reset", deliverAs: "followUp" }), {
		code: "stale-target",
	});
	const rebound = await adapter.bind();
	assert.notEqual(rebound.target, binding.target);
	// The same message ID under the new target is a new message, not the erased one.
	assert.equal(
		(await adapter.submit({ binding: rebound, messageId: "shared", text: "before reset", deliverAs: "followUp" }))
			.state,
		"retained",
	);
	const records = await h.store.snapshot(false);
	assert.equal(records.length, 1);
	assert.notEqual(records[0].id, before.id);
	assert.equal(records[0].submission.externalUser.messageId, "shared");
	assert.deepEqual(h.errors, []);
});

test("clearing the native queue delivers a strictly newer uncertain receipt", async (t) => {
	const gate = deferred();
	t.after(() => gate.resolve());
	const f = await setup(t, { provider: true, admit: null, onRequest: async () => gate.promise });
	const seen = [];
	const stop = f.adapter.subscribe((receipt) => {
		if (receipt.messageId === "cleared") seen.push(receipt);
	});
	t.after(stop);
	const turn = f.session.prompt("keep running");
	await until(() => f.sent.length === 1, "native turn did not start");
	await f.adapter.submit(input(f, "cleared", "queued then cleared", "followUp"));
	await until(async () => (await lookup(f, "cleared")).state === "queued", "the input was never queued");
	await until(() => seen.some((receipt) => receipt.state === "queued"), "the queued receipt was never published");
	const queued = seen.filter((receipt) => receipt.state === "queued").at(-1);
	// The host drops the entry without a claim. No unrelated journal write follows, so the removal
	// itself has to advance the revision the sender already accepted.
	f.session.clearQueue();
	await until(
		() => seen.some((receipt) => receipt.state === "unknown" && receipt.revision > queued.revision),
		"the removal never reached the subscription",
	);
	const cleared = seen.find((receipt) => receipt.state === "unknown" && receipt.revision > queued.revision);
	assert.equal(cleared.state, "unknown");
	assert.equal(cleared.reason.code, "queue-evidence-missing");
	assert.ok(cleared.revision > queued.revision, "the removal receipt did not advance the journal revision");
	assert.equal(cleared.generation, queued.generation);
	assert.equal((await lookup(f, "cleared")).revision, cleared.revision);
	assert.equal(f.sent.length, 1, "the cleared entry was dispatched again");
	gate.resolve();
	await turn;
});

test("a capacity refusal preserves an existing ID's duplicate and lookup", async (t) => {
	const h = await adapterHarness(t);
	const adapter = await h.register("first", "First");
	const binding = await adapter.bind();
	const submit = (messageId, text) => adapter.submit({ binding, messageId, text, deliverAs: "followUp" });
	assert.equal((await submit("kept", "kept text")).state, "retained");
	// Refuse the next new record where the lifetime budget refuses it: inside the retention transaction.
	const retain = h.store.retainExternal.bind(h.store);
	t.mock.method(h.store, "retainExternal", async (submission, digest, epoch) => {
		if (submission.externalUser.messageId === "overflow")
			throw Object.assign(new Error("External input lifetime capacity reached."), { code: "capacity" });
		return retain(submission, digest, epoch);
	});
	await assert.rejects(submit("overflow", "overflow text"), { code: "capacity" });
	// The refused ID left no record, and the existing record still answers duplicate and lookup.
	assert.equal(await adapter.lookup({ target: binding.target, messageId: "overflow" }), undefined);
	assert.equal((await submit("kept", "kept text")).state, "retained");
	assert.equal((await adapter.lookup({ target: binding.target, messageId: "kept" })).state, "retained");
});

test("a queue admission hold for an entry the host discarded stops reporting held", async (t) => {
	const gate = deferred();
	const f = await setup(t, {
		provider: true,
		admit: async (_submission, _branch, phase) => phase !== "queue",
		onRequest: async () => gate.promise,
	});
	const turn = f.session.prompt("keep running").catch(() => {});
	await until(() => f.sent.length === 1, "native turn did not start");
	await f.adapter.submit(input(f, "dropped", "queued then discarded", "followUp"));
	await until(
		async () => (await lookup(f, "dropped")).state === "queued",
		"the external input was never observed in the native queue",
	);
	// Finishing the request is what offers the queued entry for its claim, and admission refuses it.
	gate.resolve();
	await turn;
	await until(async () => (await lookup(f, "dropped")).state === "held", "the queue claim was never refused");
	const [held] = await externalRecords(f);
	assert.equal(held.holds.at(-1).phase, "queue");
	assert.deepEqual(
		(await f.ingress.heldInputs()).map((item) => item.id),
		[held.id],
	);
	// The host discards the queued entry without a claim, as the interactive abort path does. No later
	// admission runs for it, so the hold can never clear and must not outlive the entry it describes.
	f.session.clearQueue();
	await until(
		async () => (await lookup(f, "dropped")).state === "unknown",
		"the discarded queue entry still reports an admission hold",
	);
	assert.equal((await lookup(f, "dropped")).reason.code, "queue-evidence-missing");
	assert.deepEqual(await f.ingress.heldInputs(), []);
});
