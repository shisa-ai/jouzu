import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJouzuModelPicker } from "../dist/model-picker.js";
import { deriveProjectKey, ModelPickerStore, savedModelThinkingLevel } from "../dist/model-picker-state.js";
import { resolveJouzuPaths } from "../dist/paths.js";

function harness(root, options = {}, { delayThinking = false } = {}) {
	const paths = resolveJouzuPaths({ homeOverride: join(root, "home") });
	const store = new ModelPickerStore(paths);
	const projectKey = deriveProjectKey(root);
	const models = ["a", "b", "plain"].map((id) => ({
		provider: "p",
		id,
		name: id,
		reasoning: id !== "plain",
		contextWindow: 100_000,
		maxTokens: 10_000,
	}));
	const handlers = new Map();
	const notifications = [];
	const thinkingNotifications = [];
	const ctx = {
		mode: "tui",
		cwd: root,
		model: models[0],
		thinkingLevel: "medium",
		scopedModels: [],
		sessionManager: { getBranch: () => [] },
		modelRegistry: { find: (provider, id) => models.find((model) => model.provider === provider && model.id === id) },
		ui: { notify: (...args) => notifications.push(args) },
	};
	const emit = (name, event) => handlers.get(name)?.(event, ctx);
	const api = {
		on: (name, handler) => handlers.set(name, handler),
		setThinkingLevel(level) {
			const previousLevel = ctx.thinkingLevel;
			ctx.thinkingLevel = ctx.model.reasoning ? level : "off";
			if (previousLevel !== ctx.thinkingLevel) {
				const event = { level: ctx.thinkingLevel, previousLevel };
				if (delayThinking) thinkingNotifications.push(event);
				else void emit("thinking_level_select", event);
			}
		},
		async setModel(model, source = "set") {
			const previousModel = ctx.model;
			ctx.model = model;
			// Match Pi: apply the incoming model's default before model_select.
			api.setThinkingLevel(ctx.scopedModels.find((entry) => entry.model === model)?.thinkingLevel ?? "medium");
			if (previousModel !== model) await emit("model_select", { model, previousModel, source });
			return true;
		},
	};
	const integration = createJouzuModelPicker(paths, options);
	integration.extension.factory(api);
	return {
		paths,
		store,
		projectKey,
		models,
		ctx,
		api,
		emit,
		notifications,
		async flushThinking() {
			for (const event of thinkingNotifications.splice(0)) await emit("thinking_level_select", event);
		},
	};
}

