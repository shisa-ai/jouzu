import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { transform } from "esbuild";

const source = await readFile(new URL("../upstream/vcc-goals/runtime.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { retainRequestRange, stripRequestRange, goalMetadata } = await import(
	`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);
const user = (content) => ({ role: "user", content, ...goalMetadata({ role: "user", content }) });

test("long contracts and later corrections keep a stable mandatory recall range", () => {
	const contract = Array.from(
		{ length: 30 },
		(_, i) => `Requirement ${i}: ${"exact contract detail ".repeat(20)}`,
	).join("\n");
	let summary = retainRequestRange("", [user(contract)], [42]);
	for (let i = 0; i < 20; i++) {
		summary = retainRequestRange(summary, [{ role: "user", jouzuGoalEligible: false }], [100 + i]);
		assert.match(summary, /range:\[42,42\]/);
	}
	summary = retainRequestRange(summary, [user("Correct the last requirement.")], [150]);
	assert.match(summary, /range:\[42,150\]/);
	assert.match(summary, /later corrections in order/);
	assert.match(summary, /expand truncated requests/);
	assert.equal(stripRequestRange(`${summary}\n[Session Goal]\n- retained`), "[Session Goal]\n- retained");
	assert.equal(stripRequestRange(`${summary}\n\n---\n\n[Session Goal]\n- retained`), "[Session Goal]\n- retained");
});

test("non-English and image-only requests are eligible without inventing missing indices", () => {
	assert.match(
		retainRequestRange("", [user("以前の条件を変更します。データを削除しないでください。")], [0]),
		/range:\[0,0\]/,
	);
	assert.match(
		retainRequestRange("", [user([{ type: "image", mimeType: "image/png", data: "fixture" }])], [5]),
		/range:\[5,5\]/,
	);
	assert.equal(retainRequestRange("", [user("Request without global index")]), "");
	assert.equal(retainRequestRange("", [{ role: "user", jouzuGoalEligible: false }], [1]), "");
	for (const index of [undefined, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
		assert.equal(retainRequestRange("", [user("Request")], [index]), "");
});

test("malformed prior ranges are ignored and nested transcript markers remain data", () => {
	for (const range of ["9,1", "9007199254740992,9007199254740993"])
		assert.equal(
			retainRequestRange(`[User request recall]\nBefore continuing work, use vcc_recall range:[${range}]`, []),
			"",
		);
	const marker = retainRequestRange("", [user("Request")], [5]);
	const transcript = `[Session Goal]\n- retained\n\n---\n\n[user]\n${marker}`;
	assert.equal(stripRequestRange(transcript), transcript);
	assert.equal(retainRequestRange(transcript, []), "");
});
