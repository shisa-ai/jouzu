#!/usr/bin/env node

/**
 * Live first-candidate check for session flow control. Everything else in this subsystem is proven
 * against a scripted provider, so this is the only place a real model's instruction-following is
 * measured: whether it declares a wait from the exact handles a tool returned, leaves that wait
 * intact across a user status turn that provably overlaps the still-running dependency, and
 * receives exactly one composed wake when the dependency ends.
 *
 * Opt-in with post-response usage checks. These thresholds do not cap tokens or spending within
 * an in-flight request. Transport retries may not appear as separate assistant messages.
 * Missing usage fails the check. This script is not a complete live acceptance gate: it does not
 * deliberately exercise redirection or compaction, or observe late wakes after settlement.
 *
 * Stage overlap is controlled, not timed: the dependency job is file-gated and the release file is
 * created only after the status turn has settled, so the status turn provably ran while the
 * dependency was live (the gated job uses POSIX shell syntax, matching the POSIX release
 * environments this smoke runs in). Stage boundaries are correlated to prompt responses and
 * settlement events, and wakes to the declared wait token; raw agent_end counts are never used
 * because retries, compaction, and continuations re-emit them inside one run. Compaction and
 * redirection are recorded as confounders whenever the RPC stream reports them, but they are not
 * deliberately triggered here. Observation ends when the wake turn settles; duplicate delivery
 * after that point is owned by the offline acknowledgment tests.
 *
 * It reports counts, cost, and defect labels; never transcript content.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FLOW_MARKER = "jouzu-flow";
const COMPACT_EVENT_TYPES = new Set(["session_before_compact", "session_compact", "session_compact_failed"]);
const REDIRECTION_COMMANDS = new Set(["steer", "follow_up"]);
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Successful tool completions for `name`, in event order. */
export function successfulToolEnds(events, name) {
	return events.filter((event) => event?.type === "tool_execution_end" && event.toolName === name && !event.isError);
}

/** The token one successful agent_wait result carried, from its details or its result text. */
export function waitTokenFromToolEnd(event) {
	if (event?.type !== "tool_execution_end" || event.toolName !== "agent_wait" || event.isError) return undefined;
	const result = event.result;
	if (!result || typeof result !== "object") return undefined;
	if (TOKEN_PATTERN.test(String(result.details?.token ?? ""))) return result.details.token;
	const text = Array.isArray(result.content) ? result.content[0]?.text : undefined;
	if (typeof text !== "string") return undefined;
	try {
		const token = JSON.parse(text)?.token;
		return TOKEN_PATTERN.test(String(token ?? "")) ? token : undefined;
	} catch {
		return undefined;
	}
}

/** Ordered unique tokens the agent_wait tool handed to the model. */
export function declaredWaitTokens(events) {
	const tokens = [];
	for (const event of events) {
		const token = waitTokenFromToolEnd(event);
		if (token && !tokens.includes(token)) tokens.push(token);
	}
	return tokens;
}

/** One composed flow input frame: {"flowInput":["jouzu-flow",attempt,id,rev],"kind":"wait",...}. */
function wakeFrameFromMessage(event) {
	if (event?.type !== "message_start" && event?.type !== "message_end") return undefined;
	const message = event.message;
	if (message?.role !== "user" || !Array.isArray(message.content)) return undefined;
	for (const part of message.content) {
		if (part?.type !== "text" || typeof part.text !== "string") continue;
		let frame;
		try {
			frame = JSON.parse(part.text);
		} catch {
			continue;
		}
		const marker = frame?.flowInput;
		if (!Array.isArray(marker) || marker[0] !== FLOW_MARKER || frame.kind !== "wait") continue;
		let decision;
		try {
			decision = JSON.parse(frame.content);
		} catch {
			continue;
		}
		const token = decision?.wait?.token;
		if (!TOKEN_PATTERN.test(String(token ?? ""))) continue;
		return { token, marker: JSON.stringify(marker) };
	}
	return undefined;
}

/**
 * Composed wake deliveries, correlated by flow marker so message_start and message_end for one
 * delivery count once. Each entry is one wait decision the controller sent as user input.
 */
