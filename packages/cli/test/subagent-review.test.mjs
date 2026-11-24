import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SubagentManager } from "../dist/subagents/manager.js";
import { captureReviewCandidate } from "../dist/subagents/review.js";
import { defaultAgentConfig } from "../dist/subagents/roles.js";

const { createJiti } = await import(
	pathToFileURL(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("jiti")).href
);
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { CronStorage } = await jiti.import(
	fileURLToPath(new URL("../node_modules/pi-schedule-prompt/src/storage.ts", import.meta.url)),
);

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "jouzu-review-state-"));
	const cwd = join(root, "workspace");
	mkdirSync(cwd);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args) =>
		execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const write = (name, text) => {
		mkdirSync(dirname(join(cwd, name)), { recursive: true });
		writeFileSync(join(cwd, name), text);
	};
	git("init", "--quiet");
	write("app.js", "export const value = 1;\n");
	git("add", "app.js");
	const commit = () =>
		git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
	commit();
	const snapshot = () => {
		const candidate = captureReviewCandidate(cwd);
		assert.equal(candidate.coverage, "git-worktree");
		assert.ok(candidate.identity);
		return candidate;
	};
	return { root, cwd, git, write, commit, snapshot };
}

test("review completion ignores untracked scheduler runtime writes without hiding source coverage", async (t) => {
	const f = fixture(t);
	const storage = new CronStorage(f.cwd);
	storage.save({ version: 1, jobs: [{ id: "fixture", enabled: false, runCount: 0 }] });
	let child;
	const manager = new SubagentManager(
		{ configDir: join(f.root, "config"), stateDir: join(f.root, "state") },
		"parent",
		2,
		(launch, emit, exit) => {
			child = {
				launch,
				emit,
				exit,
				send() {},
				async stop() {
					exit(false);
				},
			};
			return child;
		},
	);
	t.after(() => manager.dispose());
	const run = manager.launch({
		role: defaultAgentConfig().roles.find((role) => role.judging),
		model: { id: "fixture", provider: "fixture", api: "openai-completions" },
		auth: { apiKey: "fixture" },
		cwd: f.cwd,
		task: "Review app.js without editing files.",
	});
	const status = f.git("status", "--porcelain=v1", "--untracked-files=all");
	storage.updateJob("fixture", { runCount: 1, lastStatus: "success" });
	assert.equal(f.git("diff", "HEAD", "--"), "");
	assert.equal(f.git("status", "--porcelain=v1", "--untracked-files=all"), status);
	assert.equal(readFileSync(join(f.cwd, "app.js"), "utf8"), "export const value = 1;\n");
	child.emit({ type: "result", status: "completed", text: "No findings." });
	child.exit(true);
	const result = manager.get(run.id);
	assert.equal(result.status, "completed");
	assert.equal(result.review.status, "unchanged");
	assert.equal(result.result, "No findings.");
});

for (const name of [".pi/schedule-prompts.json", ".pi/schedule-prompts.json.tmp"]) {
	test(`review identity ignores untracked runtime create, update and delete: ${name}`, (t) => {
		const f = fixture(t);
		const before = f.snapshot();
		f.write(name, "first runtime state");
		assert.deepEqual(f.snapshot(), before);
		f.write(name, "changed runtime state");
		assert.deepEqual(f.snapshot(), before);
		rmSync(join(f.cwd, name));
		assert.deepEqual(f.snapshot(), before);
	});
}

for (const name of ["app.js", ".pi/schedule-prompts.json", ".pi/schedule-prompts.json.tmp"]) {
	test(`review identity retains tracked changes even at runtime paths: ${name}`, (t) => {
		const f = fixture(t);
		f.write(name, "tracked baseline");
		f.git("add", name);
		f.commit();
		const before = f.snapshot();
		f.write(name, "unstaged change");
		assert.notEqual(f.snapshot().identity, before.identity);
		f.git("add", name);
		assert.notEqual(f.snapshot().identity, before.identity);
		rmSync(join(f.cwd, name));
		assert.notEqual(f.snapshot().identity, before.identity);
	});
}

