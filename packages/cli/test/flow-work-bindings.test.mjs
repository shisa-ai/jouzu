import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, setValue, value } from "@earendil-works/pi-agent-core";
import { openLocalFlowSession } from "../dist/flow-control/local-storage.js";
import { multiloopWorkBinding } from "../dist/flow-control/multiloop-producer.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";

const scope = { sessionId: "session", branchId: "branch" };
const address = value("jouzu.flow.waits", "v1");

/** Open the attachment under `root`, rewriting the persisted wait state from `seed` first. */
async function openSeeded(root, seed) {
	return PiFlowAttachment.open(root, scope, async (directory) => {
		const session = await openLocalFlowSession(directory);
		if (seed)
			await session.mutate(
				async (writer, context) => writer.commit([setValue(address, seed())], context),
				BACKGROUND_CONTEXT,
			);
		return session;
	});
}

async function fixture(t, seed) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-work-bindings-"));
	t.after(async () => {
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});
	let attachment = await openSeeded(root, seed);
	t.after(async () => {
		await attachment?.close().catch(() => undefined);
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});
	return {
		root,
		get store() {
			return attachment.waits;
		},
		/** Close the current attachment and reopen with a fresh persisted seed. */
		async reseed(seed) {
			await attachment.close().catch(() => undefined);
			attachment = await openSeeded(root, seed);
			return attachment;
		},
		/** Reopen, capturing the persisted bytes before the store reads them. */
		async reopen(inspect) {
			await attachment.close();
			let persisted;
			attachment = await PiFlowAttachment.open(root, scope, async (directory) => {
				const session = await openLocalFlowSession(directory);
				persisted = structuredClone(
					await session.mutate(
						async (reader) => (await reader.getValue(address, BACKGROUND_CONTEXT))?.value,
						BACKGROUND_CONTEXT,
					),
				);
				inspect?.(persisted);
				return session;
			});
			return persisted;
		},
	};
}

test("a second producer's owner-scoped binding holds one live generation per key", async (t) => {
	const f = await fixture(t),
		sweep = { producer: "sweep", key: ["nightly", "report"] };
	const first = await f.store.activateWorkBinding(sweep, 1, ["bg", "bg", "sweep"]);
	assert.equal(first.owner, "sweep");
	assert.deepEqual(first.participants, ["sweep", "bg"], "duplicate and owner participants are ignored");
	assert.deepEqual(first.binding, sweep);
	assert.match(first.id, /^sweep-work:/);
	assert.deepEqual(await f.store.activateWorkBinding(sweep, 2, ["bg"]), first);
	// The same key parts under another producer name a different campaign.
	const loop = await f.store.activateWorkBinding(multiloopWorkBinding({ lane: "nightly", runTag: "report" }), 3, [
		"bg",
	]);
	assert.notEqual(loop.id, first.id);
	assert.equal(f.store.boundWork(sweep).id, first.id);
	assert.equal(f.store.boundWork(multiloopWorkBinding({ lane: "nightly", runTag: "report" })).id, loop.id);
	// A paused generation resumes in place across a reopen instead of starting a new one.
	await f.store.changeWork(first.id, first.owner, first.revision, "paused", "operator hold", 4);
	await f.reopen();
	assert.equal(f.store.boundWork(sweep).lifecycle.state, "paused");
	const resumed = await f.store.activateWorkBinding(sweep, 5);
	assert.equal(resumed.id, first.id);
	assert.equal(resumed.revision, 3);
	assert.equal(resumed.lifecycle.state, "active");
	// Stopped work is never revived; the next activation is a new generation with a new identity.
	await f.store.changeWork(resumed.id, resumed.owner, resumed.revision, "stopped", "operator stop", 6);
	assert.equal(f.store.boundWork(sweep), undefined);
	const next = await f.store.activateWorkBinding(sweep, 7, ["bg"]);
	assert.notEqual(next.id, first.id);
	assert.match(next.id, /^sweep-work:/);
	const authority = await f.store.authoritySnapshot();
	assert.equal(authority.work.length, 3);
	assert.equal(authority.work.find((work) => work.id === resumed.id).lifecycle.state, "stopped");
	assert.equal(f.store.boundWork(sweep).id, next.id);
});

