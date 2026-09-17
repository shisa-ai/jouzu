import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
	CAMOUFOX_IDLE_STOP_MS,
	createCamoufoxIdleStop,
	createJouzuCamoufoxExtension,
	lazyTool,
	resolveCamoufoxRuntimePaths,
	resolveJouzuCamoufoxIdleStopMs,
} from "../dist/camoufox-adapter.js";

const textOf = (result) =>
	result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");

test("the idle-stop delay defaults to five minutes", () => {
	assert.equal(CAMOUFOX_IDLE_STOP_MS, 300_000);
	assert.equal(resolveJouzuCamoufoxIdleStopMs({}), CAMOUFOX_IDLE_STOP_MS);
	assert.equal(resolveJouzuCamoufoxIdleStopMs({ JOUZU_CAMOUFOX_IDLE_STOP_MS: "" }), CAMOUFOX_IDLE_STOP_MS);
	assert.equal(resolveJouzuCamoufoxIdleStopMs({ JOUZU_CAMOUFOX_IDLE_STOP_MS: "   " }), CAMOUFOX_IDLE_STOP_MS);
});

test("the idle-stop delay accepts an explicit millisecond override", () => {
	assert.equal(resolveJouzuCamoufoxIdleStopMs({ JOUZU_CAMOUFOX_IDLE_STOP_MS: "90000" }), 90_000);
	assert.equal(resolveJouzuCamoufoxIdleStopMs({ JOUZU_CAMOUFOX_IDLE_STOP_MS: " 20000 " }), 20_000);
	assert.equal(resolveJouzuCamoufoxIdleStopMs({ JOUZU_CAMOUFOX_IDLE_STOP_MS: "1000" }), 1_000);
});

test("zero disables the idle stop", () => {
	assert.equal(resolveJouzuCamoufoxIdleStopMs({ JOUZU_CAMOUFOX_IDLE_STOP_MS: "0" }), 0);
});

test("an invalid idle-stop delay is rejected with the variable name", () => {
	for (const value of ["soon", "-5", "1.5", "999", "10 seconds", "1e-3"]) {
		assert.throws(
			() => resolveJouzuCamoufoxIdleStopMs({ JOUZU_CAMOUFOX_IDLE_STOP_MS: value }),
			(error) => error instanceof Error && error.message.includes("JOUZU_CAMOUFOX_IDLE_STOP_MS"),
			`value ${JSON.stringify(value)} must be rejected`,
		);
	}
});

