import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, setValue, value } from "@earendil-works/pi-agent-core";
import { openLocalFlowSession } from "../dist/flow-control/local-storage.js";
import {
	retirableEmptyNativeRequests,
	retirableNativeRequests,
	supersededNativeRequests,
} from "../dist/flow-control/native-request-retention.js";
import { MAX_RETIRED_NATIVE_REQUESTS } from "../dist/flow-control/native-request-store.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { retiredIdentityHash } from "../dist/flow-control/retired-identities.js";

const scope = { sessionId: "session", branchId: "branch" };
const hash = "a".repeat(64);
function input(id, operations = ["input"], model = "intact") {
	const members = operations.map((operationId, index) => ({
		index,
		operationId,
		messageHash: hash,
		prompt: { inputIndex: 0, messageIndex: 0 },
	}));
	const positions = members.map(({ index }) => ({ sourceIndex: index, status: "intact", index, messageHash: hash }));
	// The model-layer status is what decides delivery, so a record can be complete at conversion or
	// incomplete there independently of the context capture above.
	// The store rejects an unresolved member that still claims a converted position, so an
	// unresolved status carries neither.
	const converted = members.map(({ index }) =>
		model === "unresolved"
			? { sourceIndex: index, status: model }
			: { sourceIndex: index, status: model, index, messageHash: hash },
	);
	return {
		id,
		sourceHash: hash,
		transformedHash: hash,
		modelHash: hash,
		systemHash: hash,
		sourceCapture: {
			hash,
			count: members.length,
			members,
			context: { hash, count: members.length, members: structuredClone(positions) },
			model: { hash, count: members.length, members: converted },
		},
	};
}
const payload = (record, disposition = "included") => ({
	hash,
	bytes: 10000,
	api: "openai-completions",
	provider: "fixture",
	model: "fixture",
	sources: record.sourceCapture.members.map(({ index }) => ({
		sourceIndex: index,
		disposition,
		...(disposition === "included" ? { index, contentHash: hash } : {}),
	})),
});
const successful = (id, operations) => {
	const record = input(id, operations);
	return { ...record, ownerId: "owner", outcome: "success", payload: payload(record) };
};

test("request-boundary cleanup protects input, projections, waits, holds, and retry relationships", () => {
	const empty = (id) => successful(id, []);
	const records = [
		successful("input", ["live"]),
		{ ...empty("projection"), projectionCapture: { members: [{ index: 0 }] } },
		{ ...empty("wait"), waitTokens: ["live-wait"] },
		{ ...empty("required"), requiredSources: [0] },
		{ ...empty("required-projection"), requiredProjections: [0] },
		{ ...empty("cancelled"), cancelledSources: [0] },
		{ ...empty("cancelled-projection"), cancelledProjections: [0] },
		{ ...empty("pending"), outcome: undefined },
		{ ...empty("retry-parent"), outcome: "withheld", retryAuthorization: { requestId: "retry-child" } },
		{ ...empty("retry-child"), retryOf: "retry-parent" },
		...["success", "failure", "aborted", "withheld"].map((outcome) => ({ ...empty(outcome), outcome })),
		empty("latest"),
	];
	assert.deepEqual(retirableEmptyNativeRequests(records, 1), ["success", "failure", "aborted", "withheld"]);
});

