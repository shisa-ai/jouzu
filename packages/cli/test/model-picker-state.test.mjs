import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	deriveProjectKey,
	emptyModelPickerState,
	loadModelPickerState,
	MODEL_PICKER_RECENT_LIMIT,
	ModelPickerStateError,
	ModelPickerStore,
	previousModelStack,
	projectDefaultAppliesAtStartup,
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
			store.recordDispatch(
				{ provider: "provider", modelId: `model-${index}` },
				projectKey,
				new Date(Date.UTC(2026, 7, 23, 0, 0, index)),
			);
		}
		store.recordDispatch(
			{ provider: "provider", modelId: "model-5" },
			projectKey,
			new Date("2026-08-23T01:00:00.000Z"),
		);

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

test("schema 1 and 2 state migrate with the Recent filter", () => {
	const { root, paths } = context();
	try {
		mkdirSync(paths.stateDir, { recursive: true });
		for (const schemaVersion of [1, 2]) {
			writeFileSync(
				join(paths.stateDir, "model-picker.json"),
				`${JSON.stringify({
					schemaVersion,
					favorites: [],
					...(schemaVersion === 2 ? { defaults: { projects: {} } } : {}),
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
				schemaVersion: 3,
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
		new ModelPickerStore(paths).recordDispatch(
			{ provider: "p", modelId: "m" },
			"c".repeat(64),
			new Date("2026-08-23T00:00:00.000Z"),
		);
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
