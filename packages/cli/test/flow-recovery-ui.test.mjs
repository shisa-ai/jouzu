import assert from "node:assert/strict";
import { test } from "node:test";
import { styleFlowReport } from "../dist/flow-control/flow-report-style.js";
import { createFlowStatusExtension } from "../dist/flow-control/flow-status-extension.js";
import { nativeHoldHash } from "../dist/flow-control/native-request-store.js";
import { terminalTextWidth } from "../dist/terminal-layout.js";
import { ExtensionSelectorComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/extension-selector.js";
import { initTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

test("native recovery selector handles navigation, confirmation, cancellation and narrow rendering", () => {
	initTheme("dark");
	let selected;
	let cancelled = false;
	const labels = ["Authorize retry: 日本語", "Release saved holds (does not resend)", "Show technical details"];
	const view = new ExtensionSelectorComponent(
		"Flow control",
		labels,
		(value) => {
			selected = value;
		},
		() => {
			cancelled = true;
		},
	);
	for (const width of [48, 80]) for (const line of view.render(width)) assert.ok(terminalTextWidth(line) <= width);
	view.handleInput("\u001b[B");
	view.handleInput("\r");
	assert.equal(selected, labels[1]);
	view.handleInput("\u001b[A");
	view.handleInput("\r");
	assert.equal(selected, labels[0]);
	view.handleInput("\u001b");
	assert.equal(cancelled, true);
	view.dispose();
});

function fixture() {
	let handler;
	const calls = [],
		notices = [];
	const request = { id: "request-1", outcome: "withheld", requiredSources: [0], sourceHash: "checked" };
	let branch = {
		scope: { sessionId: "s", branchId: "b" },
		recovery: {},
		sourceRecovery: {},
		waitSourceRecovery: { missing: [] },
		attachment: {
			waits: { snapshot: async () => [], authoritySnapshot: async () => ({ work: [] }) },
			submissions: { snapshot: async () => [] },
			nativeRequests: { snapshot: async () => [request] },
		},
	};
	const ingress = {
		branch: () => branch,
		inspect: async () => ({ scope: branch.scope, submissions: [], uncertain: [] }),
		automatedPause: () => undefined,
		retryNativeRequest: async (...args) => calls.push(["retry", ...args]),
		clearFlow: async (expected) => {
			if (expected) {
				const requests = JSON.stringify(await branch.attachment.nativeRequests.snapshot());
				if (branch !== expected.branch || requests !== expected.requests)
					throw Error("Flow confirmation changed while waiting");
			}
			calls.push(["clear"]);
			return { kind: "inactive", releasedRequests: 1 };
		},
	};
	createFlowStatusExtension({ ingress: () => ingress }).factory({
		on() {},
		registerMessageRenderer() {},
		registerCommand(_name, command) {
			handler = command.handler;
		},
	});
	const ctx = {
		mode: "tui",
		ui: {
			theme: { fg: (_color, text) => text },
			notify: (text) => notices.push(text),
			select: async () => undefined,
			confirm: async () => false,
		},
	};
	return {
		run: () => handler("", ctx),
		calls,
		notices,
		ctx,
		request,
		branch: () => branch,
		changeBranch: () => {
			branch = { ...branch };
		},
	};
}

test("flow selector cancellation changes nothing", async () => {
	const f = fixture();
	await f.run();
	assert.deepEqual(f.calls, []);
});
test("flow selector authorizes the displayed snapshot without resending", async () => {
	const f = fixture();
	f.ctx.ui.select = async (_title, choices) => choices.find((label) => label.startsWith("Authorize retry"));
	await f.run();
	assert.deepEqual(f.calls, [["retry", "request-1", nativeHoldHash(f.request)]]);
	assert.match(f.notices.at(-1), /Nothing was sent/);
});
test("flow clear requires confirmation and preserves cancellation", async () => {
	for (const confirmed of [false, true]) {
		const f = fixture();
		f.ctx.ui.select = async (_title, choices) => choices.find((label) => label.startsWith("Release saved"));
		f.ctx.ui.confirm = async () => confirmed;
		await f.run();
		assert.deepEqual(f.calls, confirmed ? [["clear"]] : []);
	}
});
test("branch change while choosing refuses the recovery action", async () => {
	const f = fixture();
	f.ctx.ui.select = async (_title, choices) => {
		f.changeBranch();
		return choices[0];
	};
	await f.run();
	assert.deepEqual(f.calls, []);
	assert.match(f.notices.at(-1), /changed while/);
});
test("a changed request during clear confirmation is not released", async () => {
	const f = fixture();
	f.ctx.ui.select = async (_title, choices) => choices.find((label) => label.startsWith("Release saved"));
	f.ctx.ui.confirm = async () => {
		f.request.sourceHash = "changed";
		return true;
	};
	await f.run();
	assert.deepEqual(f.calls, []);
	assert.match(f.notices.at(-1), /changed while/);
});

test("branch change during the post-confirmation snapshot refuses clear", async () => {
	const f = fixture();
	const store = f.branch().attachment.nativeRequests;
	let reads = 0;
	store.snapshot = async () => {
		if (++reads === 2) f.changeBranch();
		return [f.request];
	};
	f.ctx.ui.select = async (_title, choices) => choices.find((label) => label.startsWith("Release saved"));
	f.ctx.ui.confirm = async () => true;
	await f.run();
	assert.deepEqual(f.calls, []);
	assert.match(f.notices.at(-1), /changed/);
});

test("noninteractive flow never opens a selector", async () => {
	const f = fixture();
	f.ctx.mode = "rpc";
	f.ctx.ui.select = async () => {
		throw Error("must not open");
	};
	await f.run();
	assert.equal(f.notices.length, 1);
	assert.deepEqual(f.calls, []);
});
test("flow report distinguishes headings and input while plain text stays intact", () => {
	const report = "Blocked\n\nRequests not sent\n- You: 日本語\n  Reason: unresolved";
	const roles = [];
	assert.equal(
		styleFlowReport(report, {
			fg: (role, text) => {
				roles.push(role);
				return text;
			},
		}),
		report,
	);
	assert.deepEqual(roles, ["accent", "accent", "text", "muted"]);
});