test("request-boundary retirement archives empty history and preserves replay fences after reopen", async (t) => {
	const f = await fixture(t);
	await complete(f.store, "live", ["retained-input"]);
	for (let i = 0; i < 70; i++) await complete(f.store, `empty-${i}`, []);
	assert.equal(await f.store.retireBeforeRequest(), 6);
	assert.equal((await f.store.snapshot()).length, 65);
	assert.ok((await f.store.snapshot()).some((r) => r.id === "live"));
	await f.reopen();
	await assert.rejects(f.store.begin(input("empty-0", [])), { code: "stale" });
	await complete(f.store, "after-reopen", []);
	assert.equal(await f.store.retireBeforeRequest(), 1);
	assert.equal((await f.store.snapshot()).length, 65);
});
async function fixture(t, retiredCount = 0, reconciledCount = 0) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-request-retention-"));
	let storage;
	let attachment = await PiFlowAttachment.open(root, scope, async (directory) => {
		storage = await openLocalFlowSession(directory);
		if (retiredCount || reconciledCount)
			await storage.mutate(
				(writer, context) =>
					writer.commit(
						[
							setValue(value("jouzu.flow.native-requests", "v1"), {
								version: 1,
								scope,
								ids: [],
								retired: Array.from({ length: retiredCount }, (_, i) =>
									retiredIdentityHash("native-request", `old-${i}`),
								),
								reconciled: Array.from({ length: reconciledCount }, (_, i) => ({
									key: retiredIdentityHash("native-source", JSON.stringify([`source-${i}`, 0, 0, null, null])),
									reason: "compacted",
								})),
							}),
						],
						context,
					),
				BACKGROUND_CONTEXT,
			);
		return storage;
	});
	t.after(async () => {
		await attachment.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		get store() {
			return attachment.nativeRequests;
		},
		get storage() {
			return storage;
		},
		async reopen() {
			await attachment.close();
			attachment = await PiFlowAttachment.open(root, scope, async (directory) => {
				storage = await openLocalFlowSession(directory);
				return storage;
			});
		},
	};
}
async function complete(store, id, operations = ["input"], outcome = "success", model = "intact") {
	const record = input(id, operations, model);
	await store.begin(record);
	// A record whose model status is not accepted carries no wire inclusion either; the store rejects
	// that combination, so the payload receipt follows the model status.
	await store.handoff(id, payload(record, model === "intact" ? "included" : model));
	await store.finish(id, outcome);
}

test("retry-chain retirement preserves unresolved and protected members at every depth", () => {
	const parent = {
		...successful("parent"),
		outcome: "withheld",
		requiredSources: [0],
		retryAuthorization: { ownerId: "owner", requestId: "middle" },
	};
	const middle = {
		...successful("middle"),
		outcome: "withheld",
		requiredSources: [0],
		retryOf: "parent",
		retryAuthorization: { ownerId: "owner", requestId: "tail" },
	};
	const tail = { ...successful("tail"), retryOf: "middle" };
	const later = successful("later", ["unrelated"]);
	const chain = [parent, middle, tail, later];
	const select = (records, protectedIds = []) => retirableNativeRequests(records, 1, new Set(), new Set(protectedIds));
	assert.deepEqual(select(chain), ["parent", "middle", "tail"]);
	assert.deepEqual(
		select([{ ...parent, cancelledSources: [0] }, middle, tail, later]),
		[],
		"cancellation evidence remains available to context filtering",
	);
	assert.deepEqual(select([{ ...parent, cancelledProjections: [0] }, middle, tail, later]), [
		"parent",
		"middle",
		"tail",
	]);
	for (const id of ["parent", "middle", "tail"]) assert.deepEqual(select(chain, [id]), []);
	for (const outcome of [undefined, "withheld"]) {
		const held = { ...tail, outcome, requiredSources: [0] };
		assert.deepEqual(select([parent, middle, held, later]), []);
	}
	const incomplete = structuredClone(tail);
	incomplete.sourceCapture.model.members[0] = { sourceIndex: 0, status: "unresolved" };
	assert.deepEqual(select([parent, middle, incomplete, later]), []);
	assert.deepEqual(select([parent, middle, { ...tail, outcome: "failure" }, later]), ["parent", "middle", "tail"]);
	assert.deepEqual(select([parent, middle, later]), [], "a missing retry endpoint cannot split provenance");
	assert.deepEqual(select([parent, middle, { ...tail, outcome: undefined, reset: true }, later]), [
		"parent",
		"middle",
		"tail",
	]);
	assert.deepEqual(select([parent, middle, { ...tail, outcome: undefined, reset: true }, later], ["middle"]), []);
});

