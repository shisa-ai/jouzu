import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testInvocation } from "./run-tests.mjs";

const runner = fileURLToPath(new URL("./run-tests.mjs", import.meta.url));
function fixture(t, source) {
	const root = mkdtempSync(join(tmpdir(), "jouzu-test-runner-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "fixture.test.mjs");
	writeFileSync(path, source);
	return { root, path };
}
function run(path, env = {}, options = []) {
	return spawnSync(process.execPath, [runner, ...options, path], {
		encoding: "utf8",
		timeout: 15_000,
		env: { ...process.env, JOUZU_TEST_TIMEOUT_MS: "5000", JOUZU_TEST_SUITE_TIMEOUT_MS: "10000", ...env },
	});
}

test("runner expands quoted globs, deduplicates files, and retains name filters", (t) => {
	const { root, path } = fixture(t, "import { test } from 'node:test'; test('pass', () => {});");
	const invocation = testInvocation(["--test-name-pattern", "pass=one", "*.test.mjs", path], {}, root);
	assert.deepEqual(invocation.files, [path]);
	assert.deepEqual(invocation.options, ["--test-name-pattern=pass=one"]);
	assert.equal(invocation.testTimeout, 120_000);
	assert.equal(invocation.suiteTimeout, 600_000);
	const result = run(path);
	assert.equal(result.status, 0, result.stderr + result.stdout);
	assert.match(result.stdout, /TAP version 13/);
	assert.match(result.stdout, /# pass 1/);
});

test("runner rejects missing selections, unmatched globs, directories, and unsafe overrides", (t) => {
	const { root, path } = fixture(t, "throw new Error('must not run');");
	for (const args of [
		[],
		["missing-*.test.mjs"],
		[root],
		["--test-reporter=spec", path],
		["--test-timeout=0", path],
		["--watch", path],
		["--test-force-exit", path],
		["--test-concurrency=0", path],
		["--test-name-pattern"],
	])
		assert.throws(() => testInvocation(args, {}, root));
	for (const name of ["JOUZU_TEST_TIMEOUT_MS", "JOUZU_TEST_SUITE_TIMEOUT_MS"])
		for (const value of ["0", "-1", "Infinity", "NaN", "1.5", "", "3600001"])
			assert.throws(() => testInvocation([path], { [name]: value }, root));
	const result = run(path, {}, ["--test-reporter=spec"]);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /Unsupported option/);
	assert.doesNotMatch(result.stderr + result.stdout, /must not run/);
});

test("failed assertions keep their diagnostics and nonzero status", (t) => {
	const { path } = fixture(
		t,
		"import { test } from 'node:test'; test('failure', () => { throw new Error('visible failure'); });",
	);
	const result = run(path);
	assert.equal(result.status, 1);
	assert.match(result.stdout, /not ok/);
	assert.match(result.stdout, /visible failure/);
});

test("per-test deadlines report an asynchronous hang", (t) => {
	const { path } = fixture(
		t,
		`
		import { test } from 'node:test';
		test('hang', async (t) => {
			const timer = setInterval(() => {}, 1000);
			t.after(() => clearInterval(timer));
			await new Promise(() => {});
		});
	`,
	);
	const result = run(path, { JOUZU_TEST_TIMEOUT_MS: "100" });
	assert.equal(result.status, 1, result.stderr + result.stdout);
	assert.match(result.stdout, /testTimeoutFailure|timed out/);
});

for (const source of ["while (true) {}", "setInterval(() => {}, 1000);"])
	test(`suite watchdog stops ${source.startsWith("while") ? "a blocked event loop" : "leaked handles"}`, (t) => {
		const { path } = fixture(t, source);
		const result = run(path, { JOUZU_TEST_SUITE_TIMEOUT_MS: "700" });
		assert.equal(result.status, 124, result.error?.message ?? result.stderr);
		assert.match(result.stderr, /suite deadline exceeded/);
	});

test("failure diagnostics arrive before a later hung test exits", { timeout: 15_000 }, async (t) => {
	const { path } = fixture(
		t,
		`
		import { test } from 'node:test';
		test('failure first', () => { throw new Error('early diagnostic'); });
		test('hang later', async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });
	`,
	);
	const child = spawn(process.execPath, [runner, path], {
		env: { ...process.env, JOUZU_TEST_TIMEOUT_MS: "10000", JOUZU_TEST_SUITE_TIMEOUT_MS: "3000" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => {
		child.kill("SIGTERM");
	});
	let stdout = "",
		stderr = "",
		early = false;
	child.stdout.on("data", (data) => {
		stdout += data;
		if (stdout.includes("early diagnostic") && child.exitCode === null) early = true;
	});
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	const [code] = await once(child, "exit");
	assert.equal(code, 124, stderr);
	assert.equal(early, true, stdout);
});

test("interrupts stop the supervised run with a failing signal status", {
	timeout: 15_000,
	skip: process.platform === "win32",
}, async (t) => {
	const { path } = fixture(
		t,
		`
		import { test } from 'node:test';
		test('pending', async () => {
			console.log('signal fixture ready');
			setInterval(() => {}, 1000);
			await new Promise(() => {});
		});
	`,
	);
	const child = spawn(process.execPath, [runner, path], {
		env: { ...process.env, JOUZU_TEST_TIMEOUT_MS: "10000", JOUZU_TEST_SUITE_TIMEOUT_MS: "10000" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	t.after(() => {
		child.kill("SIGTERM");
	});
	let stdout = "",
		stderr = "",
		interrupted = false;
	child.stdout.on("data", (data) => {
		stdout += data;
		if (!interrupted && stdout.includes("signal fixture ready")) {
			interrupted = true;
			child.kill("SIGTERM");
		}
	});
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	const [code] = await once(child, "exit");
	assert.equal(code, 143, stdout + stderr);
	assert.match(stderr, /terminated; terminating test processes/);
});

test("package and CI Node test entry points use the bounded runner", () => {
	const rawTest = /\bnode\b[^&|;\n]*\s--test(?:\s|$)/;
	for (const path of ["../package.json", "../packages/cli/package.json", "../packages/session-ui/package.json"]) {
		const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
		for (const [name, command] of Object.entries(pkg.scripts))
			assert.doesNotMatch(command, rawTest, `${path} ${name} bypasses the bounded runner`);
	}
	const workflows = new URL("../.github/workflows/", import.meta.url);
	for (const file of readdirSync(workflows).filter((file) => /\.ya?ml$/.test(file)))
		assert.doesNotMatch(readFileSync(new URL(file, workflows), "utf8"), rawTest, `${file} bypasses the bounded runner`);
});
