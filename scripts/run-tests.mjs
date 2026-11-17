#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, release } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const reporter = pathToFileURL(fileURLToPath(new URL("./test-timing-reporter.mjs", import.meta.url))).href;
const failureReporter = pathToFileURL(fileURLToPath(new URL("./test-failure-reporter.mjs", import.meta.url))).href;

function limit(env, name, fallback) {
	const raw = env[name];
	if (raw === undefined) return fallback;
	if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > 3_600_000)
		throw new Error(`${name} must be an integer from 1 to 3600000 milliseconds.`);
	return Number(raw);
}

export function testInvocation(args, env = process.env, cwd = process.cwd()) {
	cwd = resolve(cwd);
	const options = [];
	const patterns = [];
	for (let i = 0; i < args.length; i++) {
		const argument = args[i];
		if (!argument.startsWith("-")) {
			patterns.push(argument);
			continue;
		}
		const [name, ...parts] = argument.split("=");
		if (!["--test-name-pattern", "--test-skip-pattern", "--test-concurrency"].includes(name))
			throw new Error(
				`Unsupported option ${name}. Use file paths, --test-name-pattern, --test-skip-pattern, or --test-concurrency.`,
			);
		const value = parts.length ? parts.join("=") : args[++i];
		if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
		if (name === "--test-concurrency" && (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))))
			throw new Error("--test-concurrency must be a positive integer.");
		options.push(`${name}=${value}`);
	}
	if (!patterns.length) throw new Error("Provide at least one test file or glob. See docs/testing.md.");
	// CI selects a measured concurrency without changing each package script; an argument wins.
	if (env.JOUZU_TEST_CONCURRENCY !== undefined && !options.some((option) => option.startsWith("--test-concurrency="))) {
		const value = env.JOUZU_TEST_CONCURRENCY;
		if (!/^[1-9][0-9]?$/.test(value) || Number(value) > 64)
			throw new Error("JOUZU_TEST_CONCURRENCY must be an integer from 1 to 64.");
		options.push(`--test-concurrency=${value}`);
	}
	const files = new Set();
	for (const pattern of patterns) {
		const literal = resolve(cwd, pattern);
		const matches = existsSync(literal) ? [literal] : globSync(pattern, { cwd }).map((path) => resolve(cwd, path));
		if (!matches.length) throw new Error(`No test files match ${pattern}.`);
		for (const path of matches) {
			if (!statSync(path).isFile()) throw new Error(`Test selection is not a file: ${path}`);
			files.add(path);
		}
	}
	const timingsDir = env.JOUZU_TEST_TIMINGS_DIR ? resolve(cwd, env.JOUZU_TEST_TIMINGS_DIR) : null;
	// Without an explicit label, name the suite after the npm script that started it.
	const script = env.npm_lifecycle_event ? `${env.npm_package_name ?? "jouzu"}.${env.npm_lifecycle_event}` : "tests";
	const label =
		env.JOUZU_TEST_TIMINGS_LABEL ??
		script
			.replace(/[^A-Za-z0-9._-]+/g, "_")
			.replace(/^_+/, "")
			.slice(0, 80);
	if (timingsDir && !/^[A-Za-z0-9._-]{1,80}$/.test(label))
		throw new Error("JOUZU_TEST_TIMINGS_LABEL must be 1-80 letters, digits, dots, underscores, or hyphens.");
	return {
		cwd,
		files: [...files].sort(),
		options,
		testTimeout: limit(env, "JOUZU_TEST_TIMEOUT_MS", 120_000),
		suiteTimeout: limit(env, "JOUZU_TEST_SUITE_TIMEOUT_MS", 600_000),
		timings: timingsDir ? { dir: timingsDir, label } : null,
	};
}

function commit(env) {
	if (env.GITHUB_SHA) return env.GITHUB_SHA;
	const result = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
		windowsHide: true,
		timeout: 10_000,
	});
	return result.status === 0 ? result.stdout.trim() : null;
}

// Run context recorded with each timing file so runs are compared only with comparable runs.
export function timingContext(invocation, env = process.env, now = new Date()) {
	const concurrency = invocation.options.find((option) => option.startsWith("--test-concurrency="));
	return {
		type: "run",
		schemaVersion: 1,
		label: invocation.timings?.label ?? "tests",
		startedAt: now.toISOString(),
		commit: commit(env),
		platform: process.platform,
		arch: process.arch,
		osRelease: release(),
		node: process.version,
		cpus: availableParallelism(),
		concurrency: concurrency ? Number(concurrency.split("=")[1]) : null,
		files: invocation.files.length,
		testTimeout: invocation.testTimeout,
		suiteTimeout: invocation.suiteTimeout,
		hosted: env.GITHUB_ACTIONS === "true",
		job: env.JOUZU_TEST_TIMINGS_JOB ?? env.GITHUB_JOB ?? null,
		runId: env.GITHUB_RUN_ID ?? null,
		runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
		image: env.ImageOS ? `${env.ImageOS} ${env.ImageVersion ?? ""}`.trim() : null,
	};
}

