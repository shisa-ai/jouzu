import { execFile } from "node:child_process";
import { getKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { VERSION } from "../../config.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
export const ISSUE_NEW_URL = "https://github.com/shisa-ai/jouzu/issues/new";
export const ISSUES_URL = "https://github.com/shisa-ai/jouzu/issues";
const ISSUE_REPOSITORY = "shisa-ai/jouzu";
const ISSUE_REPOSITORY_URL = "https://github.com/shisa-ai/jouzu";
const GITHUB_HOSTNAME = "github.com";
const ISSUE_URL_PATTERN = /^https:\/\/github\.com\/shisa-ai\/jouzu\/issues\/\d+$/;
const GH_TIMEOUT_MS = 10_000;
const GH_MAX_OUTPUT_BYTES = 64 * 1024;
const TITLE_MAX_LENGTH = 80;
const NOT_PROVIDED = "Not provided.";
const INTRO = `This drafts a public GitHub issue for ${ISSUE_REPOSITORY}. Nothing is posted without your review, and the draft is never sent to a model. Submission with gh is offered only when an authenticated gh account is available. New issue form: ${ISSUE_NEW_URL}`;
/** Build the deterministic Markdown draft shown for review and posted only on consent. */
export function buildBugReportDraft(options) {
	const description = field(options.description);
	const expected = field(options.expected);
	const actual = field(options.actual);
	const reproduction = field(options.reproduction);
	return {
		title: titleFrom(description),
		body: [
			"## What happened",
			"",
			description,
			"",
			"## Expected behavior",
			"",
			expected,
			"",
			"## Actual behavior",
			"",
			actual,
			"",
			"## Steps to reproduce",
			"",
			reproduction,
			"",
			"## Environment",
			"",
			...environmentLines(options.runtimeIdentity).map((line) => `- ${line}`),
			"",
		].join("\n"),
	};
}
/** Render the reviewed draft; the public new-issue form link is always attached. */
export function renderBugReport(draft, note) {
	const parts = [`# ${draft.title}`, "", draft.body.trimEnd()];
	if (note) parts.push("", "---", "", note);
	parts.push("", `New issue form: ${ISSUE_NEW_URL}`, "");
	return parts.join("\n");
}
/** Run the `/bug` flow: draft, review, then optional submission with an authenticated gh. */
export async function reportBug(context, initialHint) {
	const description = await input(
		context,
		"Report a Jouzu bug",
		`${INTRO}\n\nWhat went wrong? (optional)`,
		initialHint,
	);
	if (description === null) return cancel(context);
	const expected = await input(context, "Expected behavior", "What did you expect to happen? (optional)");
	if (expected === null) return cancel(context);
	const actual = await input(context, "Actual behavior", "What happened instead? (optional)");
	if (actual === null) return cancel(context);
	const reproduction = await input(context, "Steps to reproduce", "How can we reproduce it? (optional)");
	if (reproduction === null) return cancel(context);
	const draft = buildBugReportDraft({
		description,
		expected,
		actual,
		reproduction,
		runtimeIdentity: context.runtimeIdentity,
	});
	const body = await edit(context, "Review the report body", draft.body);
	draft.body = body.value.trim() || draft.body;
	if (body.cancelled) return cancel(context, draft, "Report cancelled; the draft was not posted.");
	const title = await input(
		context,
		"Review the issue title",
		"This becomes the public GitHub issue title.",
		draft.title,
	);
	if (title === null) return cancel(context, draft, "Report cancelled; the draft was not posted.");
	draft.title = title.trim() || draft.title;
	showDraft(context, draft, "Review this draft before submitting. Nothing has been posted yet.");
	const gh = await detectGh(context);
	if (!gh.account) {
		showDraft(context, draft, `${gh.reason}. Copy the draft above into the new-issue form to post it.`);
		context.showStatus("Draft ready; nothing was posted.");
		return;
	}
	const submitLabel = `Submit as ${gh.account} using gh`;
	const confirmed = await choose(
		context,
		"Submit this public issue?",
		["No, keep the draft", submitLabel],
		`This creates a public issue in ${ISSUE_REPOSITORY} as ${gh.account}.\n\nTitle: ${draft.title}\n\nThe issue and everything in it are public. Review the draft above before continuing.`,
	);
	if (confirmed !== submitLabel) {
		showDraft(context, draft, "Not submitted. Copy the draft above into the new-issue form to post it.");
		context.showStatus("Draft kept; nothing was posted.");
		return;
	}
	try {
		const issueUrl = await createIssue(context, draft);
		showDraft(context, draft, `Issue created: ${issueUrl}`);
		context.showStatus(`Issue created: ${issueUrl}`);
	} catch (error) {
		const message = errorMessage(error);
		showDraft(
			context,
			draft,
			`Submission result is unknown: ${message}. Check ${ISSUES_URL} for a new issue before retrying; the reviewed draft is kept and the new-issue form is below.`,
		);
		context.showError(`The issue creation result is unknown: ${message}. Check ${ISSUES_URL} before retrying.`);
	}
}
function cancel(context, draft, note) {
	if (draft) showDraft(context, draft, note);
	context.showStatus("Bug report cancelled");
}
function field(value) {
	const text = typeof value === "string" ? value.trim() : "";
	return text || NOT_PROVIDED;
}
function titleFrom(description) {
	if (description === NOT_PROVIDED) return "Bug report";
	const line =
		description
			.split(/\r?\n/)
			.map((part) => part.trim())
			.find(Boolean) ?? "Bug report";
	return line.length > TITLE_MAX_LENGTH ? `${line.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…` : line;
}
function environmentLines(runtimeIdentity) {
	const identity = typeof runtimeIdentity === "string" ? runtimeIdentity.trim() : "";
	const runtime = identity ? identity.replace(/^Runtime:\s*/i, "") : `Pi ${VERSION}`;
	const engine = process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`;
	return [`Runtime: ${runtime}`, `OS: ${process.platform} ${process.arch}`, engine];
}
async function detectGh(context) {
	try {
		const { stdout } = await runGh(context, ["api", "user", "--hostname", GITHUB_HOSTNAME, "--jq", ".login"]);
		const account = sanitizeTerminalText(stdout);
		if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(account))
			return { reason: "gh did not report an authenticated GitHub account" };
		return { account };
	} catch (error) {
		if (error?.code === "ENOENT") return { reason: "gh is not installed" };
		return { reason: "gh is not authenticated" };
	}
}
function runGh(context, args) {
	return (context.execGh ?? execGh)(args);
}
function execGh(args) {
	return new Promise((resolve, reject) => {
		execFile(
			"gh",
			args,
			{ encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_OUTPUT_BYTES, windowsHide: true },
			(error, stdout, stderr) => {
				if (error) {
					if (stderr && !error.stderr) error.stderr = stderr;
					reject(error);
					return;
				}
				resolve({ stdout, stderr });
			},
		);
	});
}
async function createIssue(context, draft) {
	const { stdout } = await runGh(context, [
		"issue",
		"create",
		"--repo",
		ISSUE_REPOSITORY_URL,
		"--title",
		draft.title,
		"--body",
		draft.body,
	]);
	const issueUrl = sanitizeTerminalText(stdout);
	if (!ISSUE_URL_PATTERN.test(issueUrl)) throw new Error("gh did not return a Jouzu GitHub issue URL");
	return issueUrl;
}
function showDraft(context, draft, note) {
	const markdown = renderBugReport(draft, note);
	if (context.showReport) context.showReport(markdown);
	else context.showStatus(markdown);
}
function input(context, title, description, initialValue) {
	return new Promise((resolve) => {
		let component;
		const finish = (value) => {
			restoreEditor(context, component);
			resolve(value);
		};
		component = new ExtensionInputComponent(
			title,
			undefined,
			(value) => finish(value),
			() => finish(null),
			{
				initialValue,
				description,
			},
		);
		showOverlay(context, component);
	});
}
function choose(context, title, options, description) {
	return new Promise((resolve) => {
		let component;
		const finish = (value) => {
			restoreEditor(context, component);
			resolve(value);
		};
		component = new ExtensionSelectorComponent(title, options, finish, () => finish(), {
			tui: context.ui,
			description,
		});
		showOverlay(context, component);
	});
}
function edit(context, title, prefill) {
	return new Promise((resolve) => {
		let component;
		const finish = (result) => {
			restoreEditor(context, component);
			resolve(result);
		};
		component = new ExtensionEditorComponent(
			context.ui,
			getKeybindings(),
			title,
			prefill,
			(value) => finish({ value, cancelled: false }),
			() => finish({ value: component.editor.getText(), cancelled: true }),
		);
		showOverlay(context, component);
	});
}
function showOverlay(context, component) {
	context.editorContainer.clear();
	context.editorContainer.addChild(component);
	context.ui.setFocus(component);
	context.ui.requestRender();
}
function restoreEditor(context, component) {
	component.dispose?.();
	context.editorContainer.clear();
	context.editorContainer.addChild(context.editor);
	context.ui.setFocus(context.editor);
	context.ui.requestRender();
}
/** Strip ANSI/OSC/APC sequences and remaining control characters from untrusted gh output. */
function sanitizeTerminalText(value) {
	const stripped = stripTerminalSequences(String(value ?? ""));
	let text = "";
	for (const character of stripped) {
		const code = character.codePointAt(0) ?? 0;
		text += code < 0x20 || code === 0x7f ? " " : character;
	}
	return text.replace(/\s+/g, " ").trim();
}
function errorMessage(error) {
	return sanitizeTerminalText(error instanceof Error ? error.message : "") || "Unknown error";
}
