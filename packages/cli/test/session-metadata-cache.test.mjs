import assert from "node:assert/strict";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CURRENT_SESSION_VERSION, initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createSessionMetadataCache } from "../dist/session-metadata-cache.js";
import { SessionSelectorComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/session-selector.js";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "jouzu-session-list-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, "sessions");
	mkdirSync(dir);
	const cacheDir = join(root, "cache");
	const cachePath = join(cacheDir, "session-list", "v1.sqlite");
	const open = createSessionMetadataCache(cacheDir);
	const timestamp = "2025-01-02T03:04:05.000Z";
	const rows = (id, cwd, first) =>
		[
			{ type: "session", version: CURRENT_SESSION_VERSION, id, cwd, timestamp },
			{ type: "message", message: { role: "user", content: first, timestamp: 1 } },
			{ type: "message", message: { role: "assistant", content: "search-only 日本語", timestamp: 2 } },
		]
			.map((row) => JSON.stringify(row))
			.join("\n") + "\n";
	const file = join(dir, "example.jsonl");
	writeFileSync(file, rows("old", root, "🌱".repeat(200)));
	return { root, dir, file, open, cachePath, rows };
}

test("session metadata survives reopen without retaining full conversation text", async (t) => {
	const { root, dir, file, open, cachePath } = fixture(t);
	const cold = await SessionManager.list(root, dir, undefined, undefined, false, open);
	assert.equal(cold.length, 1);
	assert.ok(cold[0].firstMessage.endsWith("…"));
	assert.equal(cold[0].allMessagesText, "");
	const warm = await SessionManager.listAll(dir, undefined, undefined, false, () => {
		const cache = open();
		return { ...cache, put: () => assert.fail("an unchanged file must be a cache hit") };
	});
	assert.deepEqual(warm, cold);
	const [full] = await SessionManager.list(root, dir);
	assert.match(full.allMessagesText, /search-only 日本語/u);
	const db = new DatabaseSync(cachePath, { readOnly: true });
	try {
		const { data } = db.prepare("SELECT data FROM sessions WHERE path = ?").get(file);
		assert.ok(!data.includes("search-only"));
		assert.ok(!data.includes("allMessagesText"));
		if (process.platform !== "win32") assert.equal(statSync(cachePath).mode & 0o777, 0o600);
	} finally {
		db.close();
	}
});

test("append, same-size replacement, a different project and deletion are discovered from disk", async (t) => {
	const { root, dir, file, open, rows } = fixture(t);
	const list = () => SessionManager.list(root, dir, undefined, undefined, false, open);
	assert.equal((await list())[0].id, "old");
	appendFileSync(file, '{"type":"session_info","name":"Renamed"}\n');
	assert.equal((await list())[0].name, "Renamed");
	const original = statSync(file);
	const replacement = join(dir, "replacement");
	writeFileSync(replacement, rows("new", root, "🌱".repeat(200)) + '{"type":"session_info","name":"Changed"}\n');
	assert.equal(statSync(replacement).size, original.size);
	utimesSync(replacement, original.atime, original.mtime);
	renameSync(replacement, file);
	assert.equal((await list())[0].id, "new");
	writeFileSync(file, rows("another", dir, "hello"));
	assert.deepEqual(await list(), []);
	assert.equal((await SessionManager.listAll(dir, undefined, undefined, false, open))[0].id, "another");
	rmSync(file);
	assert.deepEqual(await SessionManager.listAll(dir, undefined, undefined, false, open), []);
});

test("a missing, damaged or locked cache never prevents listing", async (t) => {
	const { root, dir, open, cachePath } = fixture(t);
	mkdirSync(dirname(cachePath), { recursive: true });
	writeFileSync(cachePath, "not SQLite");
	const list = (cache) => SessionManager.list(root, dir, undefined, undefined, false, cache);
	const expected = await list(open);
	assert.equal(expected.length, 1);
	assert.equal(expected[0].allMessagesText, "");
	rmSync(cachePath);
	assert.deepEqual(await list(open), expected);
	const db = new DatabaseSync(cachePath);
	try {
		db.exec("BEGIN EXCLUSIVE");
		assert.deepEqual(await list(open), expected);
	} finally {
		db.close();
	}
	assert.match((await list())[0].allMessagesText, /search-only/u);
});

test("typing triggers full-text search only for the active scope and Cancel aborts reads", async (t) => {
	initTheme("dark");
	const { root, dir, file, open } = fixture(t);
	const calls = [];
	const requests = [];
	const loader = (scope) => (progress, signal, fullText) => {
		calls.push([scope, !!fullText]);
		const promise = SessionManager.list(root, dir, progress, signal, false, fullText ? undefined : open);
		requests.push({ signal, promise });
		return promise;
	};
	const selected = [];
	const selector = new SessionSelectorComponent(
		loader("current"),
		loader("all"),
		(path) => selected.push(path),
		() => {},
		() => {},
		() => {},
		{ searchOnDemand: true },
	);
	const list = selector.getSessionList();
	await requests[0].promise;
	assert.deepEqual(calls, [["current", false]]);
	assert.equal(list.getSelectedSessionPath(), file);
	const query = '"search-only 日本語"';
	list.handleInput(`\x1b[200~${query}\x1b[201~`);
	const loading = list.render(48);
	assert.ok(loading.every((line) => visibleWidth(line) <= 48));
	assert.doesNotMatch(stripTerminalSequences(loading.join("\n")), /No sessions/u);
	assert.equal(list.getSelectedSessionPath(), undefined);
	await requests[1].promise;
	assert.equal(list.getSelectedSessionPath(), file);
	list.handleInput("\t");
	assert.deepEqual(calls, [
		["current", false],
		["current", true],
		["all", true],
	]);
	list.handleInput("\x1b");
	assert.equal(requests[2].signal.aborted, true);
	await assert.rejects(requests[2].promise, { name: "AbortError" });
	assert.deepEqual(selected, []);
});
