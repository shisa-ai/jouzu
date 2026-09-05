#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const packageDirectory = join(root, "packages", "cli");
const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath
	? process.execPath
	: process.platform === "win32"
		? (process.env.ComSpec ?? "cmd.exe")
		: "npm";
const npmPrefix = npmExecPath ? [npmExecPath] : process.platform === "win32" ? ["/d", "/s", "/c", "npm"] : [];
const forbiddenDefaultPackages = new Set([
	"@the-forge-flow/camoufox-pi",
	"better-sqlite3",
	"camoufox-js",
	"impit",
	"playwright",
	"playwright-core",
	"ua-parser-js",
]);

function runNpm(args, cwd, timeout = 10 * 60 * 1000) {
	const result = spawnSync(npmCommand, [...npmPrefix, ...args], {
		cwd,
		encoding: "utf8",
		timeout,
		maxBuffer: 128 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	assert.equal(result.signal, null, `npm terminated by ${result.signal}: ${result.stderr}`);
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout;
}

function installedPackageNames(nodeModulesRoot) {
	const names = new Set();
	const visitModules = (directory) => {
		if (!existsSync(directory)) return;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.name === ".bin") continue;
			const entryPath = join(directory, entry.name);
			if (entry.name.startsWith("@")) {
				for (const scoped of readdirSync(entryPath, { withFileTypes: true })) {
					if (scoped.isDirectory()) visitPackage(join(entryPath, scoped.name));
				}
			} else {
				visitPackage(entryPath);
			}
		}
	};
	const visitPackage = (directory) => {
		try {
			const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
			if (typeof metadata.name === "string") names.add(metadata.name);
		} catch {}
		visitModules(join(directory, "node_modules"));
	};
	visitModules(nodeModulesRoot);
	return names;
}

async function probe(temp, consumer) {
	let shutdown;
	try {
		const jouzuRoot = join(consumer, "node_modules", "jouzu");
		const stateDir = join(temp, "state");
		const adapter = await import(pathToFileURL(join(jouzuRoot, "dist", "camoufox-adapter.js")).href);
		const runtimePaths = adapter.resolveCamoufoxRuntimePaths(stateDir);
		assert.equal(existsSync(runtimePaths.root), false, "loading the adapter installed the optional runtime");

		const reuseBrowserRoot = process.env.JOUZU_CAMOUFOX_TEST_BROWSER_DIR;
		if (reuseBrowserRoot) process.env.CAMOUFOX_INSTALL_DIR = resolve(reuseBrowserRoot);
		else delete process.env.CAMOUFOX_INSTALL_DIR;
		const tools = [];
		const handlers = new Map();
		adapter.createJouzuCamoufoxExtension(
			{
				registerTool(tool) {
					tools.push(tool);
				},
				on(event, handler) {
					handlers.set(event, handler);
				},
			},
			stateDir,
		);
		await handlers.get("session_start")({}, { cwd: temp });
		shutdown = handlers.get("session_shutdown");
		assert.equal(existsSync(runtimePaths.root), false, "registering browser tools installed the optional runtime");
		const fetchTool = tools.find((tool) => tool.name === "tff-fetch_url");
		assert.ok(fetchTool, "the packed adapter did not register tff-fetch_url");
		const result = await fetchTool.execute(
			"packed-camoufox-fetch",
			{
				url: "https://example.com/",
				render_mode: "static",
				format: "markdown",
				timeout_ms: 120_000,
			},
			new AbortController().signal,
		);
		assert.equal(result.details.status, 200);
		assert.match(result.details.markdown, /Example Domain/u);
		assert.equal(existsSync(runtimePaths.receipt), true, "the first tool call did not install the runtime receipt");
		assert.equal(adapter.inspectJouzuCamoufoxRuntime(stateDir).status, "ready");
		const runtimeManifest = JSON.parse(readFileSync(join(jouzuRoot, "camoufox-runtime", "package.json"), "utf8"));
		for (const [name, version] of Object.entries(runtimeManifest.dependencies)) {
			const installed = JSON.parse(
				readFileSync(join(runtimePaths.installRoot, "node_modules", ...name.split("/"), "package.json"), "utf8"),
			);
			assert.equal(installed.version, version, `${name} differs from the packed first-use lock`);
		}
		if (!reuseBrowserRoot) {
			assert.equal(
				existsSync(join(runtimePaths.root, "browser", "version.json")),
				true,
				"Camoufox browser was not downloaded",
			);
		}
		await shutdown();
		shutdown = undefined;
		console.log("packed Jouzu excluded Camoufox by default and passed its first-use browser fetch");
	} finally {
		if (shutdown) await shutdown();
	}
}

if (process.argv[2] === "--probe") {
	await probe(process.argv[3], process.argv[4]);
} else {
	const temp = mkdtempSync(join(tmpdir(), "jouzu-packed-camoufox-"));
	try {
		let tarball = process.env.JOUZU_PACKED_TARBALL ? resolve(process.env.JOUZU_PACKED_TARBALL) : undefined;
		if (!tarball) {
			const [packed] = JSON.parse(
				runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temp], packageDirectory),
			);
			tarball = join(temp, packed.filename);
		}
		assert.ok(existsSync(tarball), `packed Jouzu artifact does not exist: ${tarball}`);
		const consumer = join(temp, "consumer");
		mkdirSync(consumer);
		runNpm(["init", "--yes"], consumer);
		runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", tarball], consumer);
		const installedNames = installedPackageNames(join(consumer, "node_modules"));
		for (const name of forbiddenDefaultPackages) {
			assert.equal(installedNames.has(name), false, `default packed installation contains ${name}`);
		}

		const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--probe", temp, consumer], {
			encoding: "utf8",
			timeout: 15 * 60 * 1000,
			maxBuffer: 128 * 1024 * 1024,
		});
		if (child.stdout) process.stdout.write(child.stdout);
		if (child.stderr) process.stderr.write(child.stderr);
		if (child.error) throw child.error;
		assert.equal(child.status, 0, "packed Camoufox probe failed");
	} finally {
		rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
	}
}
