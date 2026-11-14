import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCatalog } from "../dist/locale-catalog.js";
import {
	buildSessionStatusSections,
	collectSessionWork,
	formatStatusCost,
	providerLabel,
	renderSessionStatus,
} from "../dist/session-status.js";

const PROVIDER = "catalog:ai.shisa.api-router:Shisa%20AI:57024af9495fc6b0";
const SESSION = "01a1d958-4168-714e-8007-4aab8ed91721";
const T0 = Date.parse("2026-11-14T05:00:00Z");
const en = resolveCatalog("en").bundle;
const scope = { sessionId: SESSION, branchId: "leaf" };

const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const message = (role, minutes, extra = {}) => ({
	type: "message",
	timestamp: at(minutes),
	message: { role, ...extra },
});
const usage = (input, output, cacheRead, total) => ({ input, output, cacheRead, cacheWrite: 0, cost: { total } });

function sessionContext(branch, overrides = {}) {
	return {
		cwd: "/home/user/niri",
		model: { provider: PROVIDER, id: "office-pool/gpt-6-astra", name: "GPT-6 Astra", contextWindow: 272_000 },
		thinkingLevel: "medium",
		scopedModels: [],
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 98_400, contextWindow: 272_000, percent: 36.18 }),
		modelRegistry: {
			find: (_provider, id) =>
				({
					"office-pool/gpt-6-astra": { name: "GPT-6 Astra" },
					"office-pool/gpt-6-astra-mini": { name: "GPT-6 Astra Mini" },
				})[id],
		},
		sessionManager: {
			getSessionId: () => SESSION,
			getLeafId: () => "leaf",
			getSessionName: () => "fix status layout",
			getBranch: () => branch,
			getHeader: () => ({ timestamp: at(0) }),
			buildSessionProjection: () => ({ messages: [] }),
		},
		...overrides,
	};
}

const runtime = { jouzuVersion: "0.2.5", piVersion: "1.5.0", profileId: "core", profileApplied: true };

function run(overrides = {}) {
	return {
		id: "run-1",
		parentSessionId: SESSION,
		role: { id: "explorer" },
		model: { provider: PROVIDER, id: "office-pool/gpt-6-astra-mini", name: "GPT-6 Astra Mini" },
		task: "look around",
		status: "running",
		createdAt: at(0),
		updatedAt: at(1),
		usage: { input: 5000, output: 1000, cacheRead: 20_000, cacheWrite: 0, cost: 0.01, costSource: "estimate" },
		...overrides,
	};
}

function flowSource(status, extra = {}) {
	return {
		enabled: () => true,
		status: async () => status,
		jobs: () => [],
		tasks: () => [],
		...extra,
	};
}

const emptyFlowStatus = {
	scope,
	held: [],
	retryable: [],
	waiting: [],
	uncertain: [],
	active: [],
	suspended: [],
	unaccountable: [],
};

test("provider labels decode catalog runtime keys and keep other providers unchanged", () => {
	assert.equal(providerLabel(PROVIDER), "Shisa AI");
	assert.equal(providerLabel("anthropic"), "anthropic");
});

test("status cost uses the status bar's estimate and incomplete markers", () => {
	assert.equal(formatStatusCost({ cost: null, costEstimated: false, costComplete: true }), undefined);
	assert.equal(formatStatusCost({ cost: 0, costEstimated: false, costComplete: true }), "$0.000");
	assert.equal(formatStatusCost({ cost: 0.4213, costEstimated: true, costComplete: false }), "~$0.421 + ?");
});