const makeScheduler = () => {
	const timers = [];
	return {
		timers,
		schedule(fire, delayMs) {
			const timer = { fire, delayMs, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
	};
};

test("a settled browser call arms one idle timer for the full delay", () => {
	const scheduler = makeScheduler();
	const idleStop = createCamoufoxIdleStop({ timeoutMs: 5_000, scheduler, stop: () => {} });
	idleStop.onCallSettled();
	assert.equal(scheduler.timers.length, 1);
	assert.equal(scheduler.timers[0].delayMs, 5_000);
	assert.equal(scheduler.timers[0].cancelled, false);
});

test("a re-armed settle cancels the previous timer", () => {
	const scheduler = makeScheduler();
	const idleStop = createCamoufoxIdleStop({ timeoutMs: 5_000, scheduler, stop: () => {} });
	idleStop.onCallSettled();
	idleStop.onCallSettled();
	assert.equal(scheduler.timers.length, 2);
	assert.equal(scheduler.timers[0].cancelled, true);
	assert.equal(scheduler.timers[1].cancelled, false);
});

test("a browser call start cancels the pending idle timer", () => {
	const scheduler = makeScheduler();
	const idleStop = createCamoufoxIdleStop({ timeoutMs: 5_000, scheduler, stop: () => {} });
	idleStop.onCallSettled();
	idleStop.onCallStart();
	assert.equal(scheduler.timers[0].cancelled, true);
	assert.equal(scheduler.timers.length, 1);
});

test("an idle fire stops the browser once and arms nothing new", () => {
	const scheduler = makeScheduler();
	const stops = [];
	const idleStop = createCamoufoxIdleStop({ timeoutMs: 5_000, scheduler, stop: () => stops.push(1) });
	idleStop.onCallSettled();
	scheduler.timers[0].fire();
	assert.equal(stops.length, 1);
	assert.equal(scheduler.timers.length, 1, "stopping must not arm another timer");
});

test("a defensive fire during an in-flight call re-arms instead of stopping", () => {
	const scheduler = makeScheduler();
	const stops = [];
	const idleStop = createCamoufoxIdleStop({ timeoutMs: 5_000, scheduler, stop: () => stops.push(1) });
	idleStop.onCallSettled();
	idleStop.onCallStart();
	scheduler.timers[0].fire();
	assert.equal(stops.length, 0);
	assert.equal(scheduler.timers.length, 2);
	assert.equal(scheduler.timers[1].delayMs, 5_000);
});

test("close cancels the pending timer and blocks further arming", () => {
	const scheduler = makeScheduler();
	const idleStop = createCamoufoxIdleStop({ timeoutMs: 5_000, scheduler, stop: () => {} });
	idleStop.onCallSettled();
	idleStop.close();
	assert.equal(scheduler.timers[0].cancelled, true);
	idleStop.onCallSettled();
	assert.equal(scheduler.timers.length, 1, "arming after close must be blocked");
});

test("a disabled idle stop never arms a timer", () => {
	const scheduler = makeScheduler();
	const idleStop = createCamoufoxIdleStop({ timeoutMs: 0, scheduler, stop: () => {} });
	idleStop.onCallSettled();
	idleStop.onCallSettled();
	assert.equal(scheduler.timers.length, 0);
});

const lifecycle = (events) => ({
	onCallStart: () => events.push("start"),
	onCallSettled: () => events.push("settled"),
});

const fetchDelegateResult = () => ({
	content: [{ type: "text", text: "fetch https://example.com → 200 (8 markdown bytes)" }],
	details: { url: "https://example.com", status: 200, format: "markdown", markdown: "# Fetched", bytes: 8 },
});

test("lazyTool reports a delegate call through both lifecycle hooks", async () => {
	const events = [];
	const tool = lazyTool(
		{ name: "tff-fetch_url", label: "Fetch URL", description: "Fetch a URL.", parameters: {} },
		async () => ({
			execute: async () => {
				events.push("delegate");
				return fetchDelegateResult();
			},
		}),
		lifecycle(events),
	);
	const result = await tool.execute("call-1", {}, undefined, undefined, undefined);
	assert.deepEqual(events, ["start", "delegate", "settled"]);
	assert.ok(textOf(result).includes("# Fetched"), "projection must still run with hooks");
});

test("lazyTool settles its hooks when the delegate rejects", async () => {
	const events = [];
	const tool = lazyTool(
		{ name: "tff-fetch_url", label: "Fetch URL", description: "Fetch a URL.", parameters: {} },
		async () => ({
			execute: async () => {
				throw new Error("navigation failed");
			},
		}),
		lifecycle(events),
	);
	await assert.rejects(() => tool.execute("call-1", {}, undefined, undefined, undefined), /navigation failed/);
	assert.deepEqual(events, ["start", "settled"]);
});

test("lazyTool settles its hooks when the delegate cannot be resolved", async () => {
	const events = [];
	const tool = lazyTool(
		{ name: "tff-fetch_url", label: "Fetch URL", description: "Fetch a URL.", parameters: {} },
		async () => {
			throw new Error("runtime unavailable");
		},
		lifecycle(events),
	);
	await assert.rejects(() => tool.execute("call-1", {}, undefined, undefined, undefined), /runtime unavailable/);
	assert.deepEqual(events, ["start", "settled"]);
});

// ---------------------------------------------------------------- fixtures

const sha512 = (contents) => createHash("sha512").update(contents).digest("base64");

const camoufoxFake = {
	pkgman: [
		"export function camoufoxPath() {",
		"	return '/tmp/fake-camoufox';",
		"}",
		"export class CamoufoxFetcher {",
		"	async install() {}",
		"}",
	].join("\n"),
	client: [
		"export const clients = [];",
		"export const closedClients = [];",
		"export class CamoufoxClient {",
		"	constructor(options) {",
		"		this.options = options;",
		"		this.config = { headless: true };",
		"		clients.push(this);",
		"	}",
		"	async close() {",
		"		closedClients.push(this);",
		"	}",
		"}",
		"export function createAllTools() {",
		"	return [",
		"		{",
		"			name: 'tff-fetch_url',",
		"			async execute(_toolCallId, params) {",
		"				return {",
		"					content: [{ type: 'text', text: 'fetch ok' }],",
		"					details: {",
		"						url: params.url,",
		"						status: 200,",
		"						format: 'markdown',",
		"						markdown: '# Fetched',",
		"						bytes: 8,",
		"					},",
		"				};",
		"			},",
		"		},",
		"		{",
		"			name: 'tff-search_web',",
		"			async execute() {",
		"				return {",
		"					content: [{ type: 'text', text: 'search ok' }],",
		"					details: { engine: 'duckduckgo', results: [{ rank: 1, title: 'T', url: 'https://example.com', snippet: 'S' }] },",
		"				};",
		"			},",
		"		},",
		"	];",
		"}",
		"export const __test_wrapTool__ = (definition) => definition;",
	].join("\n"),
	camoufoxJs: ["export const launchOptions = async () => ({});"].join("\n"),
	playwright: [
		"export const firefox = {",
		"	launch: async () => ({ newContext: async () => ({}), version: () => 'fake' }),",
		"};",
	].join("\n"),
	database: ["export default class Database {", "	constructor() {}", "	close() {}", "}", ""].join("\n"),
};

/** Materialize a fake but lock-exact Camoufox runtime that the adapter accepts as installed. */
function writeFakeRuntime(stateDir) {
	const paths = resolveCamoufoxRuntimePaths(stateDir);
	const bundled = (name) => readFileSync(new URL(`../camoufox-runtime/${name}`, import.meta.url));
	const manifest = JSON.parse(bundled("package.json"));
	const lock = JSON.parse(bundled("package-lock.json"));
	mkdirSync(paths.installRoot, { recursive: true });
	writeFileSync(paths.packageJson, bundled("package.json"));
	writeFileSync(paths.lockfile, bundled("package-lock.json"));
	writeFileSync(
		paths.receipt,
		`${JSON.stringify(
			{
				schemaVersion: 1,
				runtime: manifest.name,
				version: manifest.version,
				packageSha512: sha512(bundled("package.json")),
				lockSha512: sha512(bundled("package-lock.json")),
			},
			null,
			2,
		)}\n`,
	);
	const packageDir = (name, files) => {
		const root = join(paths.installRoot, "node_modules", ...name.split("/"));
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name, version: lock.packages[`node_modules/${name}`].version, main: "index.js" }),
		);
		for (const [relativePath, contents] of Object.entries(files)) {
			const target = join(root, relativePath);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, `${contents}\n`);
		}
	};
	packageDir("@the-forge-flow/camoufox-pi", { "index.js": camoufoxFake.client });
	packageDir("camoufox-js", {
		"index.js": camoufoxFake.camoufoxJs,
		"dist/pkgman.js": camoufoxFake.pkgman,
	});
	packageDir("playwright-core", { "index.js": camoufoxFake.playwright });
	packageDir("better-sqlite3", { "lib/index.js": camoufoxFake.database });
	packageDir("@sinclair/typebox", {});
	packageDir("impit", {});
	packageDir("ua-parser-js", {});
	return paths;
}

