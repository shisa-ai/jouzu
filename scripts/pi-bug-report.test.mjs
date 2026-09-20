import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const piRoot = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/", import.meta.url));
const loadPi = (relative) => import(pathToFileURL(join(piRoot, relative)).href);
const { initTheme } = await loadPi("dist/modes/interactive/theme/theme.js");
const { ISSUE_NEW_URL, ISSUES_URL, buildBugReportDraft, renderBugReport, reportBug } = await loadPi(
	"dist/modes/interactive/bug-report.js",
);
const { InteractiveMode } = await loadPi("dist/modes/interactive/interactive-mode.js");
const { BUILTIN_SLASH_COMMANDS } = await loadPi("dist/core/slash-commands.js");
const { visibleWidth } = await loadPi("node_modules/@earendil-works/pi-tui/dist/index.js");

initTheme("dark");

const IDENTITY = "Runtime: Jouzu 0.1.13 · Pi 0.86.0";
const EXPECTED_LINK = "https://github.com/shisa-ai/jouzu/issues/new";
const EXPECTED_ISSUES = "https://github.com/shisa-ai/jouzu/issues";
const EXPECTED_API_ARGS = ["api", "user", "--hostname", "github.com", "--jq", ".login"];
const EXPECTED_REPO_URL = "https://github.com/shisa-ai/jouzu";
assert.equal(ISSUE_NEW_URL, EXPECTED_LINK);
assert.equal(ISSUES_URL, EXPECTED_ISSUES);

function tick() {
	return new Promise((resolve) => setImmediate(resolve));
}

function enoentError() {
	const error = new Error("spawn gh ENOENT");
	error.code = "ENOENT";
	return error;
}

function createGhStub({
	account = "octocat",
	issueUrl = "https://github.com/shisa-ai/jouzu/issues/42",
	authError,
	createError,
} = {}) {
	const calls = [];
	return {
		calls,
		execGh: async (args) => {
			calls.push([...args]);
			if (args[0] === "api" && args[1] === "user") {
				if (authError) throw authError;
				return { stdout: `${account}\n`, stderr: "" };
			}
			if (args[0] === "issue" && args[1] === "create") {
				if (createError) throw createError;
				return { stdout: `${issueUrl}\n`, stderr: "" };
			}
			throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
		},
	};
}

async function createFixture(t, { execGh, realGh = false, summaryCalls = [] } = {}) {
	const workDir = await mkdtemp(join(tmpdir(), "jouzu-bug-work-"));
	const previousCwd = process.cwd();
	process.chdir(workDir);
	t.after(async () => {
		process.chdir(previousCwd);
		await rm(workDir, { recursive: true, force: true });
	});
	const overlays = [];
	const statuses = [];
	const errors = [];
	const reports = [];
	const editor = { name: "editor" };
	const ui = { setFocus() {}, requestRender() {}, terminal: { rows: 24 } };
	const editorContainer = {
		clear() {
			overlays.length = 0;
		},
		addChild(child) {
			overlays.push(child);
		},
	};
	const session = {
		sessionId: "session-fixture",
		messages: [{ role: "user", content: "private transcript fixture" }],
		model: null,
		thinkingLevel: "off",
		resourceLoader: { getExtensions: () => ({ extensions: [], errors: [] }) },
		settingsManager: {
			getGlobalSettings: () => ({ theme: "dark", trackingId: "private-tracking-id" }),
			getProjectSettings: () => ({}),
		},
		sessionManager: { getCwd: () => workDir, getEntries: () => [], getBranch: () => [] },
		summarizeForBugReport: (...args) => {
			summaryCalls.push(args);
			throw new Error("model summary must not be called");
		},
	};
	const context = {
		session,
		ui,
		editorContainer,
		editor,
		runtimeIdentity: IDENTITY,
		showStatus: (message) => statuses.push(message),
		showError: (message) => errors.push(message),
		showReport: (markdown) => reports.push(markdown),
	};
	const runner = execGh ?? (realGh ? undefined : createGhStub({ authError: enoentError() }).execGh);
	if (runner) context.execGh = runner;
	return { workDir, session, overlays, statuses, errors, reports, editor, ui, editorContainer, context };
}