test("the report shows identity, git state, activity, usage, and a per-model split", () => {
	const branch = [
		message("user", 0),
		message("assistant", 1, {
			provider: PROVIDER,
			model: "office-pool/gpt-6-astra",
			content: [{ type: "toolCall" }, { type: "toolCall" }],
			usage: usage(2000, 800, 30_000, 0.12),
		}),
		message("toolResult", 2),
		{ type: "compaction", timestamp: at(3), usage: usage(100, 0, 0, 0.001) },
		message("user", 4),
		message("assistant", 38, {
			provider: PROVIDER,
			model: "office-pool/gpt-6-astra-mini",
			content: [{ type: "text" }],
			usage: usage(1000, 300, 9000, 0.02),
		}),
	];
	const snapshot = {
		git: {
			status: "known",
			observedAt: 0,
			value: { branch: "main", dirty: true, ahead: 2, behind: 0 },
		},
	};
	const text = renderSessionStatus(
		buildSessionStatusSections({
			ctx: sessionContext(branch),
			catalog: en,
			runtime,
			snapshot,
			agentRuns: [run(), run({ id: "other", parentSessionId: "someone-else" })],
			now: T0 + 38 * 60_000,
		}),
	);
	const lines = text.split("\n");
	assert.equal(lines[0], "Jouzu session status");
	assert.match(
		text,
		/\nSession +01a1d958-4168-714e-8007-4aab8ed91721\n +“fix status layout” · started \d{4}-\d\d-\d\d \d\d:\d\d \(38 min ago\)\n/,
	);
	assert.match(text, /\nWorkspace +niri · main · uncommitted changes ↑2\n/);
	assert.match(text, /\nModel +GPT-6 Astra {2}office-pool\/gpt-6-astra\n +Shisa AI · thinking medium\n/);
	assert.match(text, /\nActivity +2 prompts · 2 replies · 2 tool calls · 1 compaction\n/);
	assert.match(text, /\nContext +98k\/272k tokens \(36%\)\n/);
	assert.match(text, /\nUsage +42k in \(93% cached\) · 1\.1k out · ~\$0\.141\n/);
	assert.match(text, /\nBy model +GPT-6 Astra {2}office-pool\/gpt-6-astra · 1 reply · ↑32k ↓800 · ~\$0\.120\n/);
	assert.match(text, /\n +GPT-6 Astra Mini {2}office-pool\/gpt-6-astra-mini · 1 reply · ↑10k ↓300 · ~\$0\.020\n/);
	// Subagent runs are separate sessions: they get their own rows and stay out of the session total.
	assert.match(text, /\n +GPT-6 Astra Mini {2}office-pool\/gpt-6-astra-mini · 1 subagent run · ↑25k ↓1k · ~\$0\.010\n/);
	assert.equal(text.match(/subagent run/g).length, 1);
	assert.match(text, /\nProvider +catalog:ai\.shisa\.api-router:Shisa%20AI:57024af9495fc6b0\n/);
	// Values start in one column after the widest label.
	const valueColumn = (label) => {
		const line = lines.find((candidate) => candidate.startsWith(label));
		return label.length + line.slice(label.length).search(/\S/);
	};
	assert.equal(new Set(["Session", "Workspace", "Model", "By model", "Runtime"].map(valueColumn)).size, 1);
});

test("a single-model session shows no per-model split and a model without a name shows its ID", () => {
	const branch = [
		message("user", 0),
		message("assistant", 1, { provider: "local", model: "qwen", content: [], usage: usage(10, 5, 0, 0) }),
	];
	const text = renderSessionStatus(
		buildSessionStatusSections({
			ctx: sessionContext(branch, {
				model: { provider: "local", id: "qwen", name: "qwen", contextWindow: 32_000 },
				modelRegistry: { find: () => undefined },
			}),
			catalog: en,
			runtime,
		}),
	);
	assert.match(text, /\nModel +qwen\n +local · thinking medium\n/);
	assert.doesNotMatch(text, /By model/);
	// A placeholder zero is not a cost.
	assert.match(text, /\nUsage +10 in \(0% cached\) · 5 out\n/);
});

