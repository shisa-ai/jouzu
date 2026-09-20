import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CacheWarmer,
	getCacheWarmingDelayMs,
	getPromptCacheTtlMs,
	isReplayable,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/cache-warmer.js";
import { deferred } from "../../../scripts/fixtures/pi-flow-session.mjs";
import { assembledSession } from "./fixtures/flow-assembly.mjs";

const model = {
	api: "openai-completions",
	provider: "fixture",
	id: "fixture",
	promptCache: { short: 300, long: 3600 },
	cost: { input: 10, output: 1, cacheRead: 1, cacheWrite: 0 },
};
function fixture(t, { mode = "streaming", tokens = 100_000, decide, result } = {}) {
	const calls = [],
		entries = [];
	const usage = {
		input: 0,
		output: 1,
		cacheRead: tokens,
		cacheWrite: 0,
		totalTokens: tokens + 1,
		cost: { input: 0, output: 0.000001, cacheRead: tokens / 1e6, cacheWrite: 0, total: tokens / 1e6 + 0.000001 },
	};
	const runtime = {
		streamSimple(...args) {
			calls.push(args);
			return {
				result: () =>
					result
						? result(args)
						: Promise.resolve({ provider: model.provider, model: model.id, stopReason: "length", usage }),
			};
		},
	};
	const session = {
		getBranch: () => [
			{ type: "message", message: { role: "assistant", usage: { input: tokens, cacheRead: 0, cacheWrite: 0 } } },
		],
		appendUsage(...args) {
			entries.push(args);
			return args;
		},
	};
	const warmer = new CacheWarmer(runtime, session, () => mode, decide);
	t.after(() => warmer.cancel());
	const request = {
		model,
		context: { messages: [{ role: "user", content: "fixture" }], tools: [] },
		options: { sessionId: "fixture", cacheRetention: "short", maxTokens: 512, maxRetries: 7 },
	};
	return {
		warmer,
		request,
		calls,
		entries,
		setMode(value) {
			mode = value;
		},
		async refresh() {
			const run = warmer.run;
			assert.ok(run);
			clearTimeout(run.timer);
			await warmer.refresh(run);
		},
	};
}

test("warming eligibility requires a known TTL, replayable thinking, and expected savings", async (t) => {
	assert.equal(getCacheWarmingDelayMs(10_000), undefined);
	assert.equal(getCacheWarmingDelayMs(300_000), 270_000);
	assert.equal(getCacheWarmingDelayMs(11_000), 1000);
	assert.equal(getPromptCacheTtlMs(model, { cacheRetention: "long" }), 3_600_000);
	assert.equal(getPromptCacheTtlMs(model, { cacheRetention: "none" }), undefined);
	assert.equal(getPromptCacheTtlMs({ ...model, promptCache: undefined }), undefined);
	assert.equal(isReplayable({ ...model, api: "anthropic-messages" }, { reasoning: "high" }), false);
	assert.equal(
		isReplayable(
			{ ...model, api: "anthropic-messages", compat: { forceAdaptiveThinking: true } },
			{ reasoning: "high" },
		),
		true,
	);
	for (const tokens of [0, 1, 100_000]) {
		const f = fixture(t, { tokens });
		f.warmer.start(f.request, () => true);
		await f.refresh();
		assert.equal(f.calls.length, tokens === 100_000 ? 1 : 0);
	}
});

test("zero-price models do not warm automatically; extension overrides remain explicit", async (t) => {
	for (const force of [false, true]) {
		const f = fixture(t, { decide: force ? async () => "warm" : undefined });
		f.request.model = { ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		f.warmer.start(f.request, () => true);
		await f.refresh();
		assert.equal(f.calls.length, force ? 1 : 0);
		if (force) assert.equal(f.entries[0][4], "extension override");
	}
});

test("refresh caps output and retries, records separate usage, and stops on settle", async (t) => {
	const f = fixture(t);
	f.warmer.start(f.request, () => true);
	await f.refresh();
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0][1], f.request.context);
	assert.equal(f.calls[0][2].maxTokens, 1);
	assert.equal(f.calls[0][2].maxRetries, 0);
	assert.equal(f.calls[0][2].sessionId, "fixture");
	assert.equal(f.entries[0][0], "cache_warm");
	f.warmer.onAgentSettled();
	assert.equal(f.warmer.run, undefined);
	assert.equal(f.calls[0][2].signal.aborted, true);
});

