import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import {
	ProfileChoiceError,
	parseJapaneseSupportAnswer,
	promptForJapaneseSupport,
	readProfileChoice,
	writeProfileChoice,
} from "../dist/profile-choice.js";

function temporaryChoicePath() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-profile-choice-"));
	return { root, path: join(root, "state", "profile-choice.json") };
}

test("profile choice is absent until explicit first-run input is persisted", () => {
	const { root, path } = temporaryChoicePath();
	try {
		assert.equal(readProfileChoice(path), undefined);
		const written = writeProfileChoice(path, "ja", new Date("2026-08-20T12:00:00.000Z"));
		assert.deepEqual(written, {
			schemaVersion: 1,
			profile: "ja",
			chosenAt: "2026-08-20T12:00:00.000Z",
		});
		assert.deepEqual(readProfileChoice(path), written);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Japanese support requires an affirmative answer and defaults to Core", () => {
	for (const answer of ["y", "YES", "はい", " yes "]) assert.equal(parseJapaneseSupportAnswer(answer), "ja");
	for (const answer of ["", "n", "no", "later", "いいえ"]) assert.equal(parseJapaneseSupportAnswer(answer), "core");
});

test("the first-run prompt explains the optional profile before accepting consent", async () => {
	let output = "";
	const profile = await promptForJapaneseSupport(
		Readable.from(["yes\n"]),
		new Writable({
			write(chunk, _encoding, callback) {
				output += chunk.toString();
				callback();
			},
		}),
	);
	assert.equal(profile, "ja");
	assert.match(output, /optional Japanese-support profile/);
	assert.match(output, /Existing profile files are checked for conflicts/);
	assert.match(output, /\[y\/N\]/);
});

test("profile choice parsing rejects malformed and unsafe state", () => {
	const { root, path } = temporaryChoicePath();
	try {
		mkdirSync(join(root, "state"), { recursive: true });
		writeFileSync(path, '{"schemaVersion":1,"profile":"ja","chosenAt":"now","unknown":true}\n');
		assert.throws(() => readProfileChoice(path), ProfileChoiceError);
		if (process.platform !== "win32") {
			rmSync(path);
			const target = join(root, "choice-target.json");
			writeFileSync(target, '{"schemaVersion":1,"profile":"core","chosenAt":"2026-08-20T12:00:00.000Z"}\n');
			symlinkSync(target, path);
			assert.throws(() => readProfileChoice(path), /regular file/);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
