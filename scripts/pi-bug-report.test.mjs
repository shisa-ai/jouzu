import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const piRoot = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/", import.meta.url));
const loadPi = (relative) => import(pathToFileURL(join(piRoot, relative)).href);
const { initTheme } = await loadPi("dist/modes/interactive/theme/theme.js");
const { reportBug } = await loadPi("dist/modes/interactive/bug-report.js");
const { InteractiveMode } = await loadPi("dist/modes/interactive/interactive-mode.js");
const { BUILTIN_SLASH_COMMANDS } = await loadPi("dist/core/slash-commands.js");
const { bugReportArchiveFileName, writeBugReportArchive } = await loadPi("dist/core/bug-report.js");
const { VERSION } = await loadPi("dist/config.js");

initTheme("dark");

const IDENTITY = "Runtime: Jouzu 0.1.13 · Pi 0.86.0";

function tick() {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Parse the classic local-header ZIP archives written by the pinned runtime. */
function readZipEntries(buffer) {
	const entries = new Map();
	let offset = 0;
	while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
		const method = buffer.readUInt16LE(offset + 8);
		const compressedSize = buffer.readUInt32LE(offset + 18);
		const nameLength = buffer.readUInt16LE(offset + 26);
		const extraLength = buffer.readUInt16LE(offset + 28);
		const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
		const dataStart = offset + 30 + nameLength + extraLength;
		const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
		entries.set(name, method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed));
		offset = dataStart + compressedSize;
	}
	return entries;
}

async function readArchive(workDir) {
	const names = (await readdir(workDir)).filter((name) => name.endsWith(".zip"));
	assert.equal(names.length, 1, `expected one archive, found ${names.join(", ") || "none"}`);
	const buffer = await readFile(join(workDir, names[0]));
	return { name: names[0], buffer, entries: readZipEntries(buffer) };
}

function parseReport(archive) {
	const data = archive.entries.get("report.json");
	assert.ok(data, "report.json is missing from the archive");
	return JSON.parse(data.toString("utf8"));
}