function latestOverlay(fixture) {
	const overlay = fixture.overlays.at(-1);
	assert.notEqual(overlay, fixture.editor, "expected a report dialog, found the restored editor");
	return overlay;
}

/** Wait for either the optional submission dialog or the end of the flow (real gh calls are slow). */
async function waitForSelectorOrEnd(fixture, running) {
	let settled = false;
	running.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	for (let attempt = 0; attempt < 500; attempt++) {
		const last = fixture.overlays.at(-1);
		if (last !== fixture.editor && Array.isArray(last.options)) return last;
		if (settled) return undefined;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for the submission dialog");
}

async function driveBugReport(fixture, options = {}) {
	const {
		hint,
		expected = "",
		actual = "",
		reproduction = "",
		cancelAt,
		bodyEdit,
		titleEdit,
		confirmSubmit = false,
		beforeBodySubmit,
		beforeTitleSubmit,
	} = options;
	const running = reportBug(fixture.context, hint);
	await tick();
	const description = latestOverlay(fixture);
	if (cancelAt === "description") {
		description.handleInput("\x1b");
		await running;
		return { description };
	}
	description.handleInput("\n");
	await tick();
	const expectedInput = latestOverlay(fixture);
	if (cancelAt === "expected") {
		expectedInput.handleInput("\x1b");
		await running;
		return { description, expected: expectedInput };
	}
	expectedInput.input.setValue(expected);
	expectedInput.handleInput("\n");
	await tick();
	const actualInput = latestOverlay(fixture);
	if (cancelAt === "actual") {
		actualInput.handleInput("\x1b");
		await running;
		return { description, expected: expectedInput, actual: actualInput };
	}
	actualInput.input.setValue(actual);
	actualInput.handleInput("\n");
	await tick();
	const reproductionInput = latestOverlay(fixture);
	if (cancelAt === "reproduction") {
		reproductionInput.handleInput("\x1b");
		await running;
		return { description, expected: expectedInput, actual: actualInput, reproduction: reproductionInput };
	}
	reproductionInput.input.setValue(reproduction);
	reproductionInput.handleInput("\n");
	await tick();
	const body = latestOverlay(fixture);
	beforeBodySubmit?.(body);
	if (cancelAt === "body") {
		body.handleInput("\x1b");
		await running;
		return { description, expected: expectedInput, actual: actualInput, reproduction: reproductionInput, body };
	}
	if (bodyEdit !== undefined) body.editor.setText(bodyEdit);
	body.handleInput("\r");
	await tick();
	const title = latestOverlay(fixture);
	beforeTitleSubmit?.(title);
	if (cancelAt === "title") {
		title.handleInput("\x1b");
		await running;
		return { description, expected: expectedInput, actual: actualInput, reproduction: reproductionInput, body, title };
	}
	if (titleEdit !== undefined) title.input.setValue(titleEdit);
	title.handleInput("\n");
	const selector = await waitForSelectorOrEnd(fixture, running);
	const hasSelector = selector !== undefined;
	const last = selector ?? fixture.overlays.at(-1);
	if (hasSelector) {
		options.beforeConfirm?.(selector, fixture);
		if (cancelAt === "confirm") {
			last.handleInput("\x1b");
			await running;
			return {
				description,
				expected: expectedInput,
				actual: actualInput,
				reproduction: reproductionInput,
				body,
				title,
				confirm: last,
			};
		}
		if (confirmSubmit) last.handleInput("j");
		last.handleInput("\n");
	} else {
		assert.equal(last, fixture.editor, "expected the flow to finish or offer a submission dialog");
		assert.equal(cancelAt, undefined, `expected no submission dialog for cancelAt=${cancelAt}`);
	}
	await running;
	return {
		description,
		expected: expectedInput,
		actual: actualInput,
		reproduction: reproductionInput,
		body,
		title,
		confirm: hasSelector ? last : undefined,
	};
}

test("draft includes the reported detail and minimal environment facts", () => {
	const draft = buildBugReportDraft({
		description: "Automatic work remains held after the job finishes",
		expected: "The held work resumes",
		actual: "It stays paused",
		reproduction: "Run /flow auto, then finish the job",
		runtimeIdentity: IDENTITY,
	});
	assert.equal(draft.title, "Automatic work remains held after the job finishes");
	assert.match(
		draft.body,
		/^## What happened\n\nAutomatic work remains held after the job finishes\n\n## Expected behavior\n\nThe held work resumes\n\n## Actual behavior\n\nIt stays paused\n\n## Steps to reproduce\n\nRun \/flow auto, then finish the job\n\n## Environment\n\n- Runtime: Jouzu 0\.1\.13 · Pi 0\.86\.0\n- OS: /,
	);
	assert.match(draft.body, /- (Node v|Bun )/);
	assert.doesNotMatch(draft.body, /transcript|session\.jsonl|report\.json|diagnostics|settings|apiKey|baseUrl|crash/i);
});

test("draft uses editable placeholders for missing detail", () => {
	const draft = buildBugReportDraft({ runtimeIdentity: IDENTITY });
	assert.equal(draft.title, "Bug report");
	assert.match(draft.body, /## What happened\n\nNot provided\./);
	assert.match(draft.body, /## Expected behavior\n\nNot provided\./);
	assert.match(draft.body, /## Actual behavior\n\nNot provided\./);
	assert.match(draft.body, /## Steps to reproduce\n\nNot provided\./);
});

test("rendered draft always carries the public new-issue link", () => {
	const draft = { title: "Fixture title", body: "## What happened\n\nFixture body.\n" };
	const withNote = renderBugReport(draft, "Fixture note.");
	assert.match(withNote, /^# Fixture title\n\n## What happened/);
	assert.match(
		withNote,
		/\n---\n\nFixture note\.\n\nNew issue form: https:\/\/github\.com\/shisa-ai\/jouzu\/issues\/new\n$/,
	);
	const withoutNote = renderBugReport(draft);
	assert.match(withoutNote, /\nNew issue form: https:\/\/github\.com\/shisa-ai\/jouzu\/issues\/new\n$/);
	assert.doesNotMatch(withoutNote, /\n---\n/);
});

test("default flow stays local, keeps no archive, and never calls a model", async (t) => {
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

	await driveBugReport(fixture, {
		hint: "no network",
		expected: "expected text",
		actual: "actual text",
		reproduction: "steps",
	});

	assert.equal(fetchCalls, 0);
	assert.deepEqual(summaryCalls, []);
	assert.deepEqual(await readdir(fixture.workDir), []);
	assert.equal(fixture.reports.length, 2);
	assert.match(fixture.reports[0], /Review this draft before submitting\. Nothing has been posted yet\./);
	assert.match(fixture.reports[0], /## What happened/);
	assert.match(fixture.reports.at(-1), /gh is not installed/);
	for (const report of fixture.reports) assert.match(report, new RegExp(`New issue form: ${EXPECTED_LINK}`));
	assert.doesNotMatch(
		fixture.reports.at(-1),
		/session\.jsonl|report\.json|diagnostics\.json|private transcript fixture/,
	);
	assert.deepEqual(fixture.errors, []);

	const source = await readFile(join(piRoot, "dist/modes/interactive/bug-report.js"), "utf8");
	assert.doesNotMatch(
		source,
		/uploadBugReport|getRadiusGatewayUrl|getAuthCredential|summarizeForBugReport|writeBugReportArchive|readCrashLog|clearCrashLog/,
	);
	assert.doesNotMatch(source, /\.zip/);
});

test("generated body and title are shown for review and edits are used", async (t) => {
	const fixture = await createFixture(t);
	let generatedBody;
	let generatedTitle;
	let renderedLines = 0;
	const { title } = await driveBugReport(fixture, {
		hint: "original title",
		expected: "expected text",
		actual: "actual text",
		reproduction: "steps",
		beforeBodySubmit: (component) => {
			generatedBody = component.editor.getText();
			renderedLines = component.render(48).length;
		},
		beforeTitleSubmit: (component) => {
			generatedTitle = component.input.getValue();
		},
		bodyEdit: "## What happened\n\nEdited body.",
		titleEdit: "Edited public title",
	});
	assert.match(generatedBody, /## What happened\n\noriginal title/);
	assert.match(generatedBody, /expected text/);
	assert.ok(renderedLines > 0, "the review editor must render at 48 columns");
	assert.equal(generatedTitle, "original title");
	assert.equal(title.input.getValue(), "Edited public title");
	assert.match(fixture.reports[0], /^# Edited public title\n/);
	assert.match(fixture.reports[0], /Edited body\./);
	assert.match(fixture.reports[0], /Nothing has been posted yet\./);
	assert.match(fixture.reports[0], new RegExp(`New issue form: ${EXPECTED_LINK}`));
	assert.equal(fixture.reports.length, 2);
	assert.match(fixture.reports.at(-1), /^# Edited public title\n/);
	assert.match(fixture.reports.at(-1), /Edited body\./);
	assert.doesNotMatch(fixture.reports.at(-1), /expected text/);
	assert.equal(fixture.statuses.at(-1), "Draft ready; nothing was posted.");
	assert.deepEqual(await readdir(fixture.workDir), []);
});

test("missing gh offers no submission and keeps the draft with the link", async (t) => {
	const stub = createGhStub({ authError: enoentError() });
	const fixture = await createFixture(t, { execGh: stub.execGh });
	const { confirm } = await driveBugReport(fixture, { hint: "no gh" });
	assert.equal(confirm, undefined);
	assert.deepEqual(stub.calls, [EXPECTED_API_ARGS]);
	assert.equal(fixture.reports.length, 2);
	assert.match(fixture.reports[0], /Review this draft before submitting/);
	assert.match(fixture.reports.at(-1), /gh is not installed/);
	assert.match(fixture.reports.at(-1), new RegExp(`New issue form: ${EXPECTED_LINK}`));
	assert.equal(fixture.statuses.at(-1), "Draft ready; nothing was posted.");
});

test("unauthenticated gh offers no submission and keeps the draft with the link", async (t) => {
	const stub = createGhStub({ authError: new Error("gh: not logged in") });
	const fixture = await createFixture(t, { execGh: stub.execGh });
	const { confirm } = await driveBugReport(fixture, { hint: "not logged in" });
	assert.equal(confirm, undefined);
	assert.deepEqual(stub.calls, [EXPECTED_API_ARGS]);
	assert.match(fixture.reports.at(-1), /gh is not authenticated/);
	assert.match(fixture.reports.at(-1), new RegExp(`New issue form: ${EXPECTED_LINK}`));
	assert.equal(fixture.statuses.at(-1), "Draft ready; nothing was posted.");
});

test("authenticated gh offers submission that names the account and public repo", async (t) => {
	const stub = createGhStub({ account: "octocat" });
	const fixture = await createFixture(t, { execGh: stub.execGh });
	const { confirm } = await driveBugReport(fixture, { hint: "confirm wording" });
	assert.ok(confirm, "an authenticated gh must offer submission");
	assert.deepEqual(confirm.options, ["No, keep the draft", "Submit as octocat using gh"]);
	assert.equal(confirm.selectedIndex, 0, "the default selection must not submit");
	const text = confirm.children.map((child) => child.text ?? "").join("\n");
	assert.match(text, /public issue in shisa-ai\/jouzu as octocat/);
	assert.match(text, /public/);
	assert.match(fixture.reports.at(-1), new RegExp(`New issue form: ${EXPECTED_LINK}`));
	assert.deepEqual(stub.calls, [EXPECTED_API_ARGS]);
});

test("declined confirmation never creates an issue", async (t) => {
	const stub = createGhStub({ account: "octocat" });
	const fixture = await createFixture(t, { execGh: stub.execGh });
	const { confirm } = await driveBugReport(fixture, { hint: "decline" });
	assert.equal(confirm.selectedIndex, 0);
	assert.deepEqual(stub.calls, [EXPECTED_API_ARGS]);
	assert.match(fixture.reports.at(-1), /Not submitted\./);
	assert.match(fixture.reports.at(-1), new RegExp(`New issue form: ${EXPECTED_LINK}`));
	assert.equal(fixture.statuses.at(-1), "Draft kept; nothing was posted.");
});

test("affirmative consent runs gh once with the exact fixed arguments", async (t) => {
	const stub = createGhStub({ account: "octocat", issueUrl: "https://github.com/shisa-ai/jouzu/issues/42" });
	const fixture = await createFixture(t, { execGh: stub.execGh });
	const editedBody = "## What happened\n\nBody with $HOME and `backticks`.";
	await driveBugReport(fixture, {
		hint: "exact argv",
		bodyEdit: `${editedBody}\n`,
		titleEdit: "Title with $HOME; rm -rf /",
		confirmSubmit: true,
	});
	assert.deepEqual(stub.calls, [
		EXPECTED_API_ARGS,
		["issue", "create", "--repo", EXPECTED_REPO_URL, "--title", "Title with $HOME; rm -rf /", "--body", editedBody],
	]);
	assert.match(fixture.reports.at(-1), /Issue created: https:\/\/github\.com\/shisa-ai\/jouzu\/issues\/42/);
	assert.match(fixture.reports.at(-1), new RegExp(`New issue form: ${EXPECTED_LINK}`));
	assert.equal(fixture.statuses.at(-1), "Issue created: https://github.com/shisa-ai/jouzu/issues/42");
});

test("ambiguous submission failure keeps the draft and never retries", async (t) => {
	const stub = createGhStub({ account: "octocat", createError: new Error("HTTP 403: Forbidden") });
	const fixture = await createFixture(t, { execGh: stub.execGh });
	await driveBugReport(fixture, { hint: "failure", confirmSubmit: true });
	assert.equal(stub.calls.filter((args) => args[0] === "issue").length, 1);
	assert.equal(fixture.errors.length, 1);
	assert.match(fixture.errors[0], /result is unknown: HTTP 403: Forbidden/);
	assert.match(fixture.errors[0], new RegExp(`Check ${EXPECTED_ISSUES} before retrying`));
	assert.match(fixture.reports.at(-1), /Submission result is unknown: HTTP 403: Forbidden/);
	assert.match(fixture.reports.at(-1), new RegExp(`Check ${EXPECTED_ISSUES} for a new issue before retrying`));
	assert.doesNotMatch(fixture.reports.at(-1), /was not posted/);
	assert.match(fixture.reports.at(-1), /## What happened/);
	assert.match(fixture.reports.at(-1), new RegExp(`New issue form: ${EXPECTED_LINK}`));
});

test("cancelling after the draft keeps it visible with the link", async (t) => {
	const stub = createGhStub({ account: "octocat" });
	const fixture = await createFixture(t, { execGh: stub.execGh });
	await driveBugReport(fixture, { hint: "cancel body", cancelAt: "body" });
	assert.deepEqual(stub.calls, []);
	assert.match(fixture.reports.at(-1), /Report cancelled/);
	assert.match(fixture.reports.at(-1), new RegExp(`New issue form: ${EXPECTED_LINK}`));
	assert.equal(fixture.statuses.at(-1), "Bug report cancelled");

	await driveBugReport(fixture, { hint: "cancel confirm", cancelAt: "confirm" });
	assert.deepEqual(stub.calls, [EXPECTED_API_ARGS]);
	assert.match(fixture.reports.at(-1), /Not submitted\./);
	assert.match(fixture.reports.at(-1), new RegExp(`New issue form: ${EXPECTED_LINK}`));
});

test("cancelling before a draft posts nothing", async (t) => {
	const stub = createGhStub({ account: "octocat" });
	const fixture = await createFixture(t, { execGh: stub.execGh });
	const { description } = await driveBugReport(fixture, { cancelAt: "description" });
	const descriptionText = description.children.map((child) => child.text ?? "").join("\n");
	assert.match(descriptionText, new RegExp(`New issue form: ${EXPECTED_LINK}`));
	await driveBugReport(fixture, { cancelAt: "expected" });
	assert.deepEqual(fixture.reports, []);
	assert.deepEqual(fixture.statuses, ["Bug report cancelled", "Bug report cancelled"]);
	assert.deepEqual(stub.calls, []);
	assert.deepEqual(await readdir(fixture.workDir), []);
});

test("crash hints and the builtin command describe a reviewable draft", async () => {
	const bugCommand = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "bug");
	assert.ok(bugCommand, "the builtin bug command is missing");
	assert.match(bugCommand.description, /draft/i);
	assert.doesNotMatch(bugCommand.description, /Pi developers|export|zip|archive/i);

	const crashInstructions = InteractiveMode.prototype.crashReportInstructions.call({
		session: { sessionFile: undefined },
	});
	assert.match(crashInstructions, /draft/i);
	assert.doesNotMatch(crashInstructions, /attached|archive|export|zip/i);

	const hints = [];
	InteractiveMode.prototype.suggestBugReport.call({
		bugReportHintShown: false,
		outputPad: 0,
		chatContainer: { addChild: (child) => hints.push(child) },
		ui: { requestRender() {} },
	});
	assert.equal(hints.length, 1);
	assert.match(hints[0].text, /drafts a report/);
	assert.doesNotMatch(hints[0].text, /attached|archive|export|zip/i);

	const source = await readFile(join(piRoot, "dist/modes/interactive/interactive-mode.js"), "utf8");
	assert.match(source, /Run \/bug to draft a report/);
	assert.doesNotMatch(source, /attached automatically|included in the local archive/);
});

test("builtin /bug routing renders the draft and link at 48 columns", async (t) => {
	const fixture = await createFixture(t);
	const children = [];
	const interactive = {
		options: { sessionInfoFooter: () => IDENTITY },
		session: fixture.session,
		ui: fixture.ui,
		editorContainer: fixture.editorContainer,
		editor: fixture.editor,
		chatContainer: { addChild: (child) => children.push(child) },
		outputPad: 1,
		showStatus: fixture.context.showStatus,
		showError: fixture.context.showError,
	};
	const previousPath = process.env.PATH;
	const emptyPath = await mkdtemp(join(tmpdir(), "jouzu-empty-path-"));
	process.env.PATH = emptyPath;
	t.after(async () => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(emptyPath, { recursive: true, force: true });
	});

	const running = InteractiveMode.prototype.handleBugCommand.call(interactive, "routed hint");
	await tick();
	const input = latestOverlay(fixture);
	assert.equal(input.input.getValue(), "routed hint");
	input.handleInput("\n");
	await tick();
	latestOverlay(fixture).handleInput("\n");
	await tick();
	latestOverlay(fixture).handleInput("\n");
	await tick();
	latestOverlay(fixture).handleInput("\n");
	await tick();
	const body = latestOverlay(fixture);
	assert.match(body.editor.getText(), /## What happened\n\nrouted hint/);
	body.handleInput("\r");
	await tick();
	latestOverlay(fixture).handleInput("\n");
	await running;

	const reports = children.filter((child) => typeof child.text === "string" && child.text.includes("New issue form:"));
	assert.equal(reports.length, 2, "the pre-consent draft and the outcome must both be shown");
	assert.match(reports[0].text, /Review this draft before submitting\. Nothing has been posted yet\./);
	assert.match(reports[0].text, /# routed hint/);
	assert.match(reports[1].text, /gh is not installed/);
	for (const report of reports) {
		const lines = report.render(48);
		assert.ok(lines.length > 0, "the routed report must render");
		for (const line of lines) assert.ok(visibleWidth(line) <= 48, `line exceeds 48 columns: ${JSON.stringify(line)}`);
	}
	assert.equal(fixture.statuses.at(-1), "Draft ready; nothing was posted.");
});

test("default gh runner uses fixed argv without a shell", { skip: process.platform === "win32" }, async (t) => {
	const fixture = await createFixture(t, { realGh: true });
	const binDir = await mkdtemp(join(tmpdir(), "jouzu-gh-bin-"));
	const capturePath = join(fixture.workDir, "gh-capture.bin");
	const scriptPath = join(binDir, "gh");
	await writeFile(
		scriptPath,
		`${[
			"#!/bin/sh",
			'{ printf "CALL\\0"; for arg in "$@"; do printf "%s\\0" "$arg"; done; } >> "$JOUZU_GH_CAPTURE"',
			'if [ "$1" = "api" ]; then printf "fixture-user\\n"; else printf "https://github.com/shisa-ai/jouzu/issues/7\\n"; fi',
		].join("\n")}\n`,
	);
	await chmod(scriptPath, 0o755);
	const previousPath = process.env.PATH;
	const previousCapture = process.env.JOUZU_GH_CAPTURE;
	process.env.PATH = `${binDir}${delimiter}${previousPath}`;
	process.env.JOUZU_GH_CAPTURE = capturePath;
	t.after(async () => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousCapture === undefined) delete process.env.JOUZU_GH_CAPTURE;
		else process.env.JOUZU_GH_CAPTURE = previousCapture;
		await rm(binDir, { recursive: true, force: true });
	});

	const title = 'Title with $HOME; echo "pwned" && true';
	const body = "## What happened\n\nBody $(touch /tmp/pwned) with `backticks`.";
	await driveBugReport(fixture, { hint: "fixture gh", bodyEdit: body, titleEdit: title, confirmSubmit: true });

	const captured = (await readFile(capturePath)).toString("utf8").split("\0");
	assert.deepEqual(captured.slice(0, -1), [
		"CALL",
		...EXPECTED_API_ARGS,
		"CALL",
		"issue",
		"create",
		"--repo",
		EXPECTED_REPO_URL,
		"--title",
		title,
		"--body",
		body,
	]);
	assert.equal(fixture.statuses.at(-1), "Issue created: https://github.com/shisa-ai/jouzu/issues/7");
	assert.match(fixture.reports.at(-1), /Issue created: https:\/\/github\.com\/shisa-ai\/jouzu\/issues\/7/);
	assert.match(fixture.reports.at(-1), new RegExp(`New issue form: ${EXPECTED_LINK}`));
});

test("final draft and link are shown before the submission choice", async (t) => {
	const stub = createGhStub({ account: "octocat" });
	const fixture = await createFixture(t, { execGh: stub.execGh });
	let reportsAtChoice;
	const { confirm } = await driveBugReport(fixture, {
		hint: "pre-consent",
		bodyEdit: "## What happened\n\nPre-consent body.",
		titleEdit: "Pre-consent title",
		beforeConfirm: (selector, current) => {
			reportsAtChoice = current.reports.length;
			assert.deepEqual(selector.options, ["No, keep the draft", "Submit as octocat using gh"]);
			assert.match(current.reports.at(-1), /^# Pre-consent title\n/);
			assert.match(current.reports.at(-1), /Pre-consent body\./);
			assert.match(current.reports.at(-1), /Review this draft before submitting\. Nothing has been posted yet\./);
			assert.match(current.reports.at(-1), new RegExp(`New issue form: ${EXPECTED_LINK}`));
		},
	});
	assert.ok(confirm, "the submission choice must appear");
	assert.equal(reportsAtChoice, 1, "the reviewed draft must be visible before the choice");
	assert.match(fixture.reports.at(-1), /Not submitted\./);
	assert.match(fixture.reports.at(-1), new RegExp(`New issue form: ${EXPECTED_LINK}`));
});

test("gh detection failures and timeouts offer no submission", async (t) => {
	const timeoutError = Object.assign(new Error("Command failed: gh api user"), { killed: true, signal: "SIGTERM" });
	const stub = createGhStub({ authError: timeoutError });
	const fixture = await createFixture(t, { execGh: stub.execGh });
	const { confirm } = await driveBugReport(fixture, { hint: "timeout" });
	assert.equal(confirm, undefined);
	assert.deepEqual(stub.calls, [EXPECTED_API_ARGS]);
	assert.match(fixture.reports.at(-1), /gh is not authenticated/);
	assert.match(fixture.reports.at(-1), new RegExp(`New issue form: ${EXPECTED_LINK}`));
});

test("gh host and repository are pinned against the environment", async (t) => {
	const stub = createGhStub({ account: "octocat" });
	const fixture = await createFixture(t, { execGh: stub.execGh });
	const previousHost = process.env.GH_HOST;
	const previousRepo = process.env.GH_REPO;
	process.env.GH_HOST = "evil.example";
	process.env.GH_REPO = "evil/repo";
	t.after(() => {
		if (previousHost === undefined) delete process.env.GH_HOST;
		else process.env.GH_HOST = previousHost;
		if (previousRepo === undefined) delete process.env.GH_REPO;
		else process.env.GH_REPO = previousRepo;
	});
	await driveBugReport(fixture, { hint: "pinned", confirmSubmit: true });
	assert.deepEqual(stub.calls[0], EXPECTED_API_ARGS);
	assert.equal(stub.calls[0].includes("evil.example"), false);
	const createArgs = stub.calls[1];
	assert.deepEqual(createArgs.slice(0, 7), [
		"issue",
		"create",
		"--repo",
		EXPECTED_REPO_URL,
		"--title",
		"pinned",
		"--body",
	]);
	assert.equal(createArgs[7].includes("## What happened\n\npinned"), true);
	assert.equal(
		createArgs.some((arg) => arg.includes("evil")),
		false,
	);
});

test("malformed gh output is an uncertain outcome and is sanitized", async (t) => {
	const stub = createGhStub({ account: "octocat", issueUrl: "https://evil.example/jouzu/1\u001b[31m" });
	const fixture = await createFixture(t, { execGh: stub.execGh });
	await driveBugReport(fixture, { hint: "malformed", confirmSubmit: true });
	assert.equal(stub.calls.filter((args) => args[0] === "issue").length, 1);
	assert.match(fixture.reports.at(-1), /Submission result is unknown/);
	assert.match(fixture.reports.at(-1), new RegExp(`Check ${EXPECTED_ISSUES} for a new issue before retrying`));
	assert.doesNotMatch(fixture.reports.at(-1), /evil\.example/);
	assert.equal(fixture.reports.at(-1).includes("\u001b"), false);
	assert.match(fixture.reports.at(-1), new RegExp(`New issue form: ${EXPECTED_LINK}`));
});

test("gh error output cannot inject terminal control sequences", async (t) => {
	const stub = createGhStub({
		account: "octocat",
		createError: new Error("\u001b[31mboom\u001b[0m\nsecond line"),
	});
	const fixture = await createFixture(t, { execGh: stub.execGh });
	await driveBugReport(fixture, { hint: "sanitize", confirmSubmit: true });
	assert.match(fixture.reports.at(-1), /boom second line/);
	assert.equal(fixture.reports.at(-1).includes("\u001b"), false);
	assert.equal(fixture.errors.join("\n").includes("\u001b"), false);
	assert.match(fixture.errors[0], /result is unknown/);
});