test("mode off, changed context, and fixed safety windows stop refreshes", async (t) => {
	for (const reason of ["off", "context", "age", "idle-age"]) {
		const f = fixture(t, { mode: reason === "idle-age" ? "idle" : "streaming" });
		let current = true;
		f.warmer.start(f.request, () => current);
		if (reason === "off") {
			f.setMode("off");
			f.warmer.onModeChanged();
		}
		if (reason === "context") {
			current = false;
			await f.refresh();
		}
		if (reason === "age") {
			clearTimeout(f.warmer.run.timer);
			f.warmer.run.startedAt = Date.now() - 3_600_000;
			f.warmer.schedule(f.warmer.run);
		}
		if (reason === "idle-age") {
			f.warmer.run.startedAt = Date.now() - 1_800_000;
			f.warmer.onAgentSettled();
		}
		assert.equal(f.warmer.run, undefined, reason);
		assert.equal(f.calls.length, 0, reason);
	}
});

test("replacement cancels an in-flight refresh and ignores its late usage", async (t) => {
	const gate = deferred();
	const f = fixture(t, { result: () => gate.promise });
	f.warmer.start(f.request, () => true);
	const refreshing = f.refresh();
	await Promise.resolve();
	assert.equal(f.calls.length, 1);
	const previousSignal = f.calls[0][2].signal;
	f.warmer.start(f.request, () => true);
	assert.equal(previousSignal.aborted, true);
	gate.resolve({ stopReason: "stop", usage: {} });
	await refreshing;
	assert.equal(f.entries.length, 0);
	assert.equal(f.warmer.status.state, "scheduled");
});

test("refresh failure does not add usage and can be cancelled", async (t) => {
	for (const outcome of ["error", "aborted", "throw"]) {
		const f = fixture(t, {
			result: async () => {
				if (outcome === "throw") throw Error("fixture");
				return { stopReason: outcome };
			},
		});
		f.warmer.start(f.request, () => true);
		await f.refresh();
		assert.equal(f.entries.length, 0);
		assert.equal(f.warmer.status.state, "scheduled");
		f.warmer.cancel();
		assert.equal(f.warmer.run, undefined);
	}
});

test("parent warming cannot reuse a conversational payload admission", async (t) => {
	const entered = deferred(),
		release = deferred();
	let first = true;
	const f = await assembledSession(t, {
		producerExtensions: [
			(pi) => {
				pi.on("cache_warming_decision", () => ({ action: "warm" }));
				pi.registerTool({
					name: "warming_probe",
					label: "Probe",
					description: "Hold the fixture turn",
					parameters: { type: "object", properties: {} },
					async execute() {
						entered.resolve();
						await release.promise;
						return { content: [{ type: "text", text: "ok" }], details: {} };
					},
				});
			},
		],
		script: () => {
			if (!first) return { text: "done" };
			first = false;
			return { toolCalls: [{ id: "probe", name: "warming_probe", arguments: {} }] };
		},
	});
	f.session.agent.state.model = { ...f.session.model, promptCache: { short: 300 } };
	const warmer = f.session._cacheWarmer;
	const runtime = warmer.models;
	let warmResult;
	warmer.models = {
		streamSimple(...args) {
			const response = runtime.streamSimple(...args);
			return {
				async result() {
					warmResult = await response.result();
					return warmResult;
				},
			};
		},
	};
	const prompt = f.session.prompt("Run warming_probe then finish.");
	try {
		await entered.promise;
		const run = warmer.run;
		assert.ok(run);
		clearTimeout(run.timer);
		await warmer.refresh(run);
		assert.equal(warmResult.stopReason, "error");
		assert.match(warmResult.errorMessage, /Native payload admission was repeated or outlived its request/);
		assert.equal(f.bodies.length, 1, "a repeated admission must not send another provider request");
		assert.equal(f.sessionManager.getEntries().filter((entry) => entry.type === "usage").length, 0);
	} finally {
		release.resolve();
		await prompt;
	}
	assert.equal(f.bodies.length, 2);
	assert.equal(f.session.messages.at(-1).stopReason, "stop");
	assert.equal(warmer.run, undefined);
});