async function createFixture(t, { summaryCalls = [] } = {}) {
	const agentDir = await mkdtemp(join(tmpdir(), "jouzu-bug-agent-"));
	const workDir = await mkdtemp(join(tmpdir(), "jouzu-bug-work-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousCwd = process.cwd();
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.chdir(workDir);
	t.after(async () => {
		process.chdir(previousCwd);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
		await rm(workDir, { recursive: true, force: true });
	});
	const customEntries = [];
	const session = {
		sessionId: "session-fixture",
		messages: [{ role: "user", content: "hello" }],
		model: null,
		modelRuntime: undefined,
		thinkingLevel: "off",
		resourceLoader: { getExtensions: () => ({ extensions: [], errors: [] }) },
		settingsManager: {
			getGlobalSettings: () => ({ theme: "dark", trackingId: "private-tracking-id" }),
			getProjectSettings: () => ({}),
		},
		sessionManager: {
			getCwd: () => workDir,
			getSessionId: () => "session-fixture",
			getEntries: () => [],
			getBranch: () => [],
			appendCustomEntry: (...args) => customEntries.push(args),
		},
		state: { systemPrompt: "system", tools: [] },
		summarizeForBugReport: (...args) => {
			summaryCalls.push(args);
			throw new Error("model summary must not be called");
		},
	};
	const overlays = [];
	const statuses = [];
	const errors = [];
	const editor = { name: "editor" };
	const ui = { setFocus() {}, requestRender() {} };
	const editorContainer = {
		clear() {},
		addChild(child) {
			overlays.push(child);
		},
	};
	const context = {
		session,
		ui,
		editorContainer,
		editor,
		showStatus: (message) => statuses.push(message),
		showError: (message) => errors.push(message),
		runtimeIdentity: IDENTITY,
	};
	return {
		agentDir,
		workDir,
		session,
		overlays,
		statuses,
		errors,
		customEntries,
		editor,
		ui,
		editorContainer,
		context,
	};
}

async function plantCrash(agentDir) {
	const record = {
		timestamp: new Date().toISOString(),
		version: VERSION,
		kind: "fatal_error",
		message: "fixture crash",
		stack: null,
		sessionFile: null,
		cwd: agentDir,
	};
	await writeFile(join(agentDir, "crashes.json"), `${JSON.stringify([record], null, 2)}\n`);
}

async function crashLog(agentDir) {
	try {
		return await readFile(join(agentDir, "crashes.json"), "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return undefined;
		throw error;
	}
}

function latestOverlay(fixture) {
	const overlay = fixture.overlays.at(-1);
	assert.notEqual(overlay, fixture.editor, "expected a report dialog, found the restored editor");
	return overlay;
}

async function driveBugReport(fixture, { hint, includeTranscript = false, cancelAt } = {}) {
	const running = reportBug(fixture.context, hint);
	await tick();
	const input = latestOverlay(fixture);
	if (cancelAt === "input") {
		input.handleInput("\x1b");
		await running;
		return { input, transcript: undefined, confirm: undefined };
	}
	input.handleInput("\n");
	await tick();
	const transcript = latestOverlay(fixture);
	if (cancelAt === "transcript") {
		transcript.handleInput("\x1b");
		await running;
		return { input, transcript, confirm: undefined };
	}
	if (includeTranscript) transcript.handleInput("j");
	transcript.handleInput("\n");
	await tick();
	const confirm = latestOverlay(fixture);
	if (cancelAt === "confirm" || cancelAt === "confirm-cancel") {
		if (cancelAt === "confirm-cancel") {
			confirm.handleInput("j");
			confirm.handleInput("\n");
		} else {
			confirm.handleInput("\x1b");
		}
		await running;
		return { input, transcript, confirm };
	}
	confirm.handleInput("\n");
	await running;
	return { input, transcript, confirm };
}

test("bug report cancellation leaves no archive and keeps crash records", async (t) => {
	const fixture = await createFixture(t);
	await plantCrash(fixture.agentDir);
	const crashBefore = await crashLog(fixture.agentDir);

	await driveBugReport(fixture, { cancelAt: "input" });
	await driveBugReport(fixture, { cancelAt: "transcript" });
	await driveBugReport(fixture, { cancelAt: "confirm" });
	await driveBugReport(fixture, { cancelAt: "confirm-cancel" });

	assert.deepEqual(fixture.statuses, [
		"Bug report cancelled",
		"Bug report cancelled",
		"Bug report cancelled",
		"Bug report cancelled",
	]);
	assert.deepEqual(fixture.errors, []);
	assert.deepEqual(fixture.customEntries, []);
	assert.deepEqual(await readdir(fixture.workDir), []);
	assert.equal(await crashLog(fixture.agentDir), crashBefore);
});

test("transcript is excluded by default and included only after explicit consent", async (t) => {
	const fixture = await createFixture(t);

	const first = await driveBugReport(fixture, { hint: "default run" });
	assert.deepEqual(first.transcript.options, ["No", "Yes, include the transcript"]);
	assert.equal(first.transcript.selectedIndex, 0);
	const defaultArchive = await readArchive(fixture.workDir);
	const defaultReport = parseReport(defaultArchive);
	assert.equal(defaultReport.session.included, false);
	assert.equal(defaultReport.session.summaryIncluded, false);
	assert.equal(defaultArchive.entries.has("session.jsonl"), false);
	assert.equal(defaultArchive.entries.has("diagnostics.json"), true);

	await rm(join(fixture.workDir, defaultArchive.name));
	const second = await driveBugReport(fixture, { hint: "consent run", includeTranscript: true });
	assert.equal(second.transcript.selectedIndex, 1);
	const consentArchive = await readArchive(fixture.workDir);
	const consentReport = parseReport(consentArchive);
	assert.equal(consentReport.session.included, true);
	const sessionJsonl = consentArchive.entries.get("session.jsonl")?.toString("utf8");
	assert.ok(sessionJsonl, "session.jsonl is missing from the consented archive");
	assert.match(sessionJsonl, /"type":"session"/);
	assert.match(sessionJsonl, /session-fixture/);
});

test("archive metadata records the Jouzu runtime identity and Pi version", async (t) => {
	const fixture = await createFixture(t);
	await driveBugReport(fixture, { hint: "identity run" });
	const archive = await readArchive(fixture.workDir);
	assert.match(archive.name, /^jouzu-bug-report-[0-9a-f-]+\.zip$/);
	const report = parseReport(archive);
	assert.equal(report.jouzu.runtimeIdentity, IDENTITY);
	assert.equal(report.environment.version, VERSION);
	assert.equal(report.hint, "identity run");
});

test("export makes no upload request and never calls the model summary", async (t) => {
	const summaryCalls = [];
	const fixture = await createFixture(t, { summaryCalls });
	let fetchCalls = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (...args) => {
		fetchCalls++;
		return originalFetch(...args);
	};
	t.after(() => {
		globalThis.fetch = originalFetch;
	});

	await driveBugReport(fixture, { hint: "no network" });

	assert.equal(fetchCalls, 0);
	assert.deepEqual(summaryCalls, []);
	const source = await readFile(join(piRoot, "dist/modes/interactive/bug-report.js"), "utf8");
	assert.doesNotMatch(
		source,
		/bug-report-upload|uploadBugReport|getRadiusGatewayUrl|getAuthCredential|summarizeForBugReport/,
	);
});

test("archive write failure is reported without success or crash clearing", async (t) => {
	const fixture = await createFixture(t);
	await plantCrash(fixture.agentDir);
	const crashBefore = await crashLog(fixture.agentDir);
	const realCwd = process.cwd;
	process.cwd = () => join(fixture.workDir, "missing");
	try {
		await driveBugReport(fixture, { hint: "write failure" });
	} finally {
		process.cwd = realCwd;
	}
	assert.deepEqual(fixture.statuses, []);
	assert.match(fixture.errors.at(-1) ?? "", /^Failed to write bug report: /);
	assert.deepEqual(fixture.customEntries, []);
	assert.deepEqual(await readdir(fixture.workDir), []);
	assert.equal(await crashLog(fixture.agentDir), crashBefore);
});

test("archives are created exclusively with owner-only permissions", async (t) => {
	const fixture = await createFixture(t);
	assert.equal(bugReportArchiveFileName("abc"), "jouzu-bug-report-abc.zip");
	const target = join(fixture.workDir, "exclusive.zip");
	const bundle = { metadata: { id: "exclusive" }, diagnostics: {} };
	await writeBugReportArchive(bundle, target);
	if (process.platform === "linux") {
		const info = await stat(target);
		assert.equal(info.mode & 0o777, 0o600);
	}
	const first = await readFile(target);
	await assert.rejects(writeBugReportArchive(bundle, target), (error) => error.code === "EEXIST");
	assert.deepEqual(await readFile(target), first);
});

test("builtin command and crash hints describe a local export", async () => {
	const bugCommand = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "bug");
	assert.ok(bugCommand, "the builtin bug command is missing");
	assert.match(bugCommand.description, /export/i);
	assert.doesNotMatch(bugCommand.description, /Pi developers/i);

	const crashInstructions = InteractiveMode.prototype.crashReportInstructions.call({
		session: { sessionFile: undefined },
	});
	assert.match(crashInstructions, /export/i);
	assert.doesNotMatch(crashInstructions, /attached automatically/i);

	const hints = [];
	InteractiveMode.prototype.suggestBugReport.call({
		bugReportHintShown: false,
		outputPad: 0,
		chatContainer: { addChild: (child) => hints.push(child) },
		ui: { requestRender() {} },
	});
	assert.equal(hints.length, 1);
	assert.match(hints[0].text, /exports a local report/);
	assert.doesNotMatch(hints[0].text, /sends a report/);

	const source = await readFile(join(piRoot, "dist/modes/interactive/interactive-mode.js"), "utf8");
	assert.match(source, /Run \/bug to export a report/);
	assert.doesNotMatch(source, /attached automatically/);
});

test("report dialogs point at the Jouzu issue tracker and warn that issues are public", async (t) => {
	const fixture = await createFixture(t);
	const { input, transcript, confirm } = await driveBugReport(fixture, { hint: "privacy run" });
	const descriptionText = input.children.find((child) => child.text?.includes("github.com"))?.text ?? "";
	assert.match(descriptionText, /https:\/\/github\.com\/shisa-ai\/jouzu\/issues/);
	assert.match(descriptionText, /public/);
	assert.match(descriptionText, /private data even when the transcript is excluded/);
	assert.match(descriptionText, /Nothing is uploaded or posted automatically/);
	const transcriptText = transcript.children.find((child) => child.text?.includes("excluded by default"))?.text ?? "";
	assert.match(transcriptText, /excluded by default/);
	const confirmText = confirm.children.find((child) => child.text?.includes("jouzu-bug-report"))?.text ?? "";
	assert.match(confirmText, /Nothing is uploaded or posted automatically/);
	assert.match(confirmText, /public/);
});

test("builtin /bug routing forwards the host runtime identity", async (t) => {
	const fixture = await createFixture(t);
	const interactive = {
		options: { sessionInfoFooter: () => IDENTITY },
		session: fixture.session,
		ui: fixture.ui,
		editorContainer: fixture.editorContainer,
		editor: fixture.editor,
		showStatus: fixture.context.showStatus,
		showError: fixture.context.showError,
	};
	const running = InteractiveMode.prototype.handleBugCommand.call(interactive, "routed hint");
	await tick();
	const input = latestOverlay(fixture);
	assert.equal(input.input.getValue(), "routed hint");
	input.handleInput("\n");
	await tick();
	latestOverlay(fixture).handleInput("\n");
	await tick();
	latestOverlay(fixture).handleInput("\n");
	await running;
	const archive = await readArchive(fixture.workDir);
	const report = parseReport(archive);
	assert.equal(report.jouzu.runtimeIdentity, IDENTITY);
	assert.equal(report.hint, "routed hint");
});
