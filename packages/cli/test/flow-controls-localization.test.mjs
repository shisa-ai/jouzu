import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogText } from "../dist/cli-messages.js";
import { providerPause } from "../dist/flow-control/flow-pause.js";
import { createFlowStatusExtension } from "../dist/flow-control/flow-status-extension.js";
import { FlowLedgerError } from "../dist/flow-control/receipt-ledger.js";
import { loadCatalog, resolveCatalog } from "../dist/locale-catalog.js";

function fixture(locale, overrides = {}) {
	const notices = [];
	const events = new Map();
	let handler;
	const ingress = {
		automatedPause: () => undefined,
		recoveryHold: async () => undefined,
		inspect: async () => ({ submissions: [], uncertain: [] }),
		branch: () => ({ attachment: { nativeRequests: { snapshot: async () => [], recoveryBlocked: false } } }),
		resumeAutomated: () => false,
		clearFlow: async () => ({ kind: "inactive" }),
		resolveUncertainAttempt: async () => {
			throw new FlowLedgerError("identity", "unknown");
		},
		changeWorkStatus: async () => {
			throw new FlowLedgerError("identity", "unknown");
		},
		cancelWait: async () => {},
		...overrides,
	};
	const catalog = locale.startsWith("zh-") ? loadCatalog(locale) : resolveCatalog(locale).bundle;
	const extension = createFlowStatusExtension({ ingress: () => ingress, catalog });
	extension.factory({
		registerMessageRenderer() {},
		on: (name, callback) => events.set(name, callback),
		registerCommand: (_name, command) => {
			handler = command.handler;
		},
	});
	const ctx = { hasUI: true, ui: { notify: (text) => notices.push(text) } };
	return {
		notices,
		extension,
		catalog,
		run: (args) => handler(args, ctx),
		start: () => events.get("session_start")({}, ctx),
	};
}

for (const locale of ["en", "ja", "zh-Hans", "zh-Hant"]) {
	test(`/flow controls use the ${locale} catalog and preserve command syntax and identifiers`, async () => {
		const f = fixture(locale);
		const text = (key, args) => catalogText(f.catalog, `jouzu.cli.flow.control.${key}`, args);
		const usage = Array.from({ length: 13 }, (_, index) => text(`usage${index + 1}`)).join("\n");
		for (const command of ["help", "off extra", "reset wrong", "resolve id unknown"]) {
			await f.run(command);
			assert.equal(f.notices.at(-1), usage);
		}
		assert.match(f.notices.at(-1), /\/flow resolve <attempt> retry\|discard/);
		for (const [command, key, args] of [
			["off", "cannotSwitch"],
			["resume", "notPaused"],
			["clear", "clearInactive"],
			["retry req-原文", "noRetry", { target: "req-原文" }],
			["resolve attempt-原文 retry", "noInterrupted", { target: "attempt-原文" }],
			["stop work-原文", "noWork", { target: "work-原文" }],
			["cancel wait-原文", "waitCancelled", { target: "wait-原文" }],
		]) {
			await f.run(command);
			assert.equal(f.notices.at(-1), text(key, args));
		}
		if (locale !== "en") assert.doesNotMatch(usage, /shows what session|authorizes one withheld/);
	});

	test(`/flow ${locale} provider notice preserves diagnostic detail and localizes the reason`, async () => {
		const detail = "HTTP 429: rate_limit_error 日本語 request-id=abc-123";
		const f = fixture(locale, { automatedPause: () => providerPause(detail) });
		await f.start();
		await f.extension.announcePause();
		assert.ok(f.notices.at(-1).includes(detail));
		assert.match(f.notices.at(-1), /\/flow/);
		if (locale !== "en") assert.doesNotMatch(f.notices.at(-1), /Flow control paused after|a provider request failed/);
	});

	test(`/flow ${locale} localizes known recovery holds and deduplicates input notices`, async () => {
		const f = fixture(locale, {
			recoveryHold: async () => "a withheld request needs a decision",
			inspect: async () => ({ submissions: [{ admission: "held" }], uncertain: [] }),
		});
		await f.start();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(
			f.notices[0],
			catalogText(f.catalog, "jouzu.cli.flow.control.recoveryHold", {
				reason: catalogText(f.catalog, "jouzu.cli.flow.control.requestDecision"),
			}),
		);
		f.extension.announceHeldInput({ id: "one", reason: "original external reason" });
		f.extension.announceHeldInput({ id: "one", reason: "original external reason" });
		assert.equal(f.notices.length, 2);
		assert.ok(f.notices[1].includes("original external reason"));
		f.extension.announceHeldInput({ id: "two", reason: "Input is waiting for queued user work." });
		assert.equal(
			f.notices.at(-1),
			catalogText(f.catalog, "jouzu.cli.flow.control.heldInput", {
				reason: catalogText(f.catalog, "jouzu.cli.flow.control.queuedWork"),
			}),
		);
	});

	test(`/flow ${locale} operation failure retains bounded, redacted diagnostics`, async () => {
		const f = fixture(locale, {
			clearFlow: async () => {
				throw new Error("HTTP 503 upstream unavailable");
			},
		});
		await f.run("clear");
		assert.equal(
			f.notices.at(-1),
			`${catalogText(f.catalog, "jouzu.cli.flow.control.operationFailed1", { detail: "HTTP 503 upstream unavailable" })}\n${catalogText(f.catalog, "jouzu.cli.flow.control.operationFailed2")}`,
		);
	});
}