test("work collection counts producers and lists items that need attention with their commands", async () => {
	const work = await collectSessionWork(
		scope,
		{
			agentRuns: () => ({
				sessionId: SESSION,
				runs: [run(), run({ id: "done", status: "completed", completion: { revision: "r1", handled: false } })],
			}),
			flow: flowSource(
				{ ...emptyFlowStatus, held: [{}], waiting: [{}, {}], uncertain: [{}], active: [{}] },
				{
					jobs: () => [
						{ id: "j1", sessionId: SESSION, status: "running" },
						{ id: "j2", sessionId: SESSION, status: "completed", updatedAt: T0 },
						{ id: "j3", sessionId: "other", status: "running" },
					],
					tasks: () => [
						{ taskId: "1", subject: "a", status: "pending", state: "active" },
						{ taskId: "2", subject: "b", status: "completed", state: "completed" },
					],
				},
			),
			textguard: () => ({ mode: "guarded", pending: 2 }),
		},
		en,
	);
	assert.equal(work.known, true);
	assert.equal(work.agentsActive, 1);
	assert.equal(work.jobsRunning, 1);
	assert.deepEqual([work.tasksOpen, work.tasksTotal], [1, 2]);
	assert.deepEqual(work.flow, { enabled: true, campaigns: 1, waits: 2, suspended: 0 });
	assert.deepEqual(
		work.attention.map((item) => [item.action, item.text, item.route]),
		[
			[true, "1 held message", "/flow"],
			[true, "1 turn with unknown outcome", "/flow"],
			[true, "2 TextGuard reviews pending", "/textguard"],
			[false, "1 subagent result not yet delivered", "/workflow"],
			[false, "1 job result not yet delivered", "/bg"],
		],
	);
	const text = renderSessionStatus(buildSessionStatusSections({ ctx: sessionContext([]), catalog: en, runtime, work }));
	assert.match(
		text,
		/\nWork +1 subagent active · 1 background job running · 1 of 2 tasks open · 1 campaign active · 2 waits\n/,
	);
	assert.match(text, /\nFlow control +on\n/);
	assert.match(text, /\nTextGuard +guarded\n/);
	assert.match(text, /\nNeeds attention +! 1 held message {2}\/flow\n/);
	assert.match(text, /\n +· 1 job result not yet delivered {2}\/bg\n/);
});

test("idle and paused work states are stated rather than left blank", async () => {
	const idle = await collectSessionWork(scope, { flow: flowSource(emptyFlowStatus) }, en);
	let text = renderSessionStatus(
		buildSessionStatusSections({ ctx: sessionContext([]), catalog: en, runtime, work: idle }),
	);
	assert.match(text, /\nWork +Nothing running or queued\n/);
	assert.doesNotMatch(text, /Needs attention/);

	const paused = await collectSessionWork(
		scope,
		{ flow: flowSource({ ...emptyFlowStatus, paused: "provider error" }) },
		en,
	);
	text = renderSessionStatus(
		buildSessionStatusSections({ ctx: sessionContext([]), catalog: en, runtime, work: paused }),
	);
	assert.match(text, /\nFlow control +paused: provider error\n/);

	const off = await collectSessionWork(scope, { flow: flowSource(undefined, { enabled: () => false }) }, en);
	assert.deepEqual(off.flow, { enabled: false, campaigns: 0, waits: 0, suspended: 0 });
	text = renderSessionStatus(buildSessionStatusSections({ ctx: sessionContext([]), catalog: en, runtime, work: off }));
	assert.match(text, /\nFlow control +off\n/);
});

test("a flow status read failure leaves counts at zero instead of failing the command", async () => {
	const work = await collectSessionWork(
		scope,
		{ flow: flowSource(undefined, { status: async () => Promise.reject(new Error("ledger unreadable")) }) },
		en,
	);
	assert.deepEqual(work.flow, { enabled: true, campaigns: 0, waits: 0, suspended: 0 });
	assert.deepEqual(work.attention, []);
});

test("subagent runs from another session or an unattached manager are not counted", async () => {
	const unattached = await collectSessionWork(
		scope,
		{ agentRuns: () => ({ sessionId: undefined, runs: [run()] }) },
		en,
	);
	assert.equal(unattached.known, false);
	assert.equal(unattached.agentsActive, 0);
});

test("the ja report uses catalog labels and composition", async () => {
	const ja = resolveCatalog("ja").bundle;
	const branch = [
		message("user", 0),
		message("assistant", 1, {
			provider: PROVIDER,
			model: "office-pool/gpt-6-astra",
			content: [],
			usage: usage(100, 10, 900, 0.01),
		}),
	];
	const text = renderSessionStatus(buildSessionStatusSections({ ctx: sessionContext(branch), catalog: ja, runtime }));
	assert.match(text, /\n使用量 +入力 1k（キャッシュ 90%） · 出力 10 · ~\$0\.010\n/);
	assert.match(text, /\nプロファイル +core（適用済み）\n/);
	assert.doesNotMatch(text, /Session|Usage|Profile|replies|prompts/);
});