test("reset requests without outcomes retire without inventing a delivery result", async (t) => {
	const f = await fixture(t);
	const prepared = input("reset-prepared", ["prepared-source"]);
	await f.store.begin(prepared);
	assert.equal(await f.store.reset(), 1);
	const handedOff = input("reset-handed-off", ["handed-off-source"]);
	await f.store.begin(handedOff);
	await f.store.handoff(handedOff.id, payload(handedOff));
	assert.equal(await f.store.reset(), 1);
	await complete(f.store, "later", ["later-source"]);
	const before = await f.store.snapshot();
	assert.equal(await f.store.retireHistory(1, new Set(["prepared-source", "handed-off-source"])), 0);
	assert.equal(await f.store.retireHistory(1, new Set(), new Set([prepared.id, handedOff.id])), 0);
	await assert.rejects(
		f.store.retireHistory(1, new Set(), new Set(), () => {
			throw new Error("revoked");
		}),
		/revoked/,
	);
	assert.equal((await f.store.snapshot()).length, 3);
	assert.equal(await f.store.retireHistory(1), 2);
	await f.reopen();
	assert.deepEqual(
		(await f.store.snapshot()).map(({ id }) => id),
		["later"],
	);
	for (const request of [prepared, handedOff]) {
		const archived = (
			await f.storage.getValue(value("jouzu.flow.native-request-history", request.id), BACKGROUND_CONTEXT)
		).value;
		assert.deepEqual(
			archived,
			before.find(({ id }) => id === request.id),
		);
		assert.equal(archived.reset, true);
		assert.equal(archived.outcome, undefined);
		assert.equal(!!archived.payload, request === handedOff);
		await assert.rejects(f.store.begin(request), { code: "stale" });
	}
});

test("retired cancellations survive disk reopen and reject adapter delivery", async (t) => {
	const f = await fixture(t);
	const held = input("cancel-held", ["cancel-input"], "unresolved");
	await f.store.begin(held, true, held.sourceCapture.members);
	assert.equal(await f.store.handoff(held.id, payload(held, "unresolved")), false);
	await f.store.cancelSources(held.id, hash, [0]);
	await complete(f.store, "later", ["other"]);
	assert.equal(await f.store.retireHistory(1), 0);
	await f.store.reconcileSources(held.sourceCapture.members, "compacted");
	await assert.rejects(
		f.store.retireHistory(1, new Set(), new Set(), () => {
			throw new Error("revoked");
		}),
		/revoked/,
	);
	assert.equal((await f.store.snapshot()).length, 2);
	assert.equal(await f.store.retireHistory(1), 1);
	await f.reopen();
	assert.deepEqual(await f.store.cancelledSources(held.sourceCapture.members), held.sourceCapture.members);
	assert.deepEqual(await f.store.cancelledSources(input("unrelated", ["distinct"]).sourceCapture.members), []);
	const replay = input("replay-cancelled", ["cancel-input"]);
	await f.store.begin(replay, true, replay.sourceCapture.members);
	assert.deepEqual((await f.store.snapshot()).at(-1).requiredSources, []);
	await assert.rejects(f.store.handoff(replay.id, payload(replay)), { code: "identity" });
});

test("completed retry chains retire together and retain provenance after reopen", async (t) => {
	const f = await fixture(t);
	const first = input("held", ["retry-input"], "unresolved");
	await f.store.begin(first, true, first.sourceCapture.members);
	assert.equal(await f.store.handoff(first.id, payload(first, "unresolved")), false);
	await f.store.authorizeRetry(first.id, hash);
	const retry = input("retry", ["retry-input"]);
	await f.store.begin(retry, true, retry.sourceCapture.members);
	await f.store.handoff(retry.id, payload(retry));
	await f.store.finish(retry.id, "success");
	const chain = await f.store.snapshot();
	assert.equal(chain[0].retryAuthorization.requestId, "retry");
	assert.equal(chain[1].retryOf, "held");
	assert.equal(await f.store.retireHistory(1), 0, "the keep window cannot split a chain");
	await complete(f.store, "newest", ["new-input"]);
	assert.equal(await f.store.retireHistory(1, new Set(["retry-input"])), 0);
	assert.equal(await f.store.retireHistory(1, new Set(), new Set(["held"])), 0);
	await assert.rejects(
		f.store.retireHistory(1, new Set(), new Set(), () => {
			throw new Error("revoked");
		}),
		/revoked/,
	);
	assert.equal((await f.store.snapshot()).length, 3);
	assert.equal(await f.store.retireHistory(1), 2);
	await f.reopen();
	assert.deepEqual(
		(await f.store.snapshot()).map(({ id }) => id),
		["newest"],
	);
	for (const record of chain) {
		assert.deepEqual(
			(await f.storage.getValue(value("jouzu.flow.native-request-history", record.id), BACKGROUND_CONTEXT)).value,
			record,
		);
		await assert.rejects(f.store.begin(input(record.id)), { code: "stale" });
	}
});

