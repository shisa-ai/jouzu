import assert from "node:assert/strict";
import { test } from "node:test";
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { loadCatalog } from "../dist/locale-catalog.js";
import { withPiUiLocalization } from "../dist/pi-ui-localization.js";
import { assertLinesFit, renderedText } from "./fixtures/pi-ui-localization.mjs";

const failure = "Compaction failed: Nothing to compact (session too small)";

function host() {
	const children = [];
	const h = {
		children,
		chatContainer: { addChild: (child) => children.push(child) },
		ui: { requestRender() {} },
		outputPad: 1,
		isInitialized: true,
		footer: { invalidate() {} },
		programStatus: { handleEvent() {} },
		settingsManager: { getShowTerminalProgress: () => false },
		clearStatusIndicator() {},
		flushCompactionQueue: async () => {},
		showError: (...args) => InteractiveMode.prototype.showError.call(h, ...args),
	};
	return h;
}

test("the native too-small compaction error renders in Japanese without changing its source", async () => {
	initTheme("dark");
	const original = InteractiveMode.prototype.showError;
	const h = host();
	const addChild = h.chatContainer.addChild;
	const event = { type: "compaction_end", reason: "manual", aborted: false, errorMessage: failure };
	await withPiUiLocalization(loadCatalog("ja"), async () => {
		await InteractiveMode.prototype.handleEvent.call(h, event);
		assert.equal(h.chatContainer.addChild, addChild);
		const component = h.children.at(-1);
		for (const width of [48, 80]) {
			assert.match(renderedText(component, width), /セッションが短すぎる/u);
			assert.doesNotMatch(renderedText(component, width), /Error:|Compaction failed|Nothing to compact/u);
			assertLinesFit(assert, component, width);
		}
		component.invalidate();
		assert.match(renderedText(component, 48), /セッションが短すぎる/u);
		InteractiveMode.prototype.showError.call(h, "Compaction failed: provider detail stays exact");
		assert.match(renderedText(h.children.at(-1), 100), /Error: Compaction failed: provider detail stays exact/u);
	});
	assert.equal(InteractiveMode.prototype.showError, original);
	assert.equal(event.errorMessage, failure);
	assert.equal(failure, "Compaction failed: Nothing to compact (session too small)");
	const english = host();
	await withPiUiLocalization(loadCatalog("en"), async () => {
		InteractiveMode.prototype.showError.call(english, failure);
	});
	assert.equal(renderedText(english.children.at(-1), 100).trim(), `Error: ${failure}`);
});

test("compaction display follows locale updates and restores native methods after failure", async () => {
	initTheme("dark");
	const original = InteractiveMode.prototype.showError;
	let catalog = loadCatalog("ja");
	const h = host();
	await assert.rejects(
		withPiUiLocalization(
			() => catalog,
			async () => {
				h.showError(failure);
				const component = h.children.at(-1);
				assert.match(renderedText(component, 100), /セッションが短すぎる/u);
				catalog = loadCatalog("en");
				component.invalidate();
				assert.equal(renderedText(component, 100).trim(), `Error: ${failure}`);
				throw new Error("operation failed");
			},
		),
		/operation failed/u,
	);
	assert.equal(InteractiveMode.prototype.showError, original);
});
