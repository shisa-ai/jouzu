import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, setValue, value } from "@earendil-works/pi-agent-core";
import { openLocalFlowSession } from "../dist/flow-control/local-storage.js";
import { supersededNativeRequests } from "../dist/flow-control/native-request-retention.js";
import { MAX_RETIRED_NATIVE_REQUESTS } from "../dist/flow-control/native-request-store.js";
import { PiFlowAttachment } from "../dist/flow-control/pi-attachment.js";
import { retiredIdentityHash } from "../dist/flow-control/retired-identities.js";

const scope = { sessionId: "session", branchId: "branch" };
const hash = "a".repeat(64);
function input(id, operations = ["input"]) {
	const members = operations.map((operationId, index) => ({
		index,
		operationId,
		messageHash: hash,
		prompt: { inputIndex: 0, messageIndex: 0 },
	}));
	const positions = members.map(({ index }) => ({ sourceIndex: index, status: "intact", index, messageHash: hash }));
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
			model: { hash, count: members.length, members: structuredClone(positions) },
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
async function fixture(t, retiredCount = 0) {
	const root = await mkdtemp(join(tmpdir(), "jouzu-request-retention-"));
	let storage;
	let attachment = await PiFlowAttachment.open(root, scope, async (directory) => {
		storage = await openLocalFlowSession(directory);
		if (retiredCount)
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
			attachment = await PiFlowAttachment.open(root, scope);
		},
	};
}
async function complete(store, id, operations = ["input"], outcome = "success", disposition = "included") {
	const record = input(id, operations);
	await store.begin(record);
	await store.handoff(id, payload(record, disposition));
	await store.finish(id, outcome);
}

test("history retirement bounds settled outcomes while preserving live and incomplete evidence across reopen", async (t) => {
	const f = await fixture(t);
	await complete(f.store, "live", ["live-operation"]);
	await complete(f.store, "observed", ["observed-operation"]);
	await complete(f.store, "failed", ["failed-operation"], "failure");
	await complete(f.store, "omitted", ["omitted-operation"], "success", "unresolved");
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
	const changed = structuredClone(a);
	changed.payload.sources[0].disposition = "changed";
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
	later.payload.projections[0].contentHash = "e".repeat(64);
	assert.deepEqual(supersededNativeRequests([first, later]), []);
});

test("retirement removes old values atomically and keeps request IDs reserved after reopen", async (t) => {
	const f = await fixture(t);
	await complete(f.store, "first");
	await complete(f.store, "second");
	assert.equal(await f.store.retireSuperseded(), 1);
	assert.deepEqual(
		(await f.store.snapshot()).map((item) => item.id),
		["second"],
	);
	assert.equal(
		(await f.storage.getValue(value("jouzu.flow.native-request", "first"), BACKGROUND_CONTEXT))?.value,
		undefined,
	);
	assert.equal(await f.store.retireSuperseded(), 0);
	await f.reopen();
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

test("active requests and exhausted retirement quota preserve all receipts", async (t) => {
	const f = await fixture(t, MAX_RETIRED_NATIVE_REQUESTS);
	await complete(f.store, "first");
	await complete(f.store, "second");
	const before = await f.store.snapshot();
	await assert.rejects(f.store.retireSuperseded(), { code: "capacity" });
	assert.deepEqual(await f.store.snapshot(), before);
	await f.store.begin(input("active"));
	await assert.rejects(f.store.retireSuperseded(), { code: "busy" });
	await f.store.finish("active", "withheld");
	await f.reopen();
	assert.equal((await f.store.snapshot()).length, 3);
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
});
