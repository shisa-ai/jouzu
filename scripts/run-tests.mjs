#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, globSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function limit(env, name, fallback) {
	const raw = env[name];
	if (raw === undefined) return fallback;
	if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > 3_600_000)
		throw new Error(`${name} must be an integer from 1 to 3600000 milliseconds.`);
	return Number(raw);
}

export function testInvocation(args, env = process.env, cwd = process.cwd()) {
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
	return {
		files: [...files].sort(),
		options,
		testTimeout: limit(env, "JOUZU_TEST_TIMEOUT_MS", 120_000),
		suiteTimeout: limit(env, "JOUZU_TEST_SUITE_TIMEOUT_MS", 600_000),
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
	const { files, options, testTimeout, suiteTimeout } = invocation;
	console.error(
		`[tests] ${files.length} test files; test timeout ${testTimeout}ms; suite deadline ${suiteTimeout}ms; TAP output`,
	);
	const env = { ...process.env };
	// The runner's own tests launch nested invocations. Each must get a fresh Node test harness.
	delete env.NODE_TEST_CONTEXT;
	const child = spawn(
		process.execPath,
		["--test", "--test-reporter=tap", `--test-timeout=${testTimeout}`, ...options, ...files],
		{
			env,
			stdio: ["ignore", "inherit", "inherit"],
			detached: process.platform !== "win32",
			windowsHide: true,
		},
	);
	const started = Date.now();
	let deadline, heartbeat;
	let interrupt, terminateSignal;
	try {
		return await new Promise((done) => {
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
	} finally {
		clearTimeout(deadline);
		clearInterval(heartbeat);
		if (interrupt) process.removeListener("SIGINT", interrupt);
		if (terminateSignal) process.removeListener("SIGTERM", terminateSignal);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = await runTests(testInvocation(process.argv.slice(2)));
	} catch (error) {
		console.error(`[tests] ${error.message}`);
		process.exitCode = 2;
	}
}