for (const name of [
	"new.js",
	"name with space.js",
	".pi/settings.json",
	".pi/tasks-config.json",
	".pi/schedule-prompts-settings.json",
	".pi/extensions/review.ts",
	".pi/schedule-prompts.json.backup",
	"nested/.pi/schedule-prompts.json",
]) {
	test(`review identity retains meaningful untracked create, update and delete: ${name}`, (t) => {
		const f = fixture(t);
		const empty = f.snapshot();
		f.write(name, "first contents");
		const before = f.snapshot();
		assert.notEqual(before.identity, empty.identity);
		f.write(name, "changed contents");
		assert.notEqual(f.snapshot().identity, before.identity);
		rmSync(join(f.cwd, name));
		assert.notEqual(f.snapshot().identity, before.identity);
		assert.deepEqual(f.snapshot(), empty);
	});
}

test("runtime-shaped directories and symlinks remain part of review coverage", (t) => {
	const f = fixture(t);
	const empty = f.snapshot();
	f.write(".pi/schedule-prompts.json/source.js", "source");
	assert.notEqual(f.snapshot().identity, empty.identity);
	rmSync(join(f.cwd, ".pi/schedule-prompts.json"), { recursive: true });
	if (process.platform === "win32") return; // File symlinks require a separate Windows privilege.
	symlinkSync("../first-target", join(f.cwd, ".pi/schedule-prompts.json"));
	const before = f.snapshot();
	assert.notEqual(before.identity, empty.identity);
	rmSync(join(f.cwd, ".pi/schedule-prompts.json"));
	symlinkSync("../other-target", join(f.cwd, ".pi/schedule-prompts.json"));
	assert.notEqual(f.snapshot().identity, before.identity);
});

test("excluded runtime bytes do not consume the untracked snapshot budget", (t) => {
	const f = fixture(t);
	const before = f.snapshot();
	f.write(".pi/schedule-prompts.json", "x".repeat(4_000_001));
	assert.deepEqual(f.snapshot(), before);
	f.write("large-source.txt", "x".repeat(4_000_001));
	assert.equal(captureReviewCandidate(f.cwd).coverage, "unavailable");
});

for (const name of [".pi/schedule-prompts.json", ".pi/schedule-prompts.json.tmp"]) {
	test(`staging an untracked runtime file adds it to review coverage: ${name}`, (t) => {
		const f = fixture(t);
		const before = f.snapshot();
		f.write(name, "runtime becomes tracked");
		f.git("add", name);
		assert.notEqual(f.snapshot().identity, before.identity);
	});
}

for (const [name, code, coverage] of [
	[".pi/schedule-prompts.json.tmp", "ENOENT", "git-worktree"],
	[".pi/schedule-prompts.json", "EACCES", "unavailable"],
	["new.js", "ENOENT", "unavailable"],
]) {
	test(`review coverage handles snapshot stat failures conservatively: ${name} ${code}`, (t) => {
		const f = fixture(t);
		const before = f.snapshot();
		f.write(name, "racing file");
		const original = fs.lstatSync;
		t.mock.method(fs, "lstatSync", (path, ...args) => {
			if (path === join(f.cwd, name)) throw Object.assign(new Error("fixture stat failure"), { code });
			return original(path, ...args);
		});
		syncBuiltinESMExports();
		try {
			const after = captureReviewCandidate(f.cwd);
			assert.equal(after.coverage, coverage);
			if (coverage === "git-worktree") assert.deepEqual(after, before);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		}
	});
}

test("review coverage remains unverified without a root Git snapshot", (t) => {
	const f = fixture(t);
	assert.equal(captureReviewCandidate(f.root).coverage, "unavailable");
	mkdirSync(join(f.cwd, "nested"));
	assert.equal(captureReviewCandidate(join(f.cwd, "nested")).coverage, "unavailable");
});
