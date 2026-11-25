import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";

function harness(resumeTarget) {
	const calls = [];
	const fake = Object.create(InteractiveMode.prototype);
	const editor = {
		onSubmit: undefined,
		setText(text) {
			calls.push(["setText", text]);
		},
		addToHistory() {},
	};
	fake.defaultEditor = editor;
	fake.editor = editor;
	fake.pendingUserInputs = [];
	Object.defineProperty(fake, "session", { value: { isCompacting: false, isStreaming: false } });
	fake.flushPendingBashComponents = () => {};
	fake.runtimeHost = { resumeTarget };
	fake.handleResumeSession = async (path) => calls.push(["resume", path]);
	fake.showSessionSelector = (search) => calls.push(["picker", search]);
	InteractiveMode.prototype.setupEditorSubmitHandler.call(fake);
	return { fake, calls };
}

test("/resume with a startup row number opens that session; anything else opens the picker", async () => {
	const asked = [];
	const { fake, calls } = harness((argument) => {
		asked.push(argument);
		return argument === "2" ? "/sessions/two.jsonl" : undefined;
	});
	await fake.defaultEditor.onSubmit("/resume 2");
	await fake.defaultEditor.onSubmit("/resume   cache bug ");
	await fake.defaultEditor.onSubmit("/resume");
	await fake.defaultEditor.onSubmit("\uFF0Fresume 2");
	assert.deepEqual(asked, ["2", "cache bug", "2"], "a bare /resume asks for no target");
	assert.deepEqual(calls, [
		["setText", ""],
		["resume", "/sessions/two.jsonl"],
		["setText", ""],
		["picker", "cache bug"],
		["setText", ""],
		["picker", ""],
		["setText", ""],
		["resume", "/sessions/two.jsonl"],
	]);
	assert.deepEqual(fake.pendingUserInputs, [], "no /resume form reaches the model as a prompt");
});

test("/resume without a target resolver opens the picker with the typed search", async () => {
	const { fake, calls } = harness(undefined);
	await fake.defaultEditor.onSubmit("/resume 1");
	assert.deepEqual(calls, [
		["setText", ""],
		["picker", "1"],
	]);
	await fake.defaultEditor.onSubmit("/resumes");
	assert.deepEqual(fake.pendingUserInputs, ["/resumes"], "a longer command name is not /resume");
});

test("the picker opens with the search field filled in and filtered", () => {
	initTheme("dark");
	const fake = Object.create(InteractiveMode.prototype);
	let created;
	fake.showSelector = (create) => {
		created = create(() => {});
	};
	fake.runtimeHost = {};
	fake.keybindings = KeybindingsManager.create();
	fake.ui = { requestRender() {} };
	Object.defineProperty(fake, "sessionManager", {
		value: {
			getCwd: () => "/work",
			getSessionDir: () => "/nonexistent-jouzu-session-dir",
			usesDefaultSessionDir: () => false,
			getSessionFile: () => undefined,
		},
	});
	fake.showSessionSelector("cache bug");
	assert.equal(created.component.sessionList.searchInput.getValue(), "cache bug");
	created.component.dispose?.();
	fake.showSessionSelector();
	assert.equal(created.component.sessionList.searchInput.getValue(), "");
	created.component.dispose?.();
});
