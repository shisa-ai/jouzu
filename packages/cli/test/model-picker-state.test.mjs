import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	deriveProjectKey,
	emptyModelPickerState,
	loadModelPickerState,
	MODEL_PICKER_PROJECT_HISTORY_LIMIT,
	MODEL_PICKER_RECENT_LIMIT,
	MODEL_PICKER_STATE_MAX_BYTES,
	ModelPickerStateError,
	ModelPickerStore,
	modelReferenceKey,
	modelReferencesEqual,
	previousModelStack,
	projectDefaultAppliesAtStartup,
	savedModelThinkingLevel,
} from "../dist/model-picker-state.js";
import { resolveJouzuPaths } from "../dist/paths.js";

function context() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-model-picker-state-"));
	return { root, paths: resolveJouzuPaths({ homeOverride: join(root, "home") }) };
}

test("missing state is empty and dispatch updates bounded project and global MRU lists", () => {
	const { root, paths } = context();
	try {
		const store = new ModelPickerStore(paths);
		assert.deepEqual(store.load().state, emptyModelPickerState());
		const projectKey = "a".repeat(64);
		for (let index = 0; index < MODEL_PICKER_RECENT_LIMIT + 2; index += 1) {
			store.recordDispatch({ provider: "provider", modelId: `model-${index}` }, projectKey, {
				now: new Date(Date.UTC(2026, 7, 23, 0, 0, index)),
			});
		}
		store.recordDispatch({ provider: "provider", modelId: "model-5" }, projectKey, {
			now: new Date("2026-08-23T01:00:00.000Z"),
		});

		const state = store.load().state;
		assert.equal(state.recents.global.length, MODEL_PICKER_RECENT_LIMIT);
		assert.equal(state.recents.projects[projectKey].length, MODEL_PICKER_RECENT_LIMIT);
		assert.equal(state.recents.global[0].modelId, "model-5");
		assert.equal(state.recents.global[0].useCount, 2);
		assert.equal(readFileSync(join(paths.stateDir, "model-picker.json"), "utf8").includes(root), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function recent(index, reference = { provider: "p", modelId: "m" }) {
	return { ...reference, lastUsedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), useCount: 1 };
}

function writeState(paths, state) {
	mkdirSync(paths.stateDir, { recursive: true });
	const path = join(paths.stateDir, "model-picker.json");
	writeFileSync(path, JSON.stringify(state));
	return path;
}

test("project history evicts least recently used projects and preserves explicit preferences", () => {
	const { root, paths } = context();
	try {
		const state = emptyModelPickerState();
		for (let index = 0; index < MODEL_PICKER_PROJECT_HISTORY_LIMIT; index++) {
			state.recents.projects[`project-${index}`] = [recent(index)];
		}
		const favorite = { provider: "p", modelId: "favorite", addedAt: recent(0).lastUsedAt };
		state.favorites = [favorite];
		state.defaults.projects["project-1"] = { provider: "p", modelId: "saved" };
		writeState(paths, state);
		const store = new ModelPickerStore(paths);
		store.recordDispatch({ provider: "p", modelId: "m" }, "project-0", { now: new Date("2026-02-01T00:00:00Z") });
		store.recordDispatch({ provider: "p", modelId: "new" }, "new-project", { now: new Date("2026-02-02T00:00:00Z") });
		const saved = store.load().state;
		assert.equal(Object.keys(saved.recents.projects).length, MODEL_PICKER_PROJECT_HISTORY_LIMIT);
		assert.equal(saved.recents.projects["project-1"], undefined, "use order, not original insertion order");
		assert.equal(saved.recents.projects["project-0"][0].useCount, 2);
		assert.ok(saved.recents.projects["new-project"]);
		assert.deepEqual(saved.defaults, state.defaults);
		assert.deepEqual(saved.favorites, [favorite]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loading excess project histories bounds memory state without rewriting the source", () => {
	const { root, paths } = context();
	try {
		const state = emptyModelPickerState();
		for (let index = MODEL_PICKER_PROJECT_HISTORY_LIMIT + 2; index >= 0; index--) {
			state.recents.projects[`project-${index}`] = [recent(index)];
		}
		state.recents.projects.empty = [];
		const path = writeState(paths, state);
		const before = readFileSync(path, "utf8");
		const loaded = loadModelPickerState(paths).state;
		assert.equal(Object.keys(loaded.recents.projects).length, MODEL_PICKER_PROJECT_HISTORY_LIMIT);
		assert.equal(loaded.recents.projects["project-0"], undefined);
		assert.equal(loaded.recents.projects.empty, undefined);
		assert.ok(loaded.recents.projects[`project-${MODEL_PICKER_PROJECT_HISTORY_LIMIT + 2}`]);
		assert.equal(readFileSync(path, "utf8"), before);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the byte limit evicts oldest project histories before writing UTF-8 state", () => {
	const { root, paths } = context();
	try {
		const state = emptyModelPickerState();
		const reference = {
			provider: "日".repeat(512),
			modelId: "語".repeat(512),
			catalogId: "書".repeat(512),
			offeringId: "字".repeat(512),
		};
		const records = Array.from({ length: MODEL_PICKER_RECENT_LIMIT }, () => recent(0, reference));
		// Choose a compact input below the cap whose indented persisted representation exceeds it.
		const one = { ...state, recents: { ...state.recents, projects: { "project-0000": records } } };
		const bytesPerProject =
			Buffer.byteLength(JSON.stringify(one, null, 2)) - Buffer.byteLength(JSON.stringify(state, null, 2));
		const count = Math.floor(MODEL_PICKER_STATE_MAX_BYTES / bytesPerProject) + 1;
		assert.ok(count < MODEL_PICKER_PROJECT_HISTORY_LIMIT);
		for (let index = 0; index < count; index++) {
			state.recents.projects[`project-${String(index).padStart(4, "0")}`] = records.map((record) => ({
				...record,
				lastUsedAt: recent(index).lastUsedAt,
			}));
		}
		state.defaults.projects["project-0000"] = { provider: "p", modelId: "saved" };
		assert.ok(Buffer.byteLength(JSON.stringify(state)) < MODEL_PICKER_STATE_MAX_BYTES);
		assert.ok(Buffer.byteLength(JSON.stringify(state, null, 2)) > MODEL_PICKER_STATE_MAX_BYTES);
		const path = writeState(paths, state);
		const saved = new ModelPickerStore(paths).setFilter("all");
		const keys = Object.keys(saved.recents.projects);
		assert.ok(keys.length < count);
		assert.equal(saved.recents.projects["project-0000"], undefined);
		assert.ok(saved.recents.projects[`project-${String(count - 1).padStart(4, "0")}`]);
		assert.deepEqual(saved.defaults, state.defaults);
		assert.ok(statSync(path).size <= MODEL_PICKER_STATE_MAX_BYTES);
		assert.deepEqual(loadModelPickerState(paths).state, saved);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("explicit preferences are not evicted when they alone exceed the serialized byte limit", () => {
	const { root, paths } = context();
	try {
		const state = emptyModelPickerState();
		const favorite = { provider: "日".repeat(512), modelId: "語".repeat(512), addedAt: recent(0).lastUsedAt };
		const one = { ...state, favorites: [favorite] };
		const two = { ...state, favorites: [favorite, favorite] };
		const bytesPerFavorite =
			Buffer.byteLength(JSON.stringify(two, null, 2)) - Buffer.byteLength(JSON.stringify(one, null, 2));
		state.favorites = Array(Math.floor(MODEL_PICKER_STATE_MAX_BYTES / bytesPerFavorite) + 1).fill(favorite);
		const original = JSON.stringify(state);
		assert.ok(Buffer.byteLength(original) < MODEL_PICKER_STATE_MAX_BYTES);
		assert.ok(Buffer.byteLength(JSON.stringify(state, null, 2)) > MODEL_PICKER_STATE_MAX_BYTES);
		const path = writeState(paths, state);
		assert.throws(() => new ModelPickerStore(paths).setFilter("all"), /preferences exceed/);
		assert.equal(readFileSync(path, "utf8"), original);
		assert.deepEqual(readdirSync(paths.stateDir), ["model-picker.json"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("oversized existing state is never read, quarantined, or replaced by a mutation", () => {
	const { root, paths } = context();
	try {
		const path = writeState(paths, emptyModelPickerState());
		truncateSync(path, MODEL_PICKER_STATE_MAX_BYTES + 1);
		for (const recover of [true, false])
			assert.throws(() => loadModelPickerState(paths, { recover }), /exceeds 16 MiB/);
		assert.throws(() => new ModelPickerStore(paths).setFilter("all"), /exceeds 16 MiB/);
		assert.equal(statSync(path).size, MODEL_PICKER_STATE_MAX_BYTES + 1);
		assert.deepEqual(readdirSync(paths.stateDir), ["model-picker.json"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("catalog-qualified references persist and remain distinct across catalogs", () => {
	const { root, paths } = context();
	try {
		const store = new ModelPickerStore(paths);
		const one = {
			catalogId: "ai.example.one",
			offeringId: "offering-1",
			provider: "shared",
			modelId: "same-model",
		};
		const two = { ...one, catalogId: "ai.example.two", offeringId: "offering-2" };
		store.toggleFavorite(one, new Date("2026-08-23T00:00:00.000Z"));
		store.toggleFavorite(two, new Date("2026-08-23T00:00:01.000Z"));
		assert.deepEqual(store.load().state.favorites, [
			{ ...one, addedAt: "2026-08-23T00:00:00.000Z" },
			{ ...two, addedAt: "2026-08-23T00:00:01.000Z" },
		]);
		assert.notEqual(modelReferenceKey(one), modelReferenceKey(two));
		assert.equal(modelReferencesEqual(one, two), false);
		assert.equal(modelReferencesEqual(one, { provider: "shared", modelId: "same-model" }), true);
		assert.throws(
			() => store.toggleFavorite({ catalogId: "ai.example.one", provider: "shared", modelId: "same-model" }),
			ModelPickerStateError,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("project defaults persist separately from favorites", () => {
	const { root, paths } = context();
	try {
		const store = new ModelPickerStore(paths);
		const projectKey = "d".repeat(64);
		const reference = { provider: "anthropic", modelId: "claude-test" };
		store.setProjectDefault(reference, projectKey, new Date("2026-08-23T00:00:00.000Z"));
		assert.deepEqual(store.load().state.defaults.projects[projectKey], reference);
		assert.deepEqual(store.load().state.favorites, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("dispatch records the last used model with its thinking level", () => {
	const { root, paths } = context();
	try {
		const store = new ModelPickerStore(paths);
		const projectKey = "a".repeat(64);
		store.recordDispatch({ provider: "p", modelId: "a" }, projectKey, {
			thinkingLevel: "high",
			now: new Date("2026-08-23T00:00:00.000Z"),
		});
		store.recordDispatch({ provider: "p", modelId: "b" }, projectKey, {
			thinkingLevel: "low",
			now: new Date("2026-08-23T01:00:00.000Z"),
		});
		assert.deepEqual(store.load().state.last, {
			provider: "p",
			modelId: "b",
			usedAt: "2026-08-23T01:00:00.000Z",
			thinkingLevel: "low",
		});
		store.recordDispatch({ provider: "p", modelId: "a" }, projectKey, { now: new Date("2026-08-23T02:00:00.000Z") });
		assert.deepEqual(store.load().state.last, {
			provider: "p",
			modelId: "a",
			usedAt: "2026-08-23T02:00:00.000Z",
		});
		assert.throws(
			() => store.recordDispatch({ provider: "p", modelId: "a" }, projectKey, { thinkingLevel: "ludicrous" }),
			ModelPickerStateError,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("model thinking preferences persist without changing recency or another model's level", () => {
	const { root, paths } = context();
	try {
		const store = new ModelPickerStore(paths);
		const a = { provider: "p", modelId: "a" };
		const b = { provider: "p", modelId: "b" };
		store.setModelThinkingLevel(a, "high");
		assert.equal(store.load().state.last, undefined);
		assert.deepEqual(store.load().state.recents.global, [], "a preference is not a dispatch");
		assert.equal(savedModelThinkingLevel(store.load().state, a), "high");
		store.recordDispatch(a, "project-one", { thinkingLevel: "high" });
		store.recordDispatch(a, "project-two", { thinkingLevel: "high" });
		store.recordDispatch(b, "project-one", { thinkingLevel: "low" });
		const before = store.load().state.recents;
		store.setModelThinkingLevel(a, "max");
		const state = new ModelPickerStore(paths).load().state;
		assert.equal(state.last.thinkingLevel, "low");
		assert.equal(savedModelThinkingLevel(state, a), "max");
		assert.equal(savedModelThinkingLevel(state, b), "low");
		for (const [records, previous] of [
			[state.recents.global, before.global],
			[state.recents.projects["project-one"], before.projects["project-one"]],
			[state.recents.projects["project-two"], before.projects["project-two"]],
		]) {
			assert.deepEqual(
				records,
				previous.map((record) => (record.modelId === "a" ? { ...record, thinkingLevel: "max" } : record)),
			);
		}
		store.setModelThinkingLevel(b, "off");
		assert.equal(store.load().state.last.thinkingLevel, "off");
		store.clearRecents("all");
		assert.equal(
			savedModelThinkingLevel(store.load().state, a),
			"max",
			"clearing recents preserves explicit preferences",
		);
		assert.throws(() => store.setModelThinkingLevel(a, "ludicrous"), ModelPickerStateError);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("saved last model state validates its thinking level", () => {
	const { root, paths } = context();
	try {
		const statePath = join(paths.stateDir, "model-picker.json");
		mkdirSync(paths.stateDir, { recursive: true });
		const base = { ...emptyModelPickerState() };
		writeFileSync(
			statePath,
			JSON.stringify({
				...base,
				last: { provider: "p", modelId: "a", usedAt: "2026-08-23T00:00:00.000Z", thinkingLevel: "ludicrous" },
			}),
		);
		assert.throws(() => loadModelPickerState(paths, { recover: false }), ModelPickerStateError);
		writeFileSync(
			statePath,
			JSON.stringify({
				...base,
				last: { provider: "p", modelId: "a", usedAt: "2026-08-23T00:00:00.000Z", thinkingLevel: "xhigh" },
			}),
		);
		assert.equal(loadModelPickerState(paths).state.last?.thinkingLevel, "xhigh");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("thinking state accepts missing fields and rejects invalid preferences and recent levels", () => {
	const { root, paths } = context();
	try {
		mkdirSync(paths.stateDir, { recursive: true });
		const path = join(paths.stateDir, "model-picker.json");
		const { thinkingLevels: _levels, ...legacy } = emptyModelPickerState();
		const reference = { provider: "p", modelId: "a" };
		writeFileSync(
			path,
			JSON.stringify({ ...legacy, last: { ...reference, usedAt: "2026-08-23T00:00:00.000Z", thinkingLevel: "max" } }),
		);
		assert.equal(savedModelThinkingLevel(loadModelPickerState(paths).state, reference), "max");
		assert.deepEqual(loadModelPickerState(paths).state.thinkingLevels, []);
		for (const fields of [
			{ thinkingLevels: {} },
			{ thinkingLevels: [{ ...reference, thinkingLevel: "invalid" }] },
			{
				recents: {
					global: [{ ...reference, lastUsedAt: "2026-08-23T00:00:00.000Z", useCount: 1, thinkingLevel: "invalid" }],
					projects: {},
				},
			},
		]) {
			writeFileSync(path, JSON.stringify({ ...legacy, ...fields }));
			assert.throws(() => loadModelPickerState(paths, { recover: false }), ModelPickerStateError);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("thinking preferences remain distinct across providers and catalog offerings", () => {
	const { root, paths } = context();
	try {
		const store = new ModelPickerStore(paths);
		const references = [
			{ provider: "one", modelId: "same" },
			{ provider: "two", modelId: "same" },
			{ provider: "shared", modelId: "same", catalogId: "one", offeringId: "model" },
			{ provider: "shared", modelId: "same", catalogId: "two", offeringId: "model" },
		];
		const levels = ["off", "low", "high", "max"];
		for (const [index, reference] of references.entries()) store.setModelThinkingLevel(reference, levels[index]);
		const state = new ModelPickerStore(paths).load().state;
		assert.deepEqual(
			references.map((reference) => savedModelThinkingLevel(state, reference)),
			levels,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the last picker filter persists without changing model preferences", () => {
	const { root, paths } = context();
	try {
		const store = new ModelPickerStore(paths);
		store.setFilter("favorite", new Date("2026-08-23T00:00:00.000Z"));
		assert.equal(store.load().state.filter, "favorite");
		assert.deepEqual(store.load().state.favorites, []);
		assert.deepEqual(store.load().state.defaults.projects, {});
		assert.throws(() => store.setFilter("retired"), ModelPickerStateError);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("state mutations reject model references with terminal controls", () => {
	const { root, paths } = context();
	try {
		const store = new ModelPickerStore(paths);
		const unsafe = { provider: "provider\u009b31m", modelId: "model" };
		const projectKey = "e".repeat(64);
		assert.throws(() => store.setProjectDefault(unsafe, projectKey), ModelPickerStateError);
		assert.throws(() => store.recordDispatch(unsafe, projectKey), ModelPickerStateError);
		assert.throws(() => store.toggleFavorite(unsafe), ModelPickerStateError);
		assert.equal(existsSync(join(paths.stateDir, "model-picker.json")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("favorites are one global list with no project scope", () => {
	const { root, paths } = context();
	try {
		const store = new ModelPickerStore(paths);
		const reference = { provider: "anthropic", modelId: "claude-test" };
		store.toggleFavorite(reference, new Date("2026-08-23T00:00:00.000Z"));
		assert.deepEqual(store.load().state.favorites, [{ ...reference, addedAt: "2026-08-23T00:00:00.000Z" }]);
		const serialized = readFileSync(join(paths.stateDir, "model-picker.json"), "utf8");
		assert.doesNotMatch(serialized, /favoriteScope|projectKey|"scope"/);
		store.toggleFavorite(reference);
		assert.deepEqual(store.load().state.favorites, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("schema 1, 2, and 3 state migrate with legacy model references", () => {
	const { root, paths } = context();
	try {
		mkdirSync(paths.stateDir, { recursive: true });
		for (const schemaVersion of [1, 2, 3]) {
			writeFileSync(
				join(paths.stateDir, "model-picker.json"),
				`${JSON.stringify({
					schemaVersion,
					favorites: [],
					...(schemaVersion >= 2 ? { defaults: { projects: {} } } : {}),
					recents: { global: [], projects: {} },
				})}\n`,
			);
			assert.deepEqual(new ModelPickerStore(paths).load().state, emptyModelPickerState());
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unknown saved filter falls back to Recent without discarding picker state", () => {
	const { root, paths } = context();
	try {
		mkdirSync(paths.stateDir, { recursive: true });
		writeFileSync(
			join(paths.stateDir, "model-picker.json"),
			`${JSON.stringify({
				schemaVersion: 4,
				filter: "retired",
				favorites: [{ provider: "p", modelId: "m", addedAt: "2026-08-23T00:00:00.000Z" }],
				defaults: { projects: {} },
				recents: { global: [], projects: {} },
			})}\n`,
		);
		const state = new ModelPickerStore(paths).load().state;
		assert.equal(state.filter, "recent");
		assert.deepEqual(
			state.favorites.map(({ provider, modelId }) => ({ provider, modelId })),
			[{ provider: "p", modelId: "m" }],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unreadable state is quarantined while symlink state fails closed", { skip: process.platform === "win32" }, () => {
	const { root, paths } = context();
	try {
		const statePath = join(paths.stateDir, "model-picker.json");
		new ModelPickerStore(paths).recordDispatch({ provider: "p", modelId: "m" }, "c".repeat(64), {
			now: new Date("2026-08-23T00:00:00.000Z"),
		});
		writeFileSync(statePath, "{ broken");
		const recovered = loadModelPickerState(paths, { now: new Date("2026-08-23T00:00:01.000Z") });
		assert.deepEqual(recovered.state, emptyModelPickerState());
		assert.ok(recovered.quarantinePath);
		assert.equal(existsSync(recovered.quarantinePath), true);

		const outside = join(root, "outside.json");
		writeFileSync(outside, "{}\n");
		symlinkSync(outside, statePath);
		assert.throws(() => loadModelPickerState(paths), ModelPickerStateError);
		assert.equal(readFileSync(outside, "utf8"), "{}\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("project keys share a git common directory and contain no raw path", () => {
	const one = deriveProjectKey("/work/tree-a", {
		runGit: () => "../repo/.git",
		realpath: () => "/work/repo/.git",
	});
	const two = deriveProjectKey("/work/tree-b", {
		runGit: () => "/work/repo/.git",
		realpath: () => "/work/repo/.git",
	});
	assert.equal(one, two);
	assert.match(one, /^[0-9a-f]{64}$/);
	assert.equal(one.includes("work"), false);
});

test("project default startup yields to explicit, resumed, and scoped model choices", () => {
	assert.equal(projectDefaultAppliesAtStartup([]), true);
	assert.equal(projectDefaultAppliesAtStartup(["hello"]), true);
	for (const args of [
		["--model", "openai/gpt-test"],
		["--model=openai/gpt-test"],
		["--models", "anthropic/*"],
		["--provider", "anthropic"],
		["--provider=anthropic"],
		["--resume"],
		["--continue"],
		["--session", "abc"],
		["--session-id=abc"],
	]) {
		assert.equal(projectDefaultAppliesAtStartup(args), false);
	}
});

test("previous model stack follows branch history without returning stale current state", () => {
	const stack = previousModelStack(
		[
			{ type: "model_change", provider: "p", modelId: "a" },
			{ type: "message", message: { role: "assistant", provider: "p", model: "a" } },
			{ type: "model_change", provider: "p", modelId: "b" },
			{ type: "model_change", provider: "p", modelId: "c" },
			{ type: "model_change", provider: "p", modelId: "a" },
		],
		{ provider: "p", modelId: "a" },
	);
	assert.deepEqual(stack, [
		{ provider: "p", modelId: "c" },
		{ provider: "p", modelId: "b" },
	]);
});