function terminate(child) {
	if (!child.pid) return;
	if (process.platform === "win32") {
		const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
			windowsHide: true,
			stdio: "ignore",
			timeout: 10_000,
		});
		if (result.status !== 0) child.kill("SIGKILL");
	} else {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	}
}

export async function runTests(invocation) {
	const { files, options, testTimeout, suiteTimeout, timings, cwd = process.cwd() } = invocation;
	console.error(
		`[tests] ${files.length} test files; test timeout ${testTimeout}ms; suite deadline ${suiteTimeout}ms; TAP output`,
	);
	const env = { ...process.env };
	// The runner's own tests launch nested invocations. Each must get a fresh Node test harness
	// and must not add fixture results to the caller's timing record.
	delete env.NODE_TEST_CONTEXT;
	delete env.JOUZU_TEST_TIMINGS_DIR;
	let record, partial;
	// TAP on stdout, and every failure repeated on stderr at the end, where a truncated CI log keeps it.
	const reporters = [
		"--test-reporter=tap",
		"--test-reporter-destination=stdout",
		`--test-reporter=${failureReporter}`,
		"--test-reporter-destination=stderr",
	];
	if (timings) {
		mkdirSync(timings.dir, { recursive: true });
		record = join(timings.dir, `${timings.label}-${Date.now()}-${process.pid}.jsonl`);
		partial = `${record}.partial`;
		reporters.push(`--test-reporter=${reporter}`, `--test-reporter-destination=${partial}`);
	}
	const context = timings ? timingContext(invocation) : null;
	// Keep the checkout prefix out of each argument to stay below Windows' command-line limit.
	const testFiles = files.map((file) => {
		const path = relative(cwd, file);
		// Node normalizes './' and reparses paths in test workers; keep leading '-' paths absolute.
		return path.startsWith("-") ? file : path;
	});
	const child = spawn(
		process.execPath,
		["--test", ...reporters, `--test-timeout=${testTimeout}`, ...options, ...testFiles],
		{
			cwd,
			env,
			stdio: ["ignore", "inherit", "inherit"],
			detached: process.platform !== "win32",
			windowsHide: true,
		},
	);
	const started = Date.now();
	let deadline, heartbeat;
	let interrupt, terminateSignal;
	let exitCode = 1;
	try {
		exitCode = await new Promise((done) => {
			let stopping = false;
			const stop = (code, reason) => {
				if (stopping) return;
				stopping = true;
				console.error(`[tests] ${reason}; terminating test processes`);
				try {
					terminate(child);
				} catch (error) {
					console.error(`[tests] termination failed: ${error.message}`);
					child.kill("SIGKILL");
				}
				child.unref();
				done(code);
			};
			child.once("error", (error) => {
				console.error(`[tests] could not start: ${error.message}`);
				done(1);
			});
			child.once("exit", (code, signal) => {
				if (!stopping) {
					if (signal) console.error(`[tests] test runner exited on ${signal}`);
					done(code ?? 1);
				}
			});
			deadline = setTimeout(() => stop(124, `suite deadline exceeded (${suiteTimeout}ms)`), suiteTimeout);
			heartbeat = setInterval(() => {
				console.error(
					`[tests] still running after ${Math.round((Date.now() - started) / 1000)}s; deadline ${suiteTimeout}ms`,
				);
			}, 15_000);
			interrupt = () => stop(130, "interrupted");
			terminateSignal = () => stop(143, "terminated");
			process.once("SIGINT", interrupt);
			process.once("SIGTERM", terminateSignal);
		});
		return exitCode;
	} finally {
		clearTimeout(deadline);
		clearInterval(heartbeat);
		if (interrupt) process.removeListener("SIGINT", interrupt);
		if (terminateSignal) process.removeListener("SIGTERM", terminateSignal);
		if (record) writeTimingRecord(record, partial, context, { wallMs: Date.now() - started, exitCode });
	}
}

function writeTimingRecord(record, partial, context, end) {
	let tests = "";
	try {
		tests = readFileSync(partial, "utf8");
		rmSync(partial, { force: true });
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const lines = [context];
	let truncated = false;
	for (const line of tests.split("\n").filter(Boolean)) {
		try {
			lines.push(JSON.parse(line));
		} catch {
			// A terminated run can leave the reporter's last line unfinished.
			truncated = true;
		}
	}
	lines.push({ type: "end", endedAt: new Date().toISOString(), ...end, truncated });
	writeFileSync(record, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	console.error(`[tests] timing record ${record}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = await runTests(testInvocation(process.argv.slice(2)));
	} catch (error) {
		console.error(`[tests] ${error.message}`);
		process.exitCode = 2;
	}
}
