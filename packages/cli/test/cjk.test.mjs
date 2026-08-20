import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseJouzuArgs } from "../dist/args.js";
import { applyProfile } from "../dist/profile-manager.js";
import { loadBundledProfile } from "../dist/profiles.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = join(packageRoot, "dist", "cli.js");
const fixture = fileURLToPath(new URL("./fixtures/cjk/要件　仕様.md", import.meta.url));

function hash(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function paths(root) {
	return {
		agentDir: join(root, "agent"),
		stateDir: join(root, "state"),
		cacheDir: join(root, "cache"),
		sessionDir: join(root, "state", "sessions"),
		profileStatePath: join(root, "state", "profile-state.json"),
		backupDir: join(root, "state", "backups"),
	};
}

test("the reviewed mixed-width Japanese fixture remains byte-stable", () => {
	const bytes = readFileSync(fixture);
	assert.equal(hash(bytes), "7467a20c9adb7210bbfeb989d5500731e9f33d29e67485545175062be63acb6b");
	const text = bytes.toString("utf8");
	for (const expected of ["こんにちは", "ジョウズ", "ｼﾞｮｳｽﾞ", "上手", "ば", "ば", "🦁", "左　右"]) {
		assert.ok(text.includes(expected), expected);
	}
});

test("profile operations preserve CJK paths, normalization, BOM, CRLF, and user bytes", () => {
	const root = mkdtempSync(join(tmpdir(), "jouzu-cjk-"));
	try {
		const jouzuHome = join(root, "上手　home");
		const project = join(root, "日本語 project");
		const decomposedName = `は\u3099-${"仕様"}.txt`;
		mkdirSync(project, { recursive: true });
		writeFileSync(join(project, "要件　仕様.md"), readFileSync(fixture));
		writeFileSync(join(project, decomposedName), "結合文字を保持\n");
		writeFileSync(join(project, "BOM.txt"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("日本語\n")]));
		writeFileSync(join(project, "CRLF.txt"), Buffer.from("一行目\r\n二行目\r\n"));
		mkdirSync(join(jouzuHome, "agent"), { recursive: true });
		writeFileSync(join(jouzuHome, "agent", "AGENTS.md"), "利用者所有の指示　🦁\r\n");

		const tracked = [
			join(project, "要件　仕様.md"),
			join(project, decomposedName),
			join(project, "BOM.txt"),
			join(project, "CRLF.txt"),
			join(jouzuHome, "agent", "AGENTS.md"),
		];
		const before = new Map(tracked.map((path) => [path, hash(readFileSync(path))]));
		applyProfile(loadBundledProfile("ja"), paths(jouzuHome), "0.1.0");
		const after = new Map(tracked.map((path) => [path, hash(readFileSync(path))]));
		assert.deepEqual(after, before);
		assert.ok(readdirSync(project).includes(decomposedName));
		assert.equal(readFileSync(join(project, "BOM.txt")).subarray(0, 3).toString("hex"), "efbbbf");
		assert.match(readFileSync(join(project, "CRLF.txt"), "utf8"), /一行目\r\n二行目\r\n/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Unicode arguments and no-color diagnostics preserve exact text", () => {
	const args = ["--jouzu-home", "./上手　home", "pi", "@要件　仕様.md", "日本語で確認 🦁"];
	assert.deepEqual(parseJouzuArgs(args).args, ["@要件　仕様.md", "日本語で確認 🦁"]);

	const root = mkdtempSync(join(tmpdir(), "jouzu-cjk-terminal-"));
	try {
		const home = join(root, "端末　上手");
		const result = spawnSync(process.execPath, [cli, "--jouzu-home", home, "profile", "plan"], {
			encoding: "utf8",
			env: { ...process.env, NO_COLOR: "1", TERM: "dumb", PI_OFFLINE: "1" },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(result.stdout.includes("\u001b["), false);
		assert.equal(result.stdout.normalize("NFC").includes(home.normalize("NFC")), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