export function composedWakeFrames(events) {
	const frames = new Map();
	for (const [index, event] of events.entries()) {
		const frame = wakeFrameFromMessage(event);
		if (frame && !frames.has(frame.marker)) frames.set(frame.marker, { ...frame, index });
	}
	return [...frames.values()];
}

/**
 * Ongoing request, token, and cost accounting over finalized assistant messages. Usage is only
 * observable after a response. This guard fails observed threshold excesses and responses whose
 * cost cannot be verified; it cannot bound in-flight spending or count hidden transport retries.
 */
export function createUsageAccountant({ maxRequests, maxTokens, maxUsd }) {
	for (const [name, value] of [
		["maxRequests", maxRequests],
		["maxTokens", maxTokens],
		["maxUsd", maxUsd],
	]) {
		if (!Number.isFinite(value) || value <= 0) throw new Error(`usage accounting requires a positive ${name} ceiling`);
	}
	let requests = 0;
	let tokens = 0;
	let costUsd = 0;
	let costKnown = true;
	return {
		observe(event) {
			if (event?.type !== "message_end" || event.message?.role !== "assistant") return { ok: true };
			requests += 1;
			const usage = event.message.usage;
			const cost = usage?.cost?.total;
			if (!usage || !Number.isFinite(usage.totalTokens) || !Number.isFinite(cost)) {
				costKnown = false;
				return {
					ok: false,
					failure: "unknown-cost",
					message: `provider response ${requests} reported no verifiable usage cost`,
				};
			}
			tokens += usage.totalTokens;
			costUsd += cost;
			if (requests > maxRequests)
				return { ok: false, failure: "request-ceiling", message: `request ceiling exceeded at ${requests} requests` };
			if (tokens > maxTokens)
				return { ok: false, failure: "token-ceiling", message: `token ceiling exceeded at ${tokens} tokens` };
			if (costUsd > maxUsd)
				return { ok: false, failure: "usd-ceiling", message: `accounted cost ${costUsd} exceeded ceiling ${maxUsd}` };
			return { ok: true };
		},
		snapshot() {
			return { requests, tokens, costUsd, costKnown, maxRequests, maxTokens, maxUsd };
		},
	};
}

/**
 * Defect analysis over one RPC event stream. Stages are correlated to their prompt responses and
 * settlement events, wakes to the declared wait token. `releaseIndex` is the event count when the
 * dependency's release file was created, so any wake before it proves misordering, and tool calls
 * before it happened while the dependency was provably still live.
 */