test("history retirement bounds settled outcomes while preserving live and incomplete evidence across reopen", async (t) => {
	const f = await fixture(t);
	await complete(f.store, "live", ["live-operation"]);
	await complete(f.store, "observed", ["observed-operation"]);
	await complete(f.store, "failed", ["failed-operation"], "failure");
	await complete(f.store, "omitted", ["omitted-operation"], "success", "unresolved");
	// "omitted" is unresolved at model conversion, so its evidence is incomplete.
	for (let i = 0; i < 8; i++) await complete(f.store, `unique-${i}`, [`operation-${i}`]);
	// A settled failure is retired by age like a success: nothing reads a retained failure record
	// back for a decision, and the keep window still preserves the most recent ones. "omitted" stays
	// because its evidence is incomplete, which is a different thing from having delivered nothing.
	assert.equal(await f.store.retireHistory(2, new Set(["live-operation"]), new Set(["observed"])), 7);
	const ids = ["live", "observed", "omitted", "unique-6", "unique-7"];
	assert.deepEqual(
		(await f.store.snapshot()).map((record) => record.id),
		ids,
	);
	await f.reopen();
	assert.deepEqual(
		(await f.store.snapshot()).map((record) => record.id),
		ids,
	);
	await assert.rejects(f.store.begin(input("unique-0")), { code: "stale" });
	const before = await f.store.snapshot();
	await assert.rejects(
		f.store.retireHistory(1, new Set(), new Set(), () => {
			throw new Error("stale references");
		}),
		/stale references/,
	);
	assert.deepEqual(await f.store.snapshot(), before);
});

test("retention preserves distinct input identities, unique observations, failures, and retry chains", () => {
	const a = successful("a", ["first"]),
		b = successful("b", ["second"]),
		both = successful("both", ["first", "second"]);
	assert.deepEqual(supersededNativeRequests([a, b]), []);
	assert.deepEqual(supersededNativeRequests([a, b, both]), ["a", "b"]);
	const failure = { ...a, outcome: "failure" };
	// Incomplete evidence is now a model-conversion status rather than a wire disposition.
	const changed = structuredClone(a);
	changed.sourceCapture.model.members[0].status = "changed";
	changed.payload.sources[0] = { sourceIndex: 0, disposition: "changed" };
	assert.deepEqual(supersededNativeRequests([failure, both]), []);
	assert.deepEqual(supersededNativeRequests([changed, both]), []);
	const parent = {
		...a,
		id: "parent",
		outcome: "withheld",
		retryAuthorization: { ownerId: "owner", requestId: "retry" },
	};
	const retry = { ...a, id: "retry", retryOf: "parent" };
	assert.deepEqual(supersededNativeRequests([parent, retry, both]), []);
	const held = { ...a, outcome: "withheld", cancelledSources: [0], requiredSources: [0] };
	assert.deepEqual(supersededNativeRequests([held, both]), []);
});

test("only matching projection observation can supersede a terminal-output or wait receipt", () => {
	const first = successful("first"),
		later = successful("later");
	first.projectionCapture = {
		hash,
		count: 2,
		members: [
			{
				index: 1,
				messageHash: "b".repeat(64),
				message: { role: "custom", customType: "wait", content: "done", display: false, timestamp: 1 },
			},
		],
		model: {
			hash,
			count: 2,
			members: [{ sourceIndex: 1, status: "converted", index: 1, messageHash: "c".repeat(64) }],
		},
	};
	first.payload.projections = [{ sourceIndex: 1, disposition: "included", index: 1, contentHash: "d".repeat(64) }];
	assert.deepEqual(supersededNativeRequests([first, later]), []);
	later.projectionCapture = structuredClone(first.projectionCapture);
	later.payload.projections = structuredClone(first.payload.projections);
	assert.deepEqual(supersededNativeRequests([first, later]), ["first"]);
	// Evidence identity comes from what reached the adapter, so a differing converted message is
	// what makes the later record cover something else.
	later.projectionCapture.model.members[0].messageHash = "e".repeat(64);
	assert.deepEqual(supersededNativeRequests([first, later]), []);
});