test("invalid bindings and participants are rejected without committing work", async (t) => {
	const f = await fixture(t);
	for (const binding of [
		{ producer: "", key: ["scan"] },
		{ key: ["scan"] },
		{ producer: "sweep", key: [] },
		{ producer: "sweep", key: ["scan", ""] },
		{ producer: "sweep", key: ["scan", "x".repeat(513)] },
		{ producer: "sweep", key: Array.from({ length: 9 }, () => "scan") },
	])
		await assert.rejects(f.store.activateWorkBinding(binding, 1), { code: "schema" });
	assert.throws(() => f.store.boundWork({ producer: "sweep", key: [] }), { code: "schema" });
	assert.deepEqual((await f.store.authoritySnapshot()).work, []);
	await assert.rejects(f.store.activateWorkBinding({ producer: "sweep", key: ["scan"] }, 1, [""]), {
		code: "identity",
	});
	assert.deepEqual((await f.store.authoritySnapshot()).work, []);
});

test("persisted duplicate live bindings and foreign owner identity fail closed on open", async (t) => {
	const f = await fixture(t),
		work = (overrides = {}) => ({
			id: "sweep-work:1",
			owner: "sweep",
			participants: ["sweep"],
			revision: 1,
			createdAt: 1,
			binding: { producer: "sweep", key: ["scan"] },
			...overrides,
		}),
		state = (works) => () => ({
			version: 1,
			scope,
			waits: [],
			authority: { version: 1, work: works, executions: [], waitTokens: [] },
		});
	await assert.rejects(f.reseed(state([work(), work({ id: "sweep-work:2" })])), {
		code: "identity",
		message: /multiple live campaigns/,
	});
	await assert.rejects(f.reseed(state([work({ binding: { producer: "multiloop", key: ["scan"] } })])), {
		code: "identity",
		message: /Invalid work ownership record/,
	});
	// A retired generation frees its binding, so a successor record set reopens.
	await f.reseed(
		state([work({ lifecycle: { state: "stopped", changedAt: 2, reason: "done" } }), work({ id: "sweep-work:2" })]),
	);
	assert.equal(f.store.boundWork({ producer: "sweep", key: ["scan"] }).id, "sweep-work:2");
});

const legacyHandle = { producer: "multiloop", handle: "job", execution: "exec-legacy", until: "exit" };
const legacyState = () => ({
	version: 1,
	scope,
	waits: [
		{
			version: 1,
			token: "legacy-wait",
			scope,
			workId: "multiloop-work:legacy",
			reason: "sweep exit",
			mode: "all",
			on: [legacyHandle],
			createdAt: 12,
			expiresAt: 5000,
			state: "waiting",
			unmet: [legacyHandle],
			observations: [{ ...legacyHandle, scope, workId: "multiloop-work:legacy", state: "pending" }],
		},
	],
	authority: {
		version: 1,
		work: [
			{
				id: "multiloop-work:legacy",
				owner: "multiloop",
				participants: ["multiloop", "bg"],
				revision: 4,
				createdAt: 10,
				multiloop: { lane: "sweep", runTag: "run-7" },
				lifecycle: { state: "active", changedAt: 12, reason: "campaign started" },
			},
		],
		executions: [
			{
				producer: "multiloop",
				handle: "job",
				execution: "exec-legacy",
				workId: "multiloop-work:legacy",
				revision: 2,
				observedAt: 11,
				predicates: [{ until: "exit", state: "pending" }],
			},
		],
		waitTokens: ["legacy-wait"],
	},
});

