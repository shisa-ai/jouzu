import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "../../..");

async function bundle(t, entries) {
	const directory = await mkdtemp(join(root, "node_modules/.jouzu-bg-store-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const output = join(directory, "modules.mjs");
	const contents = Object.entries(entries)
		.map(([name, file]) => `export * as ${name} from ${JSON.stringify(file)};`)
		.join("\n");
	await build({
		stdin: { contents, resolveDir: root, loader: "ts" },
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external",
		outfile: output,
		logLevel: "silent",
	});
	return import(pathToFileURL(output).href);
}

const loadStore = (t) => bundle(t, { store: join(root, "upstream/background-flow/store.ts") });

async function temporaryStore(t) {
	const directory = await mkdtemp(join(tmpdir(), "jouzu-bg-store-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return { directory, file: join(directory, "state-v2.json") };
}

function fakeScheduler() {
	const pending = new Set();
	return {
		setTimer(callback) {
			const handle = { callback };
			pending.add(handle);
			return handle;
		},
		clearTimer(handle) {
			pending.delete(handle);
		},
		run() {
			for (const handle of [...pending]) {
				pending.delete(handle);
				handle.callback();
			}
		},
		size: () => pending.size,
	};
}

const snapshot = (overrides = {}) => ({
	id: "bg-1",
	title: "task",
	command: "sleep 1",
	cwd: "/tmp",
	pid: 42,
	logFile: "/tmp/task.log",
	startedAt: 1,
	updatedAt: 1,
	lastOutputAt: null,
	expiresAt: null,
	status: "running",
	exitCode: null,
	notifyOnExit: true,
	notifyOnOutput: false,
	outputBytes: 0,
	...overrides,
});

const result = (execution, overrides = {}) => ({
	scope: { sessionId: "session-a", branchId: "branch-a" },
	work: { id: "work", revision: 1 },
	result: {
		notify: true,
		metadata: {
			id: `bg-result:${execution}`,
			producer: "bg",
			execution,
			revision: "1",
			status: "success",
			title: "completed",
			reference: "/tmp/task.log",
			warnings: [],
		},
		...overrides,
	},
});

function adapterFor(store, options) {
	return store.createCanonicalBackgroundStore({
		sessionId: () => options.sessionId ?? "session-a",
		storePath: () => options.file,
		tasks: () => options.tasks(),
		results: () => options.results(),
		nextTaskId: () => options.nextTaskId(),
		diagnostics: () => options.diagnostics?.() ?? [],
		applyTask: (task) => options.applied.push(task),
		setNextTaskId: (value) => {
			options.nextTaskIdValue = Math.max(options.nextTaskIdValue ?? 0, value);
		},
		restoreResults: (records) => options.restored.push(...records),
		markerPresent: () => options.markerPresent?.() ?? false,
		appendMarker: () => {
			if (options.failMarker) throw new Error("marker write failed");
			options.markers.push("marker");
		},
		reportProblem: (where, message) => options.problems.push(`${where}:${message}`),
		now: () => 1000,
		...options.overrides,
	});
}

function newOptions(file, overrides = {}) {
	return {
		file,
		tasks: overrides.tasks ?? (() => []),
		results: overrides.results ?? (() => []),
		nextTaskId: overrides.nextTaskId ?? (() => 0),
		diagnostics: overrides.diagnostics,
		applied: [],
		restored: [],
		markers: [],
		problems: [],
		markerPresent: overrides.markerPresent,
		failMarker: overrides.failMarker,
		nextTaskIdValue: 0,
		overrides: overrides.overrides,
	};
}

test("many progress updates coalesce to one bounded store write and no transcript entries", async (t) => {
	const { store } = await loadStore(t);
	const { file } = await temporaryStore(t);
	const scheduler = fakeScheduler();
	let tasks = [];
	const options = newOptions(file, {
		tasks: () => tasks,
		overrides: { setTimer: scheduler.setTimer, clearTimer: scheduler.clearTimer },
	});
	const adapter = adapterFor(store, options);
	for (let index = 0; index < 5000; index++) {
		tasks = [snapshot({ outputBytes: index, updatedAt: index })];
		adapter.persist("progress");
	}
	assert.equal(options.markers.length, 0, "progress does not establish the adoption marker");
	assert.equal(scheduler.size(), 1, "coalescing retains one pending flush at most");
	await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" }, "no store exists before the flush");
	scheduler.run();
	const first = JSON.parse(await readFile(file, "utf8"));
	assert.equal(first.generation, 1);
	assert.equal(first.revision, 1);
	assert.equal(options.markers.length, 1, "the store commits before the single adoption marker");
	assert.equal(first.tasks[0].outputBytes, 4999, "the flush writes the newest state, not an intermediate sample");
	assert.deepEqual(options.problems, []);
	for (let index = 0; index < 5000; index++) adapter.persist("progress");
	scheduler.run();
	const second = JSON.parse(await readFile(file, "utf8"));
	assert.equal(second.generation, 2);
	assert.equal(options.markers.length, 1, "the adoption marker is written once");
});

test("force commits before the marker and retries a failed marker append idempotently", async (t) => {
	const { store } = await loadStore(t);
	const { file } = await temporaryStore(t);
	const options = newOptions(file, { failMarker: true });
	const adapter = adapterFor(store, options);
	assert.deepEqual(adapter.persist("force"), { appendEntry: true, sidecar: true, appendReason: "appended" });
	const committed = JSON.parse(await readFile(file, "utf8"));
	assert.equal(committed.generation, 1);
	assert.equal(options.markers.length, 0, "the failed marker append did not undo the store commit");
	assert.ok(options.problems.some((problem) => problem.startsWith("store-marker:")));
	options.failMarker = false;
	assert.equal(adapter.persist("force").sidecar, true);
	assert.equal(options.markers.length, 1, "the marker is retried and written exactly once");
	const marker = store.canonicalMarkerData("session-a", 1234);
	assert.equal(store.isCanonicalMarker(marker), true);
	assert.equal(store.isCanonicalMarker({ ...marker, sessionId: "" }), false);
	assert.equal(JSON.stringify(marker).includes("/"), false, "the marker never embeds absolute paths");
});

test("a failed write or rename leaves the previous revision intact", async (t) => {
	const { store } = await loadStore(t);
	const { file } = await temporaryStore(t);
	let failWrite = false;
	let failRename = false;
	const io = {
		...store.nodeCanonicalStoreIo,
		writeFile(path, data) {
			if (failWrite) {
				failWrite = false;
				throw new Error("disk full");
			}
			store.nodeCanonicalStoreIo.writeFile(path, data);
		},
		rename(from, to) {
			if (failRename) {
				failRename = false;
				throw new Error("rename denied");
			}
			store.nodeCanonicalStoreIo.rename(from, to);
		},
	};
	const options = newOptions(file, { overrides: { io } });
	const adapter = adapterFor(store, options);
	assert.equal(adapter.persist("force").sidecar, true);
	const first = JSON.parse(await readFile(file, "utf8"));
	failWrite = true;
	assert.deepEqual(adapter.persist("force"), { appendEntry: false, sidecar: false, appendReason: "error" });
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), first, "a failed write preserves the committed revision");
	assert.ok(options.problems.some((problem) => problem.startsWith("store-write:disk full")));
	failRename = true;
	assert.equal(adapter.persist("force").sidecar, false);
	assert.deepEqual(JSON.parse(await readFile(file, "utf8")), first, "a failed rename preserves the committed revision");
	assert.equal(adapter.persist("force").sidecar, true);
	assert.equal(JSON.parse(await readFile(file, "utf8")).generation, first.generation + 1);
	assert.equal(
		(await readdir(dirname(file))).filter((name) => name.includes(".tmp.")).length,
		0,
		"failed temporary files are removed",
	);
});

test("restore after clear retains an unobserved result and keeps task ids monotonic", async (t) => {
	const { store } = await loadStore(t);
	const { file } = await temporaryStore(t);
	let tasks = [snapshot({ id: "bg-3", status: "completed", exitCode: 0, startedAt: 3 })];
	const results = [result("execution-1")];
	const writer = adapterFor(
		store,
		newOptions(file, { tasks: () => tasks, results: () => results, nextTaskId: () => 3 }),
	);
	assert.equal(writer.persist("force").sidecar, true);
	// Clearing the display removes the task record but must retain the result.
	tasks = [];
	assert.equal(writer.persist("force").sidecar, true);
	const readOptions = newOptions(file, { markerPresent: () => true });
	const reader = adapterFor(store, readOptions);
	assert.equal(reader.restoreFromStore(), true);
	assert.deepEqual(readOptions.applied, [], "cleared tasks do not come back");
	assert.equal(readOptions.restored.length, 1);
	assert.equal(readOptions.restored[0].result.metadata.execution, "execution-1");
	assert.equal(readOptions.restored[0].result.delivered, undefined, "unobserved results stay eligible for delivery");
	assert.equal(readOptions.nextTaskIdValue, 3, "the allocation counter continues from the store");
	assert.equal(JSON.parse(await readFile(file, "utf8")).tasks.length, 0);

	// A store whose counter lags behind a task record never rewinds allocation.
	await writeFile(
		file,
		JSON.stringify({
			schemaVersion: 2,
			sessionId: "session-a",
			generation: 1,
			revision: 1,
			updatedAt: 1,
			nextTaskId: 2,
			tasks: [snapshot({ id: "bg-5" })],
			results: [],
			diagnostics: [],
		}),
	);
	const lagging = newOptions(file, { markerPresent: () => true });
	assert.equal(adapterFor(store, lagging).restoreFromStore(), true);
	assert.equal(lagging.nextTaskIdValue, 5);
});

test("legacy migration commits before the marker and never replays afterwards", async (t) => {
	const { store } = await loadStore(t);
	const { file } = await temporaryStore(t);
	assert.equal(store.parseLegacySidecar("not json"), undefined);
	const legacy = store.parseLegacySidecar(
		JSON.stringify({ version: 1, updatedAt: 7, tasks: [snapshot({ id: "bg-7", status: "failed", exitCode: 9 })] }),
	);
	assert.equal(legacy.tasks.length, 1);
	const options = newOptions(file);
	const adapter = adapterFor(store, options);
	assert.equal(adapter.restoreFromStore(), false, "a store-less, marker-less session takes the legacy path");
	// The extension replays legacy sidecar and history into its task map here.
	const tasks = legacy.tasks;
	options.tasks = () => tasks;
	adapter.adopt();
	const committed = JSON.parse(await readFile(file, "utf8"));
	assert.equal(committed.adoptedAt, 1000);
	assert.equal(committed.tasks[0].id, "bg-7");
	assert.equal(committed.tasks[0].status, "failed");
	assert.equal(options.markers.length, 1);

	// A later open uses the store only; historical state is not replayed.
	const later = newOptions(file, { markerPresent: () => true });
	assert.equal(adapterFor(store, later).restoreFromStore(), true);
	assert.equal(later.applied.length, 1);
	assert.equal(later.applied[0].id, "bg-7");
});

test("missing, corrupt and foreign stores fail closed instead of replaying history", async (t) => {
	const { store } = await loadStore(t);
	const { file } = await temporaryStore(t);

	// Missing store with an adoption marker: report once, do not resurrect tasks.
	const missing = newOptions(file, { markerPresent: () => true });
	const missingAdapter = adapterFor(store, missing);
	assert.equal(missingAdapter.restoreFromStore(), true);
	assert.deepEqual(missing.applied, []);
	assert.ok(missing.problems.some((problem) => problem.startsWith("store-missing:")));
	// A fresh store may be committed; the missing state was reported, not treated as empty success.
	assert.equal(missingAdapter.persist("force").sidecar, true);

	// Corrupt store: fail closed and never overwrite the evidence.
	const corruptFile = join(dirname(file), "corrupt.json");
	await writeFile(corruptFile, "{ this is not a store");
	const corrupt = newOptions(corruptFile, { markerPresent: () => true });
	const corruptAdapter = adapterFor(store, corrupt);
	assert.equal(corruptAdapter.restoreFromStore(), true);
	assert.deepEqual(corrupt.applied, []);
	assert.ok(corrupt.problems.some((problem) => problem.startsWith("store-corrupt:")));
	assert.deepEqual(corruptAdapter.persist("force"), { appendEntry: false, sidecar: false, appendReason: "error" });
	assert.equal(await readFile(corruptFile, "utf8"), "{ this is not a store");

	// Foreign store: another session's state is never adopted or overwritten.
	const foreignFile = join(dirname(file), "foreign.json");
	await writeFile(
		foreignFile,
		JSON.stringify({
			schemaVersion: 2,
			sessionId: "session-b",
			generation: 1,
			revision: 1,
			updatedAt: 1,
			nextTaskId: 1,
			tasks: [],
			results: [],
			diagnostics: [],
		}),
	);
	const foreign = newOptions(foreignFile, { markerPresent: () => true });
	const foreignAdapter = adapterFor(store, foreign);
	assert.equal(foreignAdapter.restoreFromStore(), true);
	assert.ok(foreign.problems.some((problem) => problem.startsWith("store-foreign:")));
	assert.equal(foreignAdapter.persist("force").sidecar, false);
});

test("restored results and tasks stay scoped to their branch and session", async (t) => {
	const { store, runtime } = await bundle(t, {
		store: join(root, "upstream/background-flow/store.ts"),
		runtime: join(root, "upstream/background-flow/runtime.ts"),
	});
	const source = runtime.createBackgroundFlowSource(() => []);
	source.restoreResults([result("execution-a")]);
	const sessionA = source.activate({ sessionId: "session-a", branchId: "branch-a" }, () => ({
		id: "work",
		revision: 1,
	}));
	const branchA = source.activateResults({ sessionId: "session-a", branchId: "branch-a" }, () => {});
	assert.equal(branchA.snapshot()[0].execution, "execution-a");
	assert.deepEqual(branchA.workForResult("bg-result:execution-a", "1"), { id: "work", revision: 1 });
	sessionA.close();
	const sessionB = source.activate({ sessionId: "session-a", branchId: "branch-b" }, () => ({
		id: "work",
		revision: 1,
	}));
	const branchB = source.activateResults({ sessionId: "session-a", branchId: "branch-b" }, () => {});
	assert.equal(branchB.snapshot().length, 0, "a result is not transferred to another branch");
	sessionB.close();

	// A fork owns no live execution authority: another session's records are skipped.
	const { file } = await temporaryStore(t);
	await writeFile(
		file,
		JSON.stringify({
			schemaVersion: 2,
			sessionId: "session-a",
			generation: 1,
			revision: 1,
			updatedAt: 1,
			nextTaskId: 1,
			tasks: [snapshot({ id: "bg-1", sessionId: "session-b" })],
			results: [],
			diagnostics: [],
		}),
	);
	const options = newOptions(file, { markerPresent: () => true });
	assert.equal(adapterFor(store, options).restoreFromStore(), true);
	assert.deepEqual(options.applied, [], "foreign-session task records are not applied");
});

test("tool-result presentation is bounded while the store retains the full execution record", async (t) => {
	const { store } = await loadStore(t);
	const longCommand = `printf '${"x".repeat(5000)}'`;
	const single = snapshot({ command: longCommand });
	assert.deepEqual(
		store.boundedPresentationTasks([single]),
		[single],
		"small lists keep their existing full snapshots",
	);
	const tasks = Array.from({ length: 80 }, (_value, index) =>
		snapshot({
			id: `bg-${index + 1}`,
			command: longCommand,
			status: "completed",
			exitCode: 0,
			wakeEvents: Array.from({ length: 50 }, (_entry, sequence) => ({ sequence })),
			pendingWakes: [{ sequence: 1 }],
			flow: { version: 1, execution: `execution-${index}`, result: result(`execution-${index}`).result },
		}),
	);
	const bounded = store.boundedPresentationTasks(tasks);
	assert.equal(bounded.fullSnapshot, false);
	assert.equal(bounded.presentation, true);
	assert.equal(bounded.counts.tasks, 80);
	assert.ok(bounded.counts.omitted > 0);
	assert.ok(Buffer.byteLength(JSON.stringify(bounded), "utf8") <= 64 * 1024);
	assert.equal(
		JSON.stringify(bounded).includes('"wakeEvents":['),
		false,
		"internal wake arrays are not presentation state",
	);
	for (const task of bounded.tasks) {
		assert.ok(task.command.length <= 192, "display commands are truncated");
		assert.ok(task.logFile.length > 0, "a retrieval reference survives");
		assert.ok(task.counters.wakeEvents === 50, "selected counters survive");
		assert.equal(task.flow.result.metadata.reference, "/tmp/task.log");
	}

	// The canonical store keeps the untruncated command once in the execution record.
	const { file } = await temporaryStore(t);
	const options = newOptions(file, { tasks: () => [single], nextTaskId: () => 1 });
	assert.equal(adapterFor(store, options).persist("force").sidecar, true);
	const committed = JSON.parse(await readFile(file, "utf8"));
	assert.equal(committed.tasks[0].command.length, longCommand.length);
});

test("a failed store in one session does not permanently block a later valid session", async (t) => {
	const { store } = await loadStore(t);
	const { file } = await temporaryStore(t);
	const options = newOptions(file, { sessionId: "session-a" });
	await writeFile(file, "{broken", "utf8");
	const adapter = adapterFor(store, options);
	assert.equal(adapter.restoreFromStore(), true);
	assert.match(options.problems.at(-1), /store-corrupt/);
	options.sessionId = "session-b";
	const valid = store.buildCanonicalState({
		sessionId: "session-b",
		now: 1000,
		nextTaskId: 0,
		tasks: [],
		results: [],
	});
	await writeFile(file, `${JSON.stringify(valid)}\n`, "utf8");
	assert.equal(adapter.restoreFromStore(), true);
	assert.deepEqual(adapter.persist(), { appendEntry: true, sidecar: true, appendReason: "appended" });
	assert.equal(
		options.problems.some((problem) => problem.includes("store-write")),
		false,
	);
});

test("store validation rejects a changed schema and bounds diagnostics", async (t) => {
	const { store } = await loadStore(t);
	const state = {
		schemaVersion: 2,
		sessionId: "session-a",
		generation: 1,
		revision: 1,
		updatedAt: 1,
		nextTaskId: 1,
		tasks: [],
		results: [],
		diagnostics: [],
	};
	assert.equal(store.validateCanonicalStore(state).ok, true);
	assert.equal(store.validateCanonicalStore({ ...state, sessionId: "" }).ok, false);
	const ring = Array.from({ length: 250 }, (_value, index) => ({ at: index, message: `entry ${index}` }));
	const bounded = store.boundedDiagnostics(ring, 100);
	assert.equal(bounded.length, 100);
	assert.equal(bounded.at(-1).message, "entry 249");
});