test("retirement removes old values atomically and keeps request IDs reserved after reopen", async (t) => {
	const f = await fixture(t);
	await complete(f.store, "first");
	await complete(f.store, "second");
	const original = (await f.store.snapshot())[0];
	assert.equal(await f.store.retireSuperseded(), 1);
	assert.deepEqual(
		(await f.store.snapshot()).map((item) => item.id),
		["second"],
	);
	assert.equal(
		(await f.storage.getValue(value("jouzu.flow.native-request", "first"), BACKGROUND_CONTEXT))?.value,
		undefined,
	);
	assert.equal(
		(await f.storage.getValue(value("jouzu.flow.native-request-history", "first"), BACKGROUND_CONTEXT))?.value.id,
		"first",
	);
	assert.equal(await f.store.retireSuperseded(), 0);
	await f.reopen();
	assert.deepEqual(
		(await f.storage.getValue(value("jouzu.flow.native-request-history", "first"), BACKGROUND_CONTEXT))?.value,
		original,
	);
	await assert.rejects(f.store.begin(input("first")), { code: "stale" });
	await complete(f.store, "third");
	assert.equal(await f.store.retireSuperseded(), 1);
});

test("over 1024 repeated continuations retain one successful receipt and replay protection", async (t) => {
	const f = await fixture(t);
	for (let i = 0; i < 1030; i++) {
		await complete(f.store, `request-${i}`);
		assert.equal(await f.store.retireSuperseded(), i ? 1 : 0);
	}
	assert.equal((await f.store.snapshot()).length, 1);
	await f.reopen();
	await assert.rejects(f.store.begin(input("request-0")), { code: "stale" });
	await assert.rejects(f.store.begin(input("request-1028")), { code: "stale" });
	await complete(f.store, "after-reopen");
	assert.equal(await f.store.retireSuperseded(), 1);
});

test("legacy retirement at its former quota migrates and continues while active requests stay protected", async (t) => {
	const f = await fixture(t, MAX_RETIRED_NATIVE_REQUESTS);
	await complete(f.store, "first");
	await complete(f.store, "second");
	assert.equal(await f.store.retireSuperseded(), 1);
	const header = (await f.storage.getValue(value("jouzu.flow.native-requests", "v1"), BACKGROUND_CONTEXT)).value;
	assert.equal(header.retired, undefined);
	assert.ok(JSON.stringify(header).length < 512);
	await assert.rejects(f.store.begin(input("old-0")), { code: "stale" });
	await f.store.begin(input("active"));
	await assert.rejects(f.store.retireSuperseded(), { code: "busy" });
	await f.store.finish("active", "withheld");
	await f.reopen();
	assert.equal((await f.store.snapshot()).length, 2);
	await assert.rejects(f.store.begin(input("first")), { code: "stale" });
	await assert.rejects(f.store.begin(input(`old-${MAX_RETIRED_NATIVE_REQUESTS - 1}`)), { code: "stale" });
});

test("source reconciliation crosses the lifetime quota and admits compacted input after reopen", async (t) => {
	const f = await fixture(t, 0, MAX_RETIRED_NATIVE_REQUESTS);
	const source = (operationId) => ({ operationId, prompt: { inputIndex: 0, messageIndex: 0 } });
	assert.equal(await f.store.reconcileSources([source("added")], "compacted"), 1);
	assert.equal(await f.store.reconcileSources([source("added")], "reset"), 0);
	assert.equal(await f.store.sourceReconciled(source("source-0")), true);
	assert.equal(await f.store.sourceReconciled(source("missing")), false);
	const header = (await f.storage.getValue(value("jouzu.flow.native-requests", "v1"), BACKGROUND_CONTEXT)).value;
	assert.equal(header.reconciled, undefined);
	assert.ok(JSON.stringify(header).length < 512);
	await f.reopen();
	assert.equal(await f.store.sourceReconciled(source("added")), true);
	assert.equal((await f.store.reconciledSources()).size, MAX_RETIRED_NATIVE_REQUESTS + 1);
	await f.store.begin(input("after", ["fresh"]), true, [source("fresh"), source("added"), source("source-0")]);
	await f.store.finish("after", "withheld");
});

