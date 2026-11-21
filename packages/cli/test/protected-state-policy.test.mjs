import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createProtectedStateExtension } from "../dist/protected-state-policy.js";

function handlerFor(roots) {
	let handler;
	createProtectedStateExtension(roots).factory({
		on(name, fn) {
			if (name === "tool_call") handler = fn;
		},
	});
	return (toolName, input, cwd) => handler({ type: "tool_call", toolCallId: "t", toolName, input }, { cwd });
}

test("file tools cannot write Jouzu state or cache, by any spelling of the path", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-protected-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = join(root, "home", "state");
	const cache = join(root, "home", "cache");
	const workspace = join(root, "workspace");
	await mkdir(join(cache, "textguard"), { recursive: true });
	await mkdir(state, { recursive: true });
	await mkdir(workspace, { recursive: true });
	await symlink(cache, join(workspace, "linked-cache"));
	// Links whose target does not exist yet: writing through them would create the target.
	await symlink(join(cache, "textguard", "approvals.json"), join(workspace, "dangling.json"));
	await symlink(join(workspace, "dangling.json"), join(workspace, "dangling-chain.json"));
	await symlink(join(cache, "not-yet"), join(workspace, "dangling-folder"));
	const call = handlerFor([state, cache]);
	for (const [tool, path] of [
		["write", join(cache, "textguard", "approvals.json")],
		["edit", join(state, "flow", "journal.jsonl")],
		["write", `@${join(cache, "textguard", "approvals.json")}`],
		["write", "../home/cache/textguard/approvals.json"],
		["write", "linked-cache/textguard/approvals.json"],
		["write", "linked-cache/new-folder/file.json"],
		["write", "dangling.json"],
		["write", "dangling-chain.json"],
		["write", "dangling-folder/file.json"],
		["edit", cache],
		["write", pathToFileURL(join(cache, "textguard", "approvals.json")).href],
		["write", "file://remote-host/not-a-local-path"],
	]) {
		const result = call(tool, { path, content: "{}" }, workspace);
		assert.equal(result?.block, true, `${tool} ${path}`);
		assert.match(result.reason, /read-only for tools/);
	}
});

test("other paths and tools that do not write files are unaffected", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-protected-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const cache = join(root, "home", "cache");
	const workspace = join(root, "workspace");
	await mkdir(cache, { recursive: true });
	await mkdir(workspace, { recursive: true });
	const call = handlerFor([cache]);
	assert.equal(call("write", { path: "notes.md", content: "x" }, workspace), undefined);
	assert.equal(call("write", { path: join(root, "home", "cache-sibling", "x") }, workspace), undefined);
	assert.equal(call("read", { path: join(cache, "textguard", "approvals.json") }, workspace), undefined);
	assert.equal(call("write", { content: "no path" }, workspace), undefined);
});

test("on Windows, a shell-style drive path into Jouzu state is refused", {
	skip: process.platform !== "win32",
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jouzu-protected-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const state = join(root, "home", "state");
	await mkdir(state, { recursive: true });
	const call = handlerFor([state]);
	const [drive, rest] = [state[0].toLowerCase(), state.slice(3).replaceAll("\\", "/")];
	for (const path of [`/${drive}/${rest}/x.json`, `/mnt/${drive}/${rest}/x.json`, `/cygdrive/${drive}/${rest}/x.json`])
		assert.equal(call("write", { path, content: "{}" }, root)?.block, true, path);
});
