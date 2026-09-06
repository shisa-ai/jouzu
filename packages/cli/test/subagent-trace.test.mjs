import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSessionTrace } from "../dist/subagents/trace.js";

async function fixture(entries, operation) {
	const root = mkdtempSync(join(tmpdir(), "jouzu-trace-"));
	const path = join(root, "session.jsonl");
	const content = [{ type: "session", version: 3, id: "s" }, ...entries].map(JSON.stringify).join("\n") + "\n";
	writeFileSync(path, content);
	try {
		await operation(path, content);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
const message = (id, value) => ({ type: "message", id, timestamp: "2026-01-01T00:00:00.000Z", message: value });
const entries = [
	message("u", { role: "user", content: "Requirement 日本語" }),
	message("a", {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "THINKING_EXCLUDED" },
			{ type: "image", data: "IMAGE_EXCLUDED" },
			{ type: "toolCall", id: "call", name: "read", arguments: { path: "evidence.txt" } },
		],
		stopReason: "toolUse",
	}),
	message("r", {
		role: "toolResult",
		toolName: "read",
		toolCallId: "call",
		content: [{ type: "text", text: "EXACT_RESULT 日本語" }],
		isError: false,
	}),
	message("err", {
		role: "toolResult",
		toolName: "web_fetch",
		toolCallId: "web",
		content: [{ type: "text", text: "Fetch failed" }],
		details: { error: true },
		isError: false,
	}),
	{
		type: "compaction",
		id: "c",
		summary: "Saved decisions",
		retainedTail: [{ role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE" }] }],
	},
];

test("trace exposes arguments and linked results, filters evidence, and never rewrites the session", async () => {
	await fixture(entries, async (path, content) => {
		const all = await readSessionTrace(path);
		assert.equal(all.records.length, 5);
		assert.doesNotMatch(JSON.stringify(all), /THINKING_EXCLUDED|IMAGE_EXCLUDED|PRIVATE/);
		const tools = await readSessionTrace(path, { kind: "tools" });
		assert.equal(tools.records.length, 3);
		assert.equal(tools.records[0].calls[0].arguments.path, "evidence.txt");
		assert.equal(tools.records[1].toolCallId, tools.records[0].calls[0].id);
		assert.equal((await readSessionTrace(path, { query: "exact_result" })).records[0].entryId, "r");
		assert.equal((await readSessionTrace(path, { entryId: "r" })).records[0].text, "EXACT_RESULT 日本語");
		assert.deepEqual(
			(await readSessionTrace(path, { kind: "errors" })).records.map((record) => record.entryId),
			["err"],
		);
		assert.equal((await readSessionTrace(path, { kind: "compaction" })).records[0].summary, "Saved decisions");
		assert.equal(readFileSync(path, "utf8"), content);
	});
});

test("trace byte cursors preserve Unicode, filtering, and multiple tool calls in an entry", async () => {
	await fixture(
		[
			...entries,
			message("two", {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "x", name: "read", arguments: {} },
					{ type: "toolCall", id: "y", name: "ls", arguments: {} },
				],
			}),
		],
		async (path) => {
			const found = [];
			let offset = 0;
			do {
				const page = await readSessionTrace(path, { offset, limit: 1 });
				found.push(...page.records);
				offset = page.nextOffset;
			} while (offset !== null);
			assert.deepEqual(
				found.map((record) => record.entryId),
				["u", "a", "r", "err", "c", "two"],
			);
			assert.equal(found.at(-1).calls.length, 2);
			assert.doesNotMatch(JSON.stringify(found), /\ufffd/);
			await assert.rejects(readSessionTrace(path, { offset: 2 }), /start a JSONL line/);
			await assert.rejects(readSessionTrace(path, { limit: 101 }), /1–100/);
		},
	);
});

test("trace bounds large outputs, reports partial lines, and rejects malformed complete entries", async () => {
	await fixture([message("large", { role: "user", content: "日本語".repeat(100000) }), ...entries], async (path) => {
		const page = await readSessionTrace(path);
		assert.ok(Buffer.byteLength(JSON.stringify(page)) < 50000);
		assert.equal(page.records[0].truncated, true);
		assert.doesNotMatch(JSON.stringify(page), /\ufffd/);
		const original = readFileSync(path, "utf8");
		writeFileSync(path, original + '{"type":');
		const partial = await readSessionTrace(path);
		assert.equal(partial.nextOffset, Buffer.byteLength(original));
		assert.match(partial.notice, /incomplete/);
		writeFileSync(path, original + JSON.stringify(message("later", { role: "user", content: "Later" })) + "\n");
		assert.equal((await readSessionTrace(path, { offset: partial.nextOffset })).records[0].entryId, "later");
		writeFileSync(path, original + '{"broken":\n');
		await assert.rejects(readSessionTrace(path), /malformed complete JSONL entry at byte/);
	});
});

test("trace scan limits return a resumable cursor even when nothing matches", async () => {
	await fixture(
		Array.from({ length: 180 }, (_, index) => message(String(index), { role: "user", content: "x".repeat(50000) })),
		async (path) => {
			const page = await readSessionTrace(path, { query: "no-match" });
			assert.equal(page.records.length, 0);
			assert.ok(page.nextOffset > 0);
			assert.match(page.notice, /Scan limit/);
			const next = await readSessionTrace(path, { query: "no-match", offset: page.nextOffset });
			assert.equal(next.nextOffset, null);
		},
	);
});