test("failed native retirement commits preserve active receipts and publish no archive", async (t) => {
	const f = await fixture(t);
	await complete(f.store, "first");
	await complete(f.store, "second");
	const before = await f.store.snapshot();
	const mutate = f.storage.mutate.bind(f.storage);
	f.storage.mutate = (update, context) =>
		mutate(
			(mutation, ctx) =>
				update(
					new Proxy(mutation, {
						get(target, key) {
							if (key === "commit")
								return () => {
									throw new Error("injected native commit failure");
								};
							const field = Reflect.get(target, key);
							return typeof field === "function" ? field.bind(target) : field;
						},
					}),
					ctx,
				),
			context,
		);
	await assert.rejects(f.store.retireSuperseded(), /injected native commit failure/);
	f.storage.mutate = mutate;
	assert.deepEqual(await f.store.snapshot(), before);
	assert.equal(
		await f.storage.getValue(value("jouzu.flow.native-request-history", "first"), BACKGROUND_CONTEXT),
		undefined,
	);
	assert.equal(
		await f.storage.getValue(
			value("jouzu.flow.native-request-retired", retiredIdentityHash("native-request", "first")),
			BACKGROUND_CONTEXT,
		),
		undefined,
	);
	assert.equal(await f.store.retireSuperseded(), 1);
	await f.reopen();
	await assert.rejects(f.store.begin(input("first")), { code: "stale" });
});

test("failed legacy native migration preserves both arrays and retries after reopen", async (t) => {
	const f = await fixture(t);
	const source = { operationId: "compacted", prompt: { inputIndex: 0, messageIndex: 0 } };
	const requestKey = retiredIdentityHash("native-request", "old");
	const sourceKey = retiredIdentityHash("native-source", JSON.stringify(["compacted", 0, 0, null, null]));
	const headerAddress = value("jouzu.flow.native-requests", "v1");
	const legacy = {
		version: 1,
		scope,
		ids: [],
		retired: [requestKey],
		reconciled: [{ key: sourceKey, reason: "compacted" }],
	};
	const archived = {
		...input("old", ["compacted"], "unresolved"),
		ownerId: "owner",
		outcome: "withheld",
		reset: true,
		requiredSources: [0],
		cancelledSources: [0],
	};
	await f.storage.mutate(
		(writer, context) =>
			writer.commit(
				[setValue(headerAddress, legacy), setValue(value("jouzu.flow.native-request-history", "old"), archived)],
				context,
			),
		BACKGROUND_CONTEXT,
	);
	const mutate = f.storage.mutate.bind(f.storage);
	f.storage.mutate = (update, context) =>
		mutate(
			(mutation, ctx) =>
				update(
					new Proxy(mutation, {
						get(target, key) {
							if (key === "commit")
								return () => {
									throw new Error("injected migration failure");
								};
							const field = Reflect.get(target, key);
							return typeof field === "function" ? field.bind(target) : field;
						},
					}),
					ctx,
				),
			context,
		);
	await assert.rejects(f.store.snapshot(), /injected migration failure/);
	f.storage.mutate = mutate;
	assert.deepEqual((await f.storage.getValue(headerAddress, BACKGROUND_CONTEXT)).value, legacy);
	assert.equal(
		await f.storage.getValue(value("jouzu.flow.native-request-retired", requestKey), BACKGROUND_CONTEXT),
		undefined,
	);
	assert.equal(
		await f.storage.getValue(value("jouzu.flow.native-source-reconciled", sourceKey), BACKGROUND_CONTEXT),
		undefined,
	);
	assert.equal(
		await f.storage.getValue(value("jouzu.flow.native-source-cancelled", sourceKey), BACKGROUND_CONTEXT),
		undefined,
	);
	await f.reopen();
	await assert.rejects(f.store.begin(input("old")), { code: "stale" });
	assert.deepEqual(await f.store.cancelledSources(archived.sourceCapture.members), archived.sourceCapture.members);
	assert.equal(await f.store.sourceReconciled(source), true);
	const header = (await f.storage.getValue(headerAddress, BACKGROUND_CONTEXT)).value;
	assert.equal(header.retired, undefined);
	assert.equal(header.reconciled, undefined);
	assert.equal(header.cancellationIndexVersion, 1);
	await f.reopen();
	const reopenedMutate = f.storage.mutate.bind(f.storage);
	f.storage.mutate = (update, context) =>
		reopenedMutate(
			(mutation, ctx) =>
				update(
					new Proxy(mutation, {
						get(target, key) {
							if (key === "scanValues")
								return () => {
									throw new Error("repeated cancellation migration scan");
								};
							const field = Reflect.get(target, key);
							return typeof field === "function" ? field.bind(target) : field;
						},
					}),
					ctx,
				),
			context,
		);
	assert.deepEqual(await f.store.cancelledSources(archived.sourceCapture.members), archived.sourceCapture.members);
	await f.store.snapshot();
});