const fakeCamoufoxPi = (stateDir) =>
	import(
		pathToFileURL(
			join(
				resolveCamoufoxRuntimePaths(stateDir).installRoot,
				"node_modules",
				"@the-forge-flow",
				"camoufox-pi",
				"index.js",
			),
		).href
	);

const waitForClosedClients = async (camoufoxPi, count, deadlineMs = 1_000) => {
	const deadline = Date.now() + deadlineMs;
	while (camoufoxPi.closedClients.length < count && Date.now() < deadline) {
		await delay(10);
	}
};

const extensionHarness = () => {
	const tools = new Map();
	const handlers = new Map();
	const timers = [];
	const pi = {
		registerTool: (tool) => tools.set(tool.name, tool),
		on: (event, handler) => handlers.set(event, handler),
	};
	const scheduleIdleStop = (fire, delayMs) => {
		const timer = { fire, delayMs, cancelled: false };
		timers.push(timer);
		return () => {
			timer.cancelled = true;
		};
	};
	return { tools, handlers, timers, pi, scheduleIdleStop };
};

test("an idle stop closes the loaded browser and a later call reloads it", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "jouzu-camoufox-idle-"));
	const { tools, handlers, timers, pi, scheduleIdleStop } = extensionHarness();
	try {
		writeFakeRuntime(stateDir);
		createJouzuCamoufoxExtension(pi, stateDir, { idleStopTimeoutMs: 60_000, scheduleIdleStop });
		const fetch = tools.get("tff-fetch_url");

		const first = await fetch.execute("call-1", { url: "https://example.com" }, undefined, undefined, undefined);
		assert.ok(textOf(first).includes("# Fetched"), "the first call must project the fetched body");
		assert.equal(timers.length, 1, "a settled call arms one idle timer");
		assert.equal(timers[0].delayMs, 60_000);
		const camoufoxPi = await fakeCamoufoxPi(stateDir);
		assert.equal(camoufoxPi.clients.length, 1);

		timers[0].fire();
		await waitForClosedClients(camoufoxPi, 1);
		assert.equal(camoufoxPi.closedClients.length, 1, "the idle stop must close the browser");
		assert.equal(timers.length, 1, "stopping must not arm another timer");

		const second = await fetch.execute("call-2", { url: "https://example.com/2" }, undefined, undefined, undefined);
		assert.ok(textOf(second).includes("# Fetched"), "the call after the idle stop must succeed");
		assert.equal(camoufoxPi.clients.length, 2, "the next call must reload a fresh client");
		assert.equal(camoufoxPi.closedClients.length, 1);
		assert.equal(timers.length, 2, "the settled reload arms a new idle timer");
		assert.equal(timers[1].delayMs, 60_000);
		assert.equal(timers[1].cancelled, false, "the reload's idle timer must stay armed");

		await handlers.get("session_shutdown")();
		assert.equal(camoufoxPi.closedClients.length, 2, "session shutdown must close the reloaded browser");
		assert.equal(timers[1].cancelled, true, "session shutdown must disarm the pending idle timer");
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a disabled idle stop never stops the loaded browser", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "jouzu-camoufox-idle-off-"));
	const { tools, timers, pi, scheduleIdleStop } = extensionHarness();
	process.env.JOUZU_CAMOUFOX_IDLE_STOP_MS = "0";
	try {
		writeFakeRuntime(stateDir);
		createJouzuCamoufoxExtension(pi, stateDir, { scheduleIdleStop });
		const fetch = tools.get("tff-fetch_url");
		const result = await fetch.execute("call-1", { url: "https://example.com" }, undefined, undefined, undefined);
		assert.ok(textOf(result).includes("# Fetched"));
		assert.equal(timers.length, 0, "a disabled idle stop must not arm a timer");
		const camoufoxPi = await fakeCamoufoxPi(stateDir);
		assert.equal(camoufoxPi.clients.length, 1);
		assert.equal(camoufoxPi.closedClients.length, 0);
	} finally {
		delete process.env.JOUZU_CAMOUFOX_IDLE_STOP_MS;
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("the default scheduler stops the browser after the configured delay", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "jouzu-camoufox-idle-real-"));
	const { tools, handlers, pi } = extensionHarness();
	process.env.JOUZU_CAMOUFOX_IDLE_STOP_MS = "1000";
	try {
		writeFakeRuntime(stateDir);
		createJouzuCamoufoxExtension(pi, stateDir);
		const fetch = tools.get("tff-fetch_url");
		await fetch.execute("call-1", { url: "https://example.com" }, undefined, undefined, undefined);
		const camoufoxPi = await fakeCamoufoxPi(stateDir);
		assert.equal(camoufoxPi.clients.length, 1);
		const deadline = Date.now() + 4_000;
		while (camoufoxPi.closedClients.length === 0 && Date.now() < deadline) {
			await delay(50);
		}
		assert.equal(camoufoxPi.closedClients.length, 1, "the production timer did not stop the browser");
		await handlers.get("session_shutdown")();
	} finally {
		delete process.env.JOUZU_CAMOUFOX_IDLE_STOP_MS;
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("an invalid idle-stop environment value fails extension creation eagerly", () => {
	const stateDir = mkdtempSync(join(tmpdir(), "jouzu-camoufox-idle-invalid-"));
	const { pi } = extensionHarness();
	process.env.JOUZU_CAMOUFOX_IDLE_STOP_MS = "soon";
	try {
		assert.throws(
			() => createJouzuCamoufoxExtension(pi, stateDir),
			(error) => error instanceof Error && error.message.includes("JOUZU_CAMOUFOX_IDLE_STOP_MS"),
			"an invalid delay must fail extension creation",
		);
	} finally {
		delete process.env.JOUZU_CAMOUFOX_IDLE_STOP_MS;
		rmSync(stateDir, { recursive: true, force: true });
	}
});
