import assert from "node:assert/strict";
import { test } from "node:test";
import { formatHelp, isBlockedPiSelfUpdate, parseJouzuArgs, UsageError } from "../dist/args.js";
import { loadCatalog } from "../dist/locale-catalog.js";

test("forwards Pi arguments without reconstructing them", () => {
	const unicodeArgs = ["--provider", "openai", "@仕様 書.md", "日本語のメッセージ"];
	assert.deepEqual(parseJouzuArgs(unicodeArgs), {
		kind: "pi",
		options: {},
		args: unicodeArgs,
	});
	const sessionArgs = ["--session", "01a02007-8a6e-753c-b232-babb4ba4f3d5"];
	assert.deepEqual(parseJouzuArgs(sessionArgs), {
		kind: "pi",
		options: {},
		args: sessionArgs,
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

test("parses ACP without starting an interactive Pi session", () => {
	assert.deepEqual(parseJouzuArgs(["acp"]), { kind: "acp", options: {} });
	assert.deepEqual(parseJouzuArgs(["--jouzu-home", "/tmp/ACP home", "--jouzu-profile", "ja", "acp"]), {
		kind: "acp",
		options: { home: "/tmp/ACP home", profile: "ja" },
	});
	assert.deepEqual(parseJouzuArgs(["acp", "--help"]), { kind: "help", options: {} });
	assert.deepEqual(parseJouzuArgs(["pi", "acp"]), { kind: "pi", options: {}, args: ["acp"] });
	assert.throws(() => parseJouzuArgs(["acp", "--mode", "rpc"]), UsageError);
	assert.match(formatHelp(), /jouzu \[Jouzu options\] acp/u);
});

test("reserves Jouzu diagnostics while allowing escaped Pi collisions", () => {
	assert.deepEqual(parseJouzuArgs(["doctor"]), { kind: "doctor", options: {}, json: false });
	assert.deepEqual(parseJouzuArgs(["doctor", "--json"]), { kind: "doctor", options: {}, json: true });
	assert.deepEqual(parseJouzuArgs(["pi", "doctor"]), { kind: "pi", options: {}, args: ["doctor"] });
	assert.deepEqual(parseJouzuArgs(["--version"]), { kind: "version", options: {} });
	assert.throws(() => parseJouzuArgs(["doctor", "--json", "--json"]), /doctor does not accept/);
	assert.throws(() => parseJouzuArgs(["doctor", "extra"]), /doctor does not accept/);
});

test("parses optional catalog status, refresh, and file conformance commands", () => {
	assert.deepEqual(parseJouzuArgs(["catalog"]), {
		kind: "catalog",
		options: {},
		operation: "status",
		json: false,
	});
	assert.deepEqual(parseJouzuArgs(["catalog", "refresh", "--json"]), {
		kind: "catalog",
		options: {},
		operation: "refresh",
		json: true,
	});
	assert.deepEqual(parseJouzuArgs(["catalog", "status", "office", "--json"]), {
		kind: "catalog",
		options: {},
		operation: "status",
		sourceId: "office",
		json: true,
	});
	const digest = "a".repeat(64);
	assert.deepEqual(parseJouzuArgs(["catalog", "accept", "revision-2", "--digest", digest]), {
		kind: "catalog",
		options: {},
		operation: "accept",
		revision: "revision-2",
		digest,
		json: false,
	});
	assert.deepEqual(parseJouzuArgs(["catalog", "accept", "revision-2", "--source", "office", "--digest", digest]), {
		kind: "catalog",
		options: {},
		operation: "accept",
		revision: "revision-2",
		digest,
		sourceId: "office",
		json: false,
	});
	assert.deepEqual(parseJouzuArgs(["catalog", "validate", "/tmp/catalog.json"]), {
		kind: "catalog",
		options: {},
		operation: "validate",
		path: "/tmp/catalog.json",
		json: false,
	});
	assert.deepEqual(parseJouzuArgs(["catalog", "conformance", "/tmp/catalog.json", "--json"]), {
		kind: "catalog",
		options: {},
		operation: "conformance",
		path: "/tmp/catalog.json",
		json: true,
	});
	assert.throws(() => parseJouzuArgs(["catalog", "validate"]), UsageError);
	assert.throws(() => parseJouzuArgs(["catalog", "accept", "revision-2", "--digest", "bad"]), UsageError);
	assert.throws(() => parseJouzuArgs(["catalog", "other"]), UsageError);
});

test("parses profile planning and application without mixing launch selection", () => {
	assert.deepEqual(parseJouzuArgs(["profile", "plan", "--profile", "core", "--json"]), {
		kind: "profile",
		options: {},
		operation: "plan",
		profile: "core",
		json: true,
	});
	assert.deepEqual(parseJouzuArgs(["--jouzu-home=/tmp/上手", "profile", "apply"]), {
		kind: "profile",
		options: { home: "/tmp/上手" },
		operation: "apply",
		json: false,
	});
});

test("parses Jouzu keybinding planning, application, and reset", () => {
	assert.deepEqual(parseJouzuArgs(["keybindings"]), {
		kind: "keybindings",
		options: {},
		operation: "status",
		json: false,
	});
	assert.deepEqual(parseJouzuArgs(["--jouzu-home=/tmp/keys", "keybindings", "plan", "--json"]), {
		kind: "keybindings",
		options: { home: "/tmp/keys" },
		operation: "plan",
		json: true,
	});
	assert.deepEqual(parseJouzuArgs(["keybindings", "apply"]), {
		kind: "keybindings",
		options: {},
		operation: "apply",
		json: false,
	});
	assert.deepEqual(parseJouzuArgs(["keybindings", "reset"]), {
		kind: "keybindings",
		options: {},
		operation: "reset",
		json: false,
	});
});

test("parses Jouzu self-update operations without taking Pi package updates", () => {
	assert.deepEqual(parseJouzuArgs(["self-update"]), {
		kind: "self-update",
		options: {},
		operation: "status",
		json: false,
	});
	assert.deepEqual(parseJouzuArgs(["self-update", "check", "--json"]), {
		kind: "self-update",
		options: {},
		operation: "check",
		json: true,
	});
	assert.deepEqual(parseJouzuArgs(["--jouzu-home", "/tmp/update", "self-update", "apply"]), {
		kind: "self-update",
		options: { home: "/tmp/update" },
		operation: "apply",
		json: false,
	});
	assert.deepEqual(parseJouzuArgs(["self-update", "policy", "notify"]), {
		kind: "self-update",
		options: {},
		operation: "policy",
		policy: "notify",
		json: false,
	});
	assert.deepEqual(parseJouzuArgs(["update", "--extensions"]), {
		kind: "pi",
		options: {},
		args: ["update", "--extensions"],
	});
});

test("parses the UI locale option and rejects duplicates or unsupported values", () => {
	assert.deepEqual(parseJouzuArgs(["--jouzu-ui-locale", "ja", "doctor"]), {
		kind: "doctor",
		options: { uiLocale: "ja" },
		json: false,
	});
	assert.deepEqual(parseJouzuArgs(["--jouzu-ui-locale=auto", "pi", "--help"]), {
		kind: "pi",
		options: { uiLocale: "auto" },
		args: ["--help"],
	});
	assert.throws(() => parseJouzuArgs(["--jouzu-ui-locale", "ja", "--jouzu-ui-locale", "en"]), UsageError);
	assert.throws(() => parseJouzuArgs(["--jouzu-ui-locale", "fr"]), UsageError);
	assert.throws(() => parseJouzuArgs(["--jouzu-ui-locale", "ja-JP"]), UsageError);
	assert.throws(() => parseJouzuArgs(["--jouzu-ui-locale"]), UsageError);
});

test("rejects invalid Jouzu options", () => {
	assert.throws(() => parseJouzuArgs(["--jouzu-profile", "other"]), UsageError);
	assert.throws(() => parseJouzuArgs(["--jouzu-home"]), UsageError);
	assert.throws(() => parseJouzuArgs(["--jouzu-unknown"]), UsageError);
	assert.throws(() => parseJouzuArgs(["profile", "plan", "--profile", "other"]), UsageError);
	assert.throws(() => parseJouzuArgs(["profile", "apply", "--json"]), UsageError);
	assert.throws(() => parseJouzuArgs(["--jouzu-profile", "ja", "profile", "plan"]), UsageError);
	assert.throws(() => parseJouzuArgs(["self-update", "other"]), UsageError);
	assert.throws(() => parseJouzuArgs(["self-update", "apply", "--json"]), UsageError);
	assert.throws(() => parseJouzuArgs(["self-update", "policy", "later"]), UsageError);
	assert.throws(() => parseJouzuArgs(["keybindings", "other"]), UsageError);
	assert.throws(() => parseJouzuArgs(["keybindings", "apply", "--json"]), UsageError);
	assert.throws(() => parseJouzuArgs(["keybindings", "plan", "--json", "--json"]), UsageError);
});

test("formatHelp keeps the protected layout and renders from the catalog", () => {
	const en = formatHelp(loadCatalog("en"));
	assert.match(en, /^Jouzu agentic AI environment\n\nUsage:\n/u);
	assert.match(en, /^ {2}profile apply Apply the selected profile with conflicts and backups$/mu);
	assert.match(en, /^ {2}--jouzu-textguard-strict {18}Withhold every flagged input until approved$/mu);
	assert.match(
		en,
		/^ {2}--jouzu-ui-locale <auto\|en\|ja\|zh-Hans\|zh-Hant>\n {44}UI language; auto follows the OS locale$/mu,
	);
	// Protected command, option, and placeholder text is identical in both locales.
	const ja = formatHelp(loadCatalog("ja"));
	assert.match(ja, /Jouzu エージェント型 AI 環境/u);
	assert.match(ja, /jouzu catalog accept <revision> --digest <sha256> \[--source <source-id>\]/u);
	assert.match(ja, /--jouzu-ui-locale <auto\|en\|ja\|zh-Hans\|zh-Hant>/u);
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