test("persisted lane records reopen as owner-scoped bindings with their original identity", async (t) => {
	const f = await fixture(t, legacyState),
		lane = { lane: "sweep", runTag: "run-7" };
	// The migrated campaign keeps its work identity, revision, participants, and wait.
	const migrated = f.store.boundWork(multiloopWorkBinding(lane));
	assert.equal(migrated.id, "multiloop-work:legacy");
	assert.equal(migrated.revision, 4);
	assert.deepEqual(migrated.participants, ["multiloop", "bg"]);
	assert.deepEqual(migrated.binding, { producer: "multiloop", key: ["sweep", "run-7"] });
	assert.equal("multiloop" in migrated, false);
	const [wait] = await f.store.snapshot();
	assert.equal(wait.token, "legacy-wait");
	assert.equal(wait.expiresAt, 5000, "the original deadline is preserved, not restarted");
	assert.equal(wait.workId, "multiloop-work:legacy");
	assert.equal(wait.state, "waiting");
	assert.deepEqual(f.store.gate().waitingWorkIds, ["multiloop-work:legacy"]);
	// Activating the migrated lane continues the existing generation instead of duplicating it.
	assert.deepEqual(await f.store.activateWorkBinding(multiloopWorkBinding(lane), 100, ["bg"]), migrated);
	assert.equal((await f.store.authoritySnapshot()).work.length, 1);
	// The rewrite is durable and idempotent.
	const persisted = await f.reopen();
	assert.deepEqual(persisted.authority.work[0].binding, { producer: "multiloop", key: ["sweep", "run-7"] });
	assert.equal("multiloop" in persisted.authority.work[0], false);
	assert.equal(f.store.boundWork(multiloopWorkBinding(lane)).id, "multiloop-work:legacy");
	// Stopping the migrated campaign still starts a fresh generation on the next activation.
	const stopped = await f.store.changeWork("multiloop-work:legacy", "multiloop", 4, "stopped", "operator stop", 200);
	assert.equal(f.store.boundWork(multiloopWorkBinding(lane)), undefined);
	const cancelled = (await f.store.snapshot())[0];
	assert.equal(cancelled.state, "cancelled");
	assert.equal(cancelled.cancellationReason, "operator stop");
	assert.equal(cancelled.expiresAt, 5000);
	const next = await f.store.activateWorkBinding(multiloopWorkBinding(lane), 300, ["bg"]);
	assert.notEqual(next.id, "multiloop-work:legacy");
	assert.deepEqual(next.participants, ["multiloop", "bg"]);
	assert.deepEqual(
		(await f.store.authoritySnapshot()).work.find((work) => work.id === "multiloop-work:legacy"),
		stopped,
	);
	assert.equal(f.store.boundWork(multiloopWorkBinding(lane)).id, next.id);
});

test("corrupt legacy lane records fail closed on open", async (t) => {
	const f = await fixture(t),
		state = (works) => () => ({
			version: 1,
			scope,
			waits: [],
			authority: { version: 1, work: works, executions: [], waitTokens: [] },
		}),
		work = (overrides = {}) => ({
			id: "multiloop-work:1",
			owner: "multiloop",
			participants: ["multiloop"],
			revision: 1,
			createdAt: 1,
			multiloop: { lane: "sweep", runTag: "run-7" },
			...overrides,
		});
	await assert.rejects(f.reseed(state([work({ multiloop: null })])), { code: "schema" });
	await assert.rejects(f.reseed(state([work({ owner: "bg", id: "bg-work:1" })])), {
		code: "schema",
		message: /Invalid legacy multiloop lane record/,
	});
	await assert.rejects(f.reseed(state([work(), work({ id: "multiloop-work:2", participants: ["multiloop", "bg"] })])), {
		code: "identity",
		message: /multiple live campaigns/,
	});
});

test("mixed legacy and current bindings fail closed without rewriting persisted records", async (t) => {
	const f = await fixture(t);
	for (const binding of [
		{ producer: "foreign", key: ["other"] },
		{ producer: "multiloop", key: ["different", "campaign"] },
		{ producer: "multiloop", key: ["sweep", "run-7"] },
	]) {
		const seeded = legacyState();
		seeded.authority.work[0].binding = binding;
		await assert.rejects(
			f.reseed(() => structuredClone(seeded)),
			{ code: "schema" },
		);
		let persisted;
		await assert.rejects(
			f.reopen((state) => {
				persisted = state;
			}),
			{ code: "schema" },
		);
		assert.deepEqual(persisted, seeded, "rejected migration preserves both identities and the original wait");
	}
});

test("a legacy lane record with an unpaused hold still reports waiting work after migration", async (t) => {
	const f = await fixture(t, legacyState);
	await f.store.changeWork("multiloop-work:legacy", "multiloop", 4, "paused", "operator hold", 100);
	await f.reopen();
	const held = f.store.boundWork(multiloopWorkBinding({ lane: "sweep", runTag: "run-7" }));
	assert.equal(held.lifecycle.state, "paused");
	assert.deepEqual(f.store.gate().inactiveWorkIds, ["multiloop-work:legacy"]);
	// The held campaign still guards its wait: only its owner can start another execution.
	assert.throws(() => f.store.captureExecutionWork("multiloop-work:legacy", held.revision, "bg"), {
		code: "transition",
	});
	const resumed = await f.store.activateWorkBinding(multiloopWorkBinding({ lane: "sweep", runTag: "run-7" }), 200);
	assert.equal(resumed.id, held.id);
	assert.equal(resumed.lifecycle.state, "active");
});