test("native admission and source checks query exact history without scans or rewrites", async (t) => {
	const f = await fixture(t, 8, 8);
	const source = { operationId: "source-0", prompt: { inputIndex: 0, messageIndex: 0 } };
	const fresh = { operationId: "fresh", prompt: { inputIndex: 0, messageIndex: 0 } };
	const seen = new Set();
	const mutate = f.storage.mutate.bind(f.storage);
	f.storage.mutate = (update, context) =>
		mutate(
			(mutation, ctx) =>
				update(
					new Proxy(mutation, {
						get(target, key) {
							if (key === "scanValues")
								return () => {
									throw new Error("unexpected history scan");
								};
							if (key === "getValue")
								return (address, context) => {
									if (address.namespace === "jouzu.flow.native-source-reconciled") seen.add(address.key);
									return target.getValue(address, context);
								};
							if (key === "commit")
								return (writes, context) => {
									assert.ok(
										writes.every(
											(write) =>
												!["jouzu.flow.native-source-reconciled", "jouzu.flow.native-request-retired"].includes(
													write.namespace,
												),
										),
										"read-only history queries must not rewrite indexes",
									);
									return target.commit(writes, context);
								};
							const field = Reflect.get(target, key);
							return typeof field === "function" ? field.bind(target) : field;
						},
					}),
					ctx,
				),
			context,
		);
	assert.equal(await f.store.sourceReconciled(source), true);
	await f.store.begin(input("fresh-request", ["fresh"]), true, [fresh, source]);
	await f.store.finish("fresh-request", "withheld");
	assert.deepEqual(
		[...seen].sort(),
		["source-0", "fresh"]
			.map((operationId) => retiredIdentityHash("native-source", JSON.stringify([operationId, 0, 0, null, null])))
			.sort(),
	);
});

test("settled failures are retired by age like successes", async (t) => {
	const f = await fixture(t);
	// Alternating outcomes, each with its own operation so no later success supersedes another.
	for (let index = 0; index < 40; index++)
		await complete(f.store, `r${index}`, [`op-${index}`], index % 2 === 0 ? "success" : "failure");
	assert.equal(await f.store.retireSuperseded(), 0, "distinct inputs are never superseded");

	// A failed request carries no delivery evidence to preserve: nothing was included, no retry is
	// linked to it, and it holds no input. Keeping it forever walks the store to its record limit
	// on any session that sees intermittent provider failures.
	const retired = await f.store.retireHistory(10, new Set(), new Set());
	const remaining = await f.store.snapshot();
	assert.equal(remaining.length, 10, `retirement bounds every settled outcome: ${retired} retired`);
	assert.ok(
		remaining.some((record) => record.outcome === "failure"),
		"the newest records are kept regardless of outcome, rather than successes being singled out",
	);
	// Every surviving record is still valid after reopen, and the fences stop replay of retired ids.
	await f.reopen();
	assert.equal((await f.store.snapshot()).length, 10);
	await assert.rejects(f.store.begin(input("r0")), { code: "stale" });
});

