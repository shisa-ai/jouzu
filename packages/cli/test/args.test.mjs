import assert from "node:assert/strict";
import { test } from "node:test";
import { isBlockedPiSelfUpdate, parseJouzuArgs, UsageError } from "../dist/args.js";

test("forwards Pi arguments without reconstructing them", () => {
	const unicodeArgs = ["--provider", "openai", "@仕様 書.md", "日本語のメッセージ"];
	assert.deepEqual(parseJouzuArgs(unicodeArgs), {
		kind: "pi",
		options: {},
		args: unicodeArgs,
	});
});

test("supports explicit Pi escape forms and leading Jouzu options", () => {
	assert.deepEqual(parseJouzuArgs(["--jouzu-home", "/tmp/上手 home", "pi", "--help"]), {
		kind: "pi",
		options: { home: "/tmp/上手 home" },
		args: ["--help"],
	});
	assert.deepEqual(parseJouzuArgs(["--jouzu-profile=core", "--", "doctor"]), {
		kind: "pi",
		options: { profile: "core" },
		args: ["doctor"],
	});
});

test("reserves Jouzu diagnostics while allowing escaped Pi collisions", () => {
	assert.deepEqual(parseJouzuArgs(["doctor"]), { kind: "doctor", options: {} });
	assert.deepEqual(parseJouzuArgs(["pi", "doctor"]), { kind: "pi", options: {}, args: ["doctor"] });
	assert.deepEqual(parseJouzuArgs(["--version"]), { kind: "version", options: {} });
});

test("rejects invalid Jouzu options", () => {
	assert.throws(() => parseJouzuArgs(["--jouzu-profile", "other"]), UsageError);
	assert.throws(() => parseJouzuArgs(["--jouzu-home"]), UsageError);
	assert.throws(() => parseJouzuArgs(["--jouzu-unknown"]), UsageError);
});

test("blocks only Pi runtime self-update forms", () => {
	for (const args of [
		["update"],
		["update", "self"],
		["update", "pi"],
		["update", "--self"],
		["update", "--all"],
		["update", "--force"],
	]) {
		assert.equal(isBlockedPiSelfUpdate(args), true, args.join(" "));
	}
	for (const args of [
		["update", "--extensions"],
		["update", "--models"],
		["update", "--extension", "npm:example"],
		["update", "npm:example"],
		["install", "npm:example"],
	]) {
		assert.equal(isBlockedPiSelfUpdate(args), false, args.join(" "));
	}
});
