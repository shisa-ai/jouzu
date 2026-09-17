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
	for (const value of [
		"soon",
		"-5",
		"1.5",
		"999",
		"10 seconds",
		"1e-3",
		"1e4",
		"0x10",
		"+1000",
		"1e21",
		"2147483648",
	]) {
		assert.throws(
			() => resolveJouzuCamoufoxIdleStopMs({ JOUZU_CAMOUFOX_IDLE_STOP_MS: value }),
			(error) => error instanceof Error && error.message.includes("JOUZU_CAMOUFOX_IDLE_STOP_MS"),
			`value ${JSON.stringify(value)} must be rejected`,
		);
	}
});

test("the idle-stop delay accepts the full timer-safe range", () => {
	assert.equal(resolveJouzuCamoufoxIdleStopMs({ JOUZU_CAMOUFOX_IDLE_STOP_MS: "1000" }), 1_000);
	assert.equal(resolveJouzuCamoufoxIdleStopMs({ JOUZU_CAMOUFOX_IDLE_STOP_MS: "2147483647" }), 2_147_483_647);
});

const makeScheduler = () => {
	const timers = [];
	const schedule = (fire, delayMs) => {
		const timer = { delayMs, cancelled: false, fired: false };
		timer.fire = () => {
			timer.fired = true;
			fire();
		};
		timers.push(timer);
		return () => {
			timer.cancelled = true;
		};
	};
	// A fired timer is spent; an armed timer can still stop the browser.
	const armed = () => timers.filter((timer) => !timer.cancelled && !timer.fired);
	return { timers, schedule, armed };
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

test("a stale timer fire is ignored after a newer timer is armed", () => {
	const scheduler = makeScheduler();
	const stops = [];
	const idleStop = createCamoufoxIdleStop({ timeoutMs: 5_000, scheduler, stop: () => stops.push(1) });
	idleStop.onCallSettled();
	idleStop.onCallStart();
	idleStop.onCallSettled();
	scheduler.timers[0].fire();
	assert.equal(stops.length, 0, "a stale fire must not stop the browser");
	assert.equal(scheduler.armed().length, 1, "the stale fire must not consume the live timer");
	scheduler.timers[1].fire();
	assert.equal(stops.length, 1, "the live timer must still stop the browser");
});

test("a fire after close is ignored", () => {
	const scheduler = makeScheduler();
	const stops = [];
	const idleStop = createCamoufoxIdleStop({ timeoutMs: 5_000, scheduler, stop: () => stops.push(1) });
	idleStop.onCallSettled();
	idleStop.close();
	scheduler.timers[0].fire();
	assert.equal(stops.length, 0, "a fire after close must not stop the browser");
});

test("open re-enables arming for a session that reuses the extension", () => {
	const scheduler = makeScheduler();
	const stops = [];
	const idleStop = createCamoufoxIdleStop({ timeoutMs: 5_000, scheduler, stop: () => stops.push(1) });
	idleStop.onCallSettled();
	idleStop.close();
	idleStop.onCallSettled();
	assert.equal(scheduler.timers.length, 1, "arming must stay blocked before open");
	idleStop.open();
	idleStop.onCallSettled();
	assert.equal(scheduler.timers.length, 2, "open must re-enable arming");
	scheduler.timers[1].fire();
	assert.equal(stops.length, 1);
});

test("a stale fire is ignored after open resets the timer generation", () => {
	const scheduler = makeScheduler();
	const stops = [];
	const idleStop = createCamoufoxIdleStop({ timeoutMs: 5_000, scheduler, stop: () => stops.push(1) });
	idleStop.onCallSettled();
	idleStop.close();
	idleStop.open();
	scheduler.timers[0].fire();
	assert.equal(stops.length, 0, "a pre-close fire must be ignored after open");
});

test("open resets an in-flight count a shutdown left behind", () => {
	const scheduler = makeScheduler();
	const stops = [];
	const idleStop = createCamoufoxIdleStop({ timeoutMs: 5_000, scheduler, stop: () => stops.push(1) });
	idleStop.onCallStart();
	idleStop.close();
	idleStop.open();
	idleStop.onCallSettled();
	scheduler.timers.at(-1).fire();
	assert.equal(stops.length, 1, "open must restore a working stop path");
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
		"export const pendingCloseReleases = [];",
		"let closeMode = 'immediate';",
		"export function setCloseMode(mode) {",
		"	closeMode = mode;",
		"}",
		"export function releasePendingCloses() {",
		"	for (const release of pendingCloseReleases.splice(0)) release();",
		"}",
		"let nextClientId = 1;",
		"export class CamoufoxClient {",
		"	constructor(options) {",
		"		this.options = options;",
		"		this.config = { headless: true };",
		"		this.id = nextClientId++;",
		"		clients.push(this);",
		"	}",
		"	async close() {",
		"		if (closeMode === 'defer') {",
		"			await new Promise((release) => pendingCloseReleases.push(release));",
		"		}",
		"		closedClients.push(this);",
		"	}",
		"}",
		"export function createAllTools(service) {",
		"	const servedBy = () => service.getClient().id;",
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
		"						servedBy: servedBy(),",
		"					},",
		"				};",
		"			},",
		"		},",
		"		{",
		"			name: 'tff-search_web',",
		"			async execute() {",
		"				return {",
		"					content: [{ type: 'text', text: 'search ok' }],",
		"					details: {",
		"						engine: 'duckduckgo',",
		"						results: [{ rank: 1, title: 'T', url: 'https://example.com', snippet: 'S' }],",
		"						servedBy: servedBy(),",
		"					},",
		"				};",
		"			},",
		"		},",
		"	];",
		"}",
		"export const __test_wrapTool__ = (definition) => ({ execute: definition.execute });",
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
		const timer = { delayMs, cancelled: false, fired: false };
		timer.fire = () => {
			timer.fired = true;
			fire();
		};
		timers.push(timer);
		return () => {
			timer.cancelled = true;
		};
	};
	// A fired timer is spent; an armed timer can still stop the browser.
	const armed = () => timers.filter((timer) => !timer.cancelled && !timer.fired);
	return { tools, handlers, timers, armed, pi, scheduleIdleStop };
};

test("an idle stop closes the loaded browser and a later call reloads it", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "jouzu-camoufox-idle-"));
	const { tools, handlers, timers, armed, pi, scheduleIdleStop } = extensionHarness();
	try {
		writeFakeRuntime(stateDir);
		createJouzuCamoufoxExtension(pi, stateDir, { idleStopTimeoutMs: 60_000, scheduleIdleStop });
		const fetch = tools.get("tff-fetch_url");

		const first = await fetch.execute("call-1", { url: "https://example.com" }, undefined, undefined, undefined);
		assert.ok(textOf(first).includes("# Fetched"), "the first call must project the fetched body");
		assert.equal(first.details.servedBy, 1, "the first call must serve from the first client");
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
		assert.equal(second.details.servedBy, 2, "the reload must serve from a fresh client, not the stale delegate");
		assert.equal(camoufoxPi.clients.length, 2, "the next call must reload a fresh client");
		assert.equal(camoufoxPi.closedClients.length, 1);
		assert.equal(timers.length, 2, "the settled reload arms a new idle timer");
		assert.equal(timers[1].delayMs, 60_000);
		assert.equal(timers[1].cancelled, false, "the reload's idle timer must stay armed");

		await handlers.get("session_shutdown")();
		assert.equal(camoufoxPi.closedClients.length, 2, "session shutdown must close the reloaded browser");
		assert.equal(armed().length, 0, "session shutdown must leave no armed idle timer");
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

test("a call that lands during an in-flight idle-stop close serves a fresh client", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "jouzu-camoufox-idle-race-"));
	const { tools, handlers, timers, pi, scheduleIdleStop } = extensionHarness();
	try {
		writeFakeRuntime(stateDir);
		const camoufoxPi = await fakeCamoufoxPi(stateDir);
		camoufoxPi.setCloseMode("defer");
		createJouzuCamoufoxExtension(pi, stateDir, { idleStopTimeoutMs: 60_000, scheduleIdleStop });
		const fetch = tools.get("tff-fetch_url");
		const first = await fetch.execute("call-1", { url: "https://example.com" }, undefined, undefined, undefined);
		assert.equal(first.details.servedBy, 1);

		timers[0].fire();
		const second = await fetch.execute("call-2", { url: "https://example.com/2" }, undefined, undefined, undefined);
		assert.equal(
			second.details.servedBy,
			2,
			"the synchronous reset must serve a fresh client before the old close finishes",
		);
		assert.equal(camoufoxPi.closedClients.length, 0, "the stopped client's close must still be in flight");

		camoufoxPi.releasePendingCloses();
		await waitForClosedClients(camoufoxPi, 1);
		assert.equal(camoufoxPi.closedClients.length, 1);
		camoufoxPi.setCloseMode("immediate");
		await handlers.get("session_shutdown")();
		assert.equal(camoufoxPi.closedClients.length, 2);
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("session_shutdown waits for an idle-stop close still in flight", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "jouzu-camoufox-idle-drain-"));
	const { tools, handlers, timers, pi, scheduleIdleStop } = extensionHarness();
	try {
		writeFakeRuntime(stateDir);
		const camoufoxPi = await fakeCamoufoxPi(stateDir);
		camoufoxPi.setCloseMode("defer");
		createJouzuCamoufoxExtension(pi, stateDir, { idleStopTimeoutMs: 60_000, scheduleIdleStop });
		const fetch = tools.get("tff-fetch_url");
		await fetch.execute("call-1", { url: "https://example.com" }, undefined, undefined, undefined);
		timers[0].fire();

		let settled = false;
		const shutdown = handlers
			.get("session_shutdown")()
			.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
		await delay(30);
		assert.equal(settled, false, "shutdown must wait for the in-flight idle-stop close");
		camoufoxPi.releasePendingCloses();
		await shutdown;
		assert.equal(settled, true, "shutdown must settle once the idle-stop close completes");
		assert.equal(camoufoxPi.closedClients.length, 1);
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a wedged idle-stop close does not block session_shutdown past the grace period", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "jouzu-camoufox-idle-wedged-"));
	const { tools, handlers, timers, pi, scheduleIdleStop } = extensionHarness();
	try {
		writeFakeRuntime(stateDir);
		const camoufoxPi = await fakeCamoufoxPi(stateDir);
		camoufoxPi.setCloseMode("defer");
		createJouzuCamoufoxExtension(pi, stateDir, {
			idleStopTimeoutMs: 60_000,
			scheduleIdleStop,
			closeGraceMs: 100,
		});
		const fetch = tools.get("tff-fetch_url");
		await fetch.execute("call-1", { url: "https://example.com" }, undefined, undefined, undefined);
		timers[0].fire();

		const startedAt = Date.now();
		await handlers.get("session_shutdown")();
		assert.ok(Date.now() - startedAt < 5_000, "shutdown must complete within the grace bound");
		assert.equal(camoufoxPi.closedClients.length, 0, "the wedged close must remain unreleased");
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a session restart on a reused extension keeps the idle stop armed", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "jouzu-camoufox-idle-restart-"));
	const { tools, handlers, timers, armed, pi, scheduleIdleStop } = extensionHarness();
	try {
		writeFakeRuntime(stateDir);
		createJouzuCamoufoxExtension(pi, stateDir, { idleStopTimeoutMs: 60_000, scheduleIdleStop });
		const sessionStart = handlers.get("session_start");
		sessionStart({}, { cwd: stateDir });
		const fetch = tools.get("tff-fetch_url");
		const first = await fetch.execute("call-1", { url: "https://example.com" }, undefined, undefined, undefined);
		assert.equal(first.details.servedBy, 1);
		assert.equal(timers.length, 1);

		await handlers.get("session_shutdown")({ reason: "new" });
		assert.equal(armed().length, 0, "shutdown must disarm the pending idle timer");

		sessionStart({}, { cwd: stateDir });
		const second = await fetch.execute("call-2", { url: "https://example.com/2" }, undefined, undefined, undefined);
		assert.equal(second.details.servedBy, 2, "the restarted session must reload the browser");
		assert.equal(timers.length, 2, "the restarted session must arm the idle stop again");

		timers.at(-1).fire();
		const camoufoxPi = await fakeCamoufoxPi(stateDir);
		await waitForClosedClients(camoufoxPi, 2);
		assert.equal(camoufoxPi.closedClients.length, 2, "the idle stop must still work after the restart");
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
});