for (const explicit of [false, true]) {
	test(`project-default startup restores its own reasoning preference; explicit=${explicit}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "jouzu-thinking-startup-"));
		try {
			const h = harness(root, {
				applyProjectDefaultAtStartup: true,
				restoreLastModelAtStartup: true,
				restoreLastThinkingLevelAtStartup: !explicit,
			});
			const a = { provider: "p", modelId: "a" };
			h.store.recordDispatch(a, h.projectKey, { thinkingLevel: "high" });
			h.store.setProjectDefault(a, h.projectKey);
			h.store.recordDispatch({ provider: "p", modelId: "b" }, h.projectKey, { thinkingLevel: "low" });
			h.ctx.model = h.models[1];
			h.ctx.thinkingLevel = "off";
			await h.emit("session_start", { reason: "startup" });
			assert.equal(h.ctx.model.id, "a");
			assert.equal(h.ctx.thinkingLevel, explicit ? "off" : "high");
			assert.equal(savedModelThinkingLevel(h.store.load().state, a), "high");
			assert.deepEqual(h.notifications, []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

test("delayed thinking notifications do not persist a startup flag as a model preference", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-thinking-delayed-"));
	try {
		const h = harness(
			root,
			{ restoreLastModelAtStartup: true, restoreLastThinkingLevelAtStartup: false },
			{ delayThinking: true },
		);
		const b = { provider: "p", modelId: "b" };
		h.store.recordDispatch(b, h.projectKey, { thinkingLevel: "high" });
		h.ctx.thinkingLevel = "off";
		await h.emit("session_start", { reason: "startup" });
		await h.flushThinking();
		assert.equal(h.ctx.thinkingLevel, "off");
		assert.equal(savedModelThinkingLevel(h.store.load().state, b), "high");
		assert.deepEqual(h.store.load().state.thinkingLevels, []);
		h.api.setThinkingLevel("low");
		await h.flushThinking();
		assert.equal(savedModelThinkingLevel(h.store.load().state, b), "low", "later user overrides still save");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("reasoning changes survive model cycling, non-reasoning models, and restart before dispatch", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-thinking-cycle-"));
	try {
		const h = harness(root);
		await h.emit("session_start", { reason: "startup" });
		h.api.setThinkingLevel("max");
		await h.api.setModel(h.models[1], "cycle");
		h.api.setThinkingLevel("low");
		await h.api.setModel(h.models[2], "cycle");
		assert.equal(h.ctx.thinkingLevel, "off");
		await h.api.setModel(h.models[0], "cycle");
		assert.equal(h.ctx.thinkingLevel, "max");
		await h.api.setModel(h.models[1]);
		assert.equal(h.ctx.thinkingLevel, "low");
		assert.deepEqual(h.store.load().state.recents.global, [], "switches must not count as requests");
		await h.emit("before_provider_request", {});
		assert.equal(h.store.load().state.recents.global[0].thinkingLevel, "low");
		assert.equal(h.store.load().state.recents.projects[h.projectKey][0].thinkingLevel, "low");
		h.api.setThinkingLevel("off");
		assert.equal(h.store.load().state.recents.global[0].thinkingLevel, "off");
		const restarted = harness(root, { restoreLastModelAtStartup: true });
		await restarted.emit("session_start", { reason: "startup" });
		assert.equal(restarted.ctx.model.id, "b");
		assert.equal(restarted.ctx.thinkingLevel, "off");
		await restarted.api.setModel(restarted.models[0], "cycle");
		assert.equal(restarted.ctx.thinkingLevel, "max");
		assert.deepEqual([...h.notifications, ...restarted.notifications], []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("switching restores reasoning recorded in recents without an explicit preference", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-thinking-recents-"));
	try {
		const h = harness(root);
		h.store.recordDispatch({ provider: "p", modelId: "a" }, h.projectKey, { thinkingLevel: "high" });
		h.store.recordDispatch({ provider: "p", modelId: "b" }, h.projectKey, { thinkingLevel: "low" });
		await h.emit("session_start", { reason: "startup" });
		await h.api.setModel(h.models[1], "cycle");
		assert.equal(h.ctx.thinkingLevel, "low");
		await h.api.setModel(h.models[0], "cycle");
		assert.equal(h.ctx.thinkingLevel, "high");
		assert.deepEqual(h.store.load().state.thinkingLevels, [], "restoration must not create an explicit override");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resume, model restore, and scoped reasoning pins retain precedence", async () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-thinking-precedence-"));
	try {
		const h = harness(root, { restoreLastModelAtStartup: true });
		h.store.recordDispatch({ provider: "p", modelId: "b" }, h.projectKey, { thinkingLevel: "high" });
		await h.emit("session_start", { reason: "resume" });
		assert.equal(h.ctx.model.id, "a");
		assert.equal(h.ctx.thinkingLevel, "medium");
		await h.api.setModel(h.models[1], "restore");
		assert.equal(h.ctx.thinkingLevel, "medium");
		await h.api.setModel(h.models[0]);
		h.ctx.scopedModels = [{ model: h.models[1], thinkingLevel: "low" }];
		await h.api.setModel(h.models[1], "cycle");
		assert.equal(h.ctx.thinkingLevel, "low");
		assert.equal(savedModelThinkingLevel(h.store.load().state, { provider: "p", modelId: "b" }), "high");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
