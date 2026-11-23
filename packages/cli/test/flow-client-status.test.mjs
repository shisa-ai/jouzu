import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogText } from "../dist/cli-messages.js";
import {
	FLOW_INPUT_HOLDS,
	FLOW_LOCALIZED_INPUT_HOLDS,
	FLOW_RECOVERY_HOLDS,
	flowHold,
} from "../dist/flow-control/flow-hold-reasons.js";
import { createFlowStatusExtension, FLOW_STATUS_KEY } from "../dist/flow-control/flow-status-extension.js";
import { loadCatalog, resolveCatalog } from "../dist/locale-catalog.js";

const RECOVERY = "an interrupted turn has an unknown outcome";

function fixture({ inspectGate } = {}) {
	const state = { hold: RECOVERY, held: [{ id: "s1", admission: "held", reason: RECOVERY }] };
	const ingress = {
		automatedPause: () => undefined,
		recoveryHold: async () => state.hold,
		inspect: async () => {
			if (inspectGate) await inspectGate.promise;
			return { version: 1, scope: {}, submissions: state.held, uncertain: [] };
		},
	};
	const handlers = new Map();
	const extension = createFlowStatusExtension({ ingress: () => ingress });
	extension.factory({
		on: (name, fn) => handlers.set(name, fn),
		registerMessageRenderer() {},
		registerCommand() {},
	});
	const notices = [];
	const statuses = [];
	const ctx = (mode) => ({
		hasUI: true,
		mode,
		ui: {
			notify: (text) => notices.push(text),
			setStatus: (key, text) => key === FLOW_STATUS_KEY && statuses.push(JSON.parse(text)),
		},
	});
	const settle = async () => {
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
	};
	return { state, handlers, notices, statuses, ctx, settle };
}

const deferred = () => {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

test("a recovery hold released while it is being read is not announced", async () => {
	const gate = deferred();
	const f = fixture({ inspectGate: gate });
	f.handlers.get("session_start")({}, f.ctx("tui"));
	await f.settle();
	// The user's /flow clear completes while the announcement is reading the held work.
	f.state.hold = undefined;
	f.state.held = [];
	gate.resolve();
	await f.settle();
	assert.deepEqual(f.notices, []);
});

test("one recovery hold is announced once, however many sessions start", async () => {
	const f = fixture();
	f.handlers.get("session_start")({}, f.ctx("tui"));
	f.handlers.get("session_start")({}, f.ctx("tui"));
	await f.settle();
	f.handlers.get("session_start")({}, f.ctx("tui"));
	await f.settle();
	assert.equal(f.notices.filter((text) => /holding/i.test(text)).length, 1, f.notices.join("\n"));
});

test("clients without a terminal get read-only structured state; the terminal does not", async () => {
	const tui = fixture();
	tui.handlers.get("session_start")({}, tui.ctx("tui"));
	await tui.settle();
	assert.deepEqual(tui.statuses, []);

	const f = fixture();
	f.handlers.get("session_start")({}, f.ctx("rpc"));
	await f.settle();
	const [status] = f.statuses;
	assert.equal(status.version, 1);
	assert.equal(status.enabled, true);
	assert.equal(status.recovery.code, "interrupted-outcome");
	assert.equal(typeof status.recovery.text, "string");
	assert.deepEqual(
		status.held.map(({ id, code }) => ({ id, code })),
		[{ id: "s1", code: "interrupted-outcome" }],
	);
	assert.deepEqual(status.withheld, []);
	assert.deepEqual(status.uncertain, []);
	// The state follows the release, latest reading wins, and repeats are not resent.
	f.state.hold = undefined;
	f.state.held = [];
	f.handlers.get("agent_end")({}, f.ctx("rpc"));
	f.handlers.get("agent_end")({}, f.ctx("rpc"));
	await f.settle();
	assert.equal(f.statuses.length, 2);
	assert.equal(f.statuses[1].recovery, undefined);
	assert.deepEqual(f.statuses[1].held, []);
});

const LOCALES = ["en", "ja", "zh-Hans", "zh-Hant"];
const catalogFor = (locale) => (locale.startsWith("zh-") ? loadCatalog(locale) : resolveCatalog(locale).bundle);

test("every hold reason Jouzu records has one kebab-case code and translated text", () => {
	const entries = [...Object.entries(FLOW_RECOVERY_HOLDS), ...Object.entries(FLOW_INPUT_HOLDS)];
	assert.equal(new Set(entries.map(([, entry]) => entry.reason)).size, entries.length, "each reason is distinct");
	for (const locale of LOCALES) {
		const catalog = catalogFor(locale);
		for (const [code, entry] of entries) {
			assert.match(code, /^[a-z]+(-[a-z]+)*$/);
			assert.deepEqual(flowHold(entry.reason, catalog)?.code, code, entry.reason);
			if (!entry.message) continue;
			const key = `jouzu.cli.flow.control.${entry.message}`;
			const text = catalogText(catalog, key);
			assert.ok(text && text !== key, `${locale} ${key}`);
		}
		// Holds recorded as catalog text map back in the language they were recorded in.
		for (const [code, id] of FLOW_LOCALIZED_INPUT_HOLDS)
			assert.equal(flowHold(catalogText(catalog, id), catalog)?.code, code, `${locale} ${id}`);
	}
	assert.equal(flowHold("a reason from a host policy", catalogFor("en")), undefined);
});

test("held input reports the table code, and an unknown reason reports other", async () => {
	const f = fixture();
	f.state.hold = undefined;
	f.state.held = [
		{ id: "s1", admission: "held", reason: FLOW_INPUT_HOLDS["queued-work"].reason },
		{ id: "s2", admission: "held", reason: FLOW_INPUT_HOLDS["host-policy-failed"].reason },
		{ id: "s3", admission: "held", reason: "a reason from a host policy" },
	];
	f.handlers.get("session_start")({}, f.ctx("rpc"));
	await f.settle();
	assert.deepEqual(
		f.statuses[0].held.map(({ id, code }) => ({ id, code })),
		[
			{ id: "s1", code: "queued-work" },
			{ id: "s2", code: "host-policy-failed" },
			{ id: "s3", code: "other" },
		],
	);
});