test("a failure that a retry is built on is kept with its partner", async (t) => {
	const f = await fixture(t);
	for (let index = 0; index < 20; index++) await complete(f.store, `filler-${index}`, [`op-${index}`], "failure");
	// A withheld request holding required input is authorized for retry, and neither end of that
	// pair may be retired: the retry needs its parent's held evidence to be admissible.
	const held = input("held", ["held-op"]);
	await f.store.begin(held, true, [{ operationId: "held-op", prompt: { inputIndex: 0, messageIndex: 0 } }]);
	await f.store.finish("held", "withheld");
	await f.store.authorizeRetry("held", hash);
	await f.store.retireHistory(1, new Set(), new Set());
	const remaining = await f.store.snapshot();
	assert.ok(
		remaining.some((record) => record.id === "held"),
		"a request awaiting its authorized retry is never retired",
	);
	const retry = input("linked-retry", ["held-op"]);
	await f.store.begin(retry, true, [{ operationId: "held-op", prompt: { inputIndex: 0, messageIndex: 0 } }]);
	await f.store.handoff(retry.id, payload(retry));
	await f.store.finish(retry.id, "success");
	await f.store.retireHistory(1);
	await f.reopen();
	const linked = await f.store.snapshot();
	assert.equal(linked.find((record) => record.id === "held").retryAuthorization.requestId, retry.id);
	assert.equal(linked.find((record) => record.id === retry.id).retryOf, "held");
});

test("required content is judged at model conversion, not at the wire", async (t) => {
	const f = await fixture(t);
	// A required source that conversion left `changed` is not delivered, so the handoff is withheld
	// and the request keeps its withheld payload for repair. This is the guarantee that used to be
	// enforced by decoding the provider body.
	const claims = [{ operationId: "operation", prompt: { inputIndex: 0, messageIndex: 0 } }];
	const changed = input("changed", ["operation"], "changed");
	await f.store.begin(changed, true, claims);
	assert.equal(await f.store.handoff("changed", payload(changed, "changed")), false);
	const [held] = await f.store.snapshot();
	assert.equal(held.outcome, "withheld");
	assert.equal(held.payload, undefined);
	assert.ok(held.withheldPayload.bytes > 0);
	// A withheld required input blocks the next request until the user repairs it.
	await assert.rejects(f.store.begin(input("next", ["operation"]), true, claims), { code: "busy" });
});

test("a required source delivered at conversion is admitted", async (t) => {
	const f = await fixture(t);
	const claims = [{ operationId: "operation", prompt: { inputIndex: 0, messageIndex: 0 } }];
	const intact = input("intact", ["operation"]);
	await f.store.begin(intact, true, claims);
	assert.equal(await f.store.handoff("intact", payload(intact)), true);
	assert.equal((await f.store.snapshot())[0].payload.bytes, 10000);
});

test("a request carrying live wait context is kept by its recorded reference", async (t) => {
	const f = await fixture(t);
	const token = "wait-token";
	const carrying = input("carrying");
	const message = {
		role: "custom",
		customType: "jouzu-wait-context",
		content: "{}",
		display: false,
		timestamp: 0,
	};
	const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
	const converted = { role: "user", content: [{ type: "text", text: message.content }], timestamp: message.timestamp };
	carrying.projectionCapture = {
		hash: carrying.sourceCapture.context.hash,
		count: carrying.sourceCapture.context.count,
		members: [{ index: 0, messageHash: digest(message), message }],
		model: {
			hash: carrying.sourceCapture.model.hash,
			count: carrying.sourceCapture.model.count,
			members: [{ sourceIndex: 0, status: "converted", index: 0, messageHash: digest(converted) }],
		},
	};
	carrying.waitTokens = [token];
	await f.store.begin(carrying);
	await f.store.handoff("carrying", payload(carrying));
	await f.store.finish("carrying", "success");
	const [record] = await f.store.snapshot();
	// The reference is read from what the decorator recorded, not searched for in the content: the
	// projection here carries no token text at all.
	assert.deepEqual(record.waitTokens, [token]);
	assert.equal(JSON.stringify(record.projectionCapture).includes(token), false);

	// A record may only claim wait references alongside the projections that carried them.
	const unbacked = input("unbacked");
	unbacked.waitTokens = [token];
	await assert.rejects(f.store.begin(unbacked), { code: "schema" });
});