export function analyzeFlowEvents(events, { promptIds, releaseIndex }) {
	if (!Array.isArray(promptIds) || promptIds.length !== 2)
		throw new Error("flow analysis expects the declare and status prompt ids");
	if (!Number.isInteger(releaseIndex) || releaseIndex < 0)
		throw new Error("flow analysis requires the event count at dependency release");
	const defects = [];
	const stageOf = (id) => {
		const response = events.findIndex(
			(event) => event?.type === "response" && event.id === id && event.command === "prompt",
		);
		const settled =
			response >= 0 ? events.findIndex((event, index) => index > response && event?.type === "agent_settled") : -1;
		return { response, settled, accepted: response >= 0 && events[response]?.success === true };
	};
	const declare = stageOf(promptIds[0]);
	const status = stageOf(promptIds[1]);
	for (const [id, stage] of [
		[promptIds[0], declare],
		[promptIds[1], status],
	]) {
		if (!stage.accepted) defects.push(`unanswered-prompt-${id}`);
		else if (stage.settled < 0) defects.push(`unsettled-prompt-${id}`);
	}
	const endIndexes = (name) =>
		events
			.map((event, index) => ({ event, index }))
			.filter(({ event }) => event?.type === "tool_execution_end" && event.toolName === name && !event.isError)
			.map(({ index }) => index);
	const between = (indexes, from, to) => indexes.filter((index) => index > from && index < to);
	const waitEnds = endIndexes("agent_wait");
	const taskEnds = endIndexes("bg_task");
	const cancelEnds = endIndexes("agent_wait_cancel");
	const resultEnds = endIndexes("agent_results");
	const tokens = declaredWaitTokens(events);
	const token = tokens[0];
	const declareEnd = declare.settled >= 0 ? declare.settled : events.length;
	const statusEnd = status.settled >= 0 ? status.settled : events.length;

	if (!token) defects.push("missing-wait-declaration");
	if (between(taskEnds, 0, releaseIndex).length !== 1)
		defects.push(`background-task-count-${between(taskEnds, 0, releaseIndex).length}`);
	if (resultEnds.some((index) => index < releaseIndex)) defects.push("polled-results");
	if (cancelEnds.length) defects.push("cancelled-wait");
	if (
		declare.accepted &&
		new Set(between(waitEnds, declare.response, declareEnd).map((index) => waitTokenFromToolEnd(events[index]))).size >
			1
	)
		defects.push("declared-multiple-waits");
	if (status.accepted && between(waitEnds, status.response, statusEnd).length)
		defects.push("redeclared-wait-on-status-turn");
	if (
		declare.settled >= 0 &&
		between(waitEnds, declareEnd, events.length).some((index) => waitTokenFromToolEnd(events[index]) !== token)
	)
		defects.push("renewed-wait-token");

	const wakes = composedWakeFrames(events);
	const declaredWakes = wakes.filter((wake) => wake.token === token);
	if (wakes.some((wake) => wake.index < releaseIndex)) defects.push("wake-before-release");
	if (declaredWakes.length === 0) defects.push("missing-composed-wake");
	if (declaredWakes.length > 1) defects.push("duplicate-composed-wake");
	if (token && wakes.some((wake) => wake.token !== token)) defects.push("unexpected-wake-token");

	const settledRuns = events.filter((event) => event?.type === "agent_settled").length;
	if (settledRuns !== promptIds.length + 1) defects.push(`settled-run-count-${settledRuns}`);
	const compactionEvents = events.filter((event) => COMPACT_EVENT_TYPES.has(event?.type)).length;
	if (compactionEvents) defects.push("compaction-during-flow");
	const redirectionInputs =
		events.filter((event) => event?.type === "response" && REDIRECTION_COMMANDS.has(event.command)).length +
		events.filter((event) => event?.type === "input" && event.streamingBehavior === "steer").length;
	if (redirectionInputs) defects.push("redirection-input");
	return {
		defects,
		summary: {
			settledRuns,
			backgroundTasks: taskEnds.length,
			waitDeclarations: waitEnds.length,
			waitCancellations: cancelEnds.length,
			resultQueries: resultEnds.length,
			waitTokens: tokens,
			composedWakes: wakes.map((wake) => wake.token),
			compactionEvents,
			redirectionInputs,
		},
	};
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: resolve(import.meta.dirname, ".."),
		encoding: "utf8",
		timeout: 300_000,
		maxBuffer: 16 * 1024 * 1024,
		...options,
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${command} exited ${result.status}: ${result.stderr || result.stdout}`);
	return result;
}

function scrubbedHarnessEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key === "AI_AGENT" || /^JOUZU_/.test(key) || /^PI_CODING_AGENT(?:_|$)/.test(key)) continue;
		env[key] = value;
	}
	return env;
}

/** One RPC session driven prompt by prompt, so a status turn can land while a wait is live. */
class LiveSession {
	events = [];
	#child;
	#buffer = "";
	#failure;
	constructor({ cli, jouzuHome, cwd, provider, model, onEvent }) {
		this.#child = spawn(
			process.execPath,
			[
				cli,
				"--jouzu-home",
				jouzuHome,
				"--jouzu-profile",
				"core",
				"--mode",
				"rpc",
				"--no-session",
				"--no-context-files",
				"--no-approve",
				"--provider",
				provider,
				"--model",
				model,
				"--tools",
				"bg_task,agent_wait,agent_wait_cancel,agent_results",
			],
			{
				cwd,
				env: { ...scrubbedHarnessEnv(), JOUZU_HOME: jouzuHome, JOUZU_NO_UPDATE: "1", JOUZU_FLOW_CONTROL: "1" },
			},
		);
		this.#child.stdout.on("data", (chunk) => {
			this.#buffer += chunk;
			for (let index = this.#buffer.indexOf("\n"); index >= 0; index = this.#buffer.indexOf("\n")) {
				const line = this.#buffer.slice(0, index);
				this.#buffer = this.#buffer.slice(index + 1);
				if (!line.trim()) continue;
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					this.#failure ??= new Error("live flow smoke received an unparseable RPC line");
					continue;
				}
				this.events.push(event);
				try {
					const observed = onEvent?.(event);
					if (observed && !observed.ok) this.#failure ??= new Error(observed.message);
				} catch (error) {
					this.#failure ??= error instanceof Error ? error : new Error(String(error));
				}
			}
		});
		this.#child.stderr.on("data", () => {});
	}
	prompt(id, message) {
		this.#throwIfFailed();
		this.#child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
	}
	/** Resolve once `predicate` holds, so each stage waits for evidence rather than a fixed delay. */
	async until(predicate, label, timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			this.#throwIfFailed();
			if (predicate(this.events)) return;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		this.#throwIfFailed();
		throw new Error(`live flow smoke timed out waiting for ${label}`);
	}
	#throwIfFailed() {
		if (this.#failure) throw this.#failure;
	}
	close() {
		this.#child.stdin.end();
		this.#child.kill("SIGKILL");
	}
}

const responseIndexOf = (events, id) =>
	events.findIndex((event) => event.type === "response" && event.id === id && event.command === "prompt");
const settledAfter = (events, from) => events.some((event, index) => index > from && event.type === "agent_settled");

async function runLiveFlowSmoke({ provider, model, budget, maxRequests, maxTokens }) {
	const temp = mkdtempSync(resolve(tmpdir(), "jouzu-live-flow-"));
	const project = resolve(temp, "project");
	const release = resolve(project, "release");
	const accountant = createUsageAccountant({ maxRequests, maxTokens, maxUsd: budget });
	const digest = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
	let session;
	try {
		mkdirSync(project, { recursive: true });
		let tarball = process.env.JOUZU_PACKED_TARBALL;
		if (!tarball) {
			run("npm", ["run", "build"]);
			const packed = JSON.parse(
				run("npm", ["pack", "--workspace", "jouzu", "--ignore-scripts", "--json", "--pack-destination", temp]).stdout,
			)[0];
			tarball = resolve(temp, packed.filename);
		}
		tarball = resolve(tarball);
		const artifactIntegrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
		run("npm", [
			"install",
			"--prefix",
			resolve(temp, "consumer"),
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			tarball,
		]);
		const cli = resolve(temp, "consumer", "node_modules", "jouzu", "dist", "cli.js");
		session = new LiveSession({
			cli,
			jouzuHome: resolve(temp, "jouzu-home"),
			cwd: project,
			provider,
			model,
			onEvent: (event) => accountant.observe(event),
		});

		// Stage 1: the model must spawn the gated job and declare a wait from its tool's handles.
		session.prompt(
			"declare",
			[
				"Start a background task that runs exactly this shell command:",
				"for i in $(seq 1 1800); do [ -f release ] && break; sleep 1; done; echo swept",
				"Then, before ending your turn, call agent_wait for that task using the exact producer,",
				"handle, execution and until values its tool result printed. Use a 30m deadline.",
				"Do not poll and do not run any other tool.",
			].join("\n"),
		);
		await session.until(
			(events) => responseIndexOf(events, "declare") >= 0,
			"the declaring prompt to be accepted",
			120_000,
		);
		assert.equal(
			session.events[responseIndexOf(session.events, "declare")].success,
			true,
			`declaring prompt was rejected: ${session.events[responseIndexOf(session.events, "declare")].error}`,
		);
		await session.until(
			(events) => successfulToolEnds(events, "bg_task").length > 0,
			"the background task to start",
			120_000,
		);
		await session.until((events) => declaredWaitTokens(events).length > 0, "a declared wait", 120_000);
		await session.until(
			(events) => settledAfter(events, responseIndexOf(events, "declare")),
			"the declaring turn to settle",
			120_000,
		);
		const token = declaredWaitTokens(session.events)[0];
		assert.ok(token, "no wait token was declared");

		// Stage 2: a user status question must not redeclare, renew, or cancel the live wait. The
		// dependency cannot have ended here: its release file does not exist yet.
		session.prompt("status", "Briefly: what are you waiting on right now? Do not change anything.");
		await session.until(
			(events) => responseIndexOf(events, "status") >= 0,
			"the status prompt to be accepted",
			120_000,
		);
		const statusResponse = session.events[responseIndexOf(session.events, "status")];
		assert.equal(statusResponse.success, true, `status prompt was rejected: ${statusResponse.error}`);
		await session.until(
			(events) => settledAfter(events, responseIndexOf(events, "status")),
			"the status turn to settle while the dependency job is still gated",
			120_000,
		);

		// Stage 3: release the dependency, and its decision must arrive as one wake for the declared
		// token. releaseIndex records that every earlier event happened before the job could end.
		const releaseIndex = session.events.length;
		writeFileSync(release, "");
		await session.until(
			(events) => composedWakeFrames(events).some((wake) => wake.token === token && wake.index >= releaseIndex),
			"the composed wake after the job is released",
			180_000,
		);
		const wake = composedWakeFrames(session.events).find(
			(candidate) => candidate.token === token && candidate.index >= releaseIndex,
		);
		await session.until((events) => settledAfter(events, wake.index), "the wake turn to settle", 180_000);

		const { defects, summary } = analyzeFlowEvents(session.events, {
			promptIds: ["declare", "status"],
			releaseIndex,
		});
		const accounting = accountant.snapshot();
		if (!accounting.costKnown)
			throw new Error("live flow smoke cannot verify cost: a provider response reported no finite usage cost");
		if (accounting.costUsd > budget)
			throw new Error(`live flow smoke cost ${accounting.costUsd} exceeded budget ${budget}`);
		console.log(
			JSON.stringify(
				{
					schemaVersion: 2,
					qualification:
						"incomplete: late-wake observation, deliberate redirection, and compaction acceptance remain open",
					artifactIntegrity,
					provider,
					model,
					budget: {
						usdCeiling: budget,
						requestCeiling: maxRequests,
						tokenCeiling: maxTokens,
						requests: accounting.requests,
						tokens: accounting.tokens,
						costUsd: accounting.costUsd,
						costKnown: accounting.costKnown,
						limitation:
							"Usage is checked after each assistant response. These thresholds do not cap in-flight tokens or spending, and transport retries may not appear as separate assistant messages.",
					},
					turns: summary.settledRuns,
					backgroundTasks: summary.backgroundTasks,
					waitDeclarations: summary.waitDeclarations,
					waitCancellations: summary.waitCancellations,
					resultQueries: summary.resultQueries,
					waitTokenDigests: summary.waitTokens.map(digest),
					composedWakes: summary.composedWakes.map(digest),
					compactionEvents: summary.compactionEvents,
					redirectionInputs: summary.redirectionInputs,
					defects,
					status: defects.length ? "defects" : "passed",
				},
				null,
				2,
			),
		);
		if (defects.length) process.exitCode = 1;
	} finally {
		try {
			// End the gated job promptly even when a stage failed, before tearing down its directory.
			writeFileSync(release, "");
		} catch {
			/* The job never started or its project directory is already gone. */
		}
		session?.close();
		rmSync(temp, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.env.JOUZU_LIVE_SMOKE !== "1") throw new Error("live smoke is opt-in; set JOUZU_LIVE_SMOKE=1");
		const provider = process.env.JOUZU_LIVE_PROVIDER;
		const model = process.env.JOUZU_LIVE_MODEL;
		if (!provider || !model) throw new Error("set JOUZU_LIVE_PROVIDER and JOUZU_LIVE_MODEL");
		const budget = Number(process.env.JOUZU_LIVE_MAX_USD);
		if (!Number.isFinite(budget) || budget <= 0 || budget > 0.25)
			throw new Error("set JOUZU_LIVE_MAX_USD to a positive release-smoke budget no greater than 0.25");
		const ceiling = (name, fallback, bound) => {
			const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
			if (!Number.isFinite(value) || value <= 0 || value > bound)
				throw new Error(`set ${name} to a positive ceiling no greater than ${bound}`);
			return value;
		};
		await runLiveFlowSmoke({
			provider,
			model,
			budget,
			maxRequests: ceiling("JOUZU_LIVE_MAX_REQUESTS", 24, 1000),
			maxTokens: ceiling("JOUZU_LIVE_MAX_TOKENS", 250_000, 10_000_000),
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
