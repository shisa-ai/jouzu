#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageDirectory = join(root, "packages", "cli");
const currentPackage = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
const currentVersion = currentPackage.version;
const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(currentVersion);
if (!versionMatch) throw new Error(`test:auto-update requires a stable semantic version, got ${currentVersion}`);
const nextVersion = `${versionMatch[1]}.${versionMatch[2]}.${Number(versionMatch[3]) + 1}`;
const brokenVersion = `${versionMatch[1]}.${versionMatch[2]}.${Number(versionMatch[3]) + 2}`;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const npmCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmPrefix = process.platform === "win32" ? ["/d", "/s", "/c", "npm"] : [];
const updateApplyTimeout = 10 * 60_000;

function commandResult(command, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		const timeout = options.timeout ?? 180_000;
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`${command} ${args.join(" ")} timed out after ${timeout} ms`));
		}, timeout);
		child.stdout.setEncoding("utf8").on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (status, signal) => {
			clearTimeout(timer);
			resolvePromise({ status, signal, stdout, stderr });
		});
	});
}

async function run(command, args, options = {}) {
	const result = await commandResult(command, args, options);
	assert.equal(result.signal, null, `${command} terminated by ${result.signal}: ${result.stderr}`);
	assert.equal(result.status, 0, `${command} exited ${result.status}: ${result.stderr || result.stdout}`);
	return result;
}

function runNpm(args, options = {}) {
	return run(npmCommand, [...npmPrefix, ...args], options);
}

function sri(bytes) {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

async function createPackage(rootDirectory, version, broken = false) {
	const directory = join(rootDirectory, `package-${version}${broken ? "-broken" : ""}`);
	mkdirSync(directory, { recursive: true });
	for (const entry of ["dist", "LICENSE", "README.md"]) {
		cpSync(join(packageDirectory, entry), join(directory, entry), { recursive: true });
	}
	writeFileSync(join(directory, "package.json"), `${JSON.stringify({ ...currentPackage, version }, null, 2)}\n`);
	if (broken) {
		writeFileSync(
			join(directory, "dist", "cli.js"),
			'#!/usr/bin/env node\nthrow new Error("intentional updater smoke failure");\n',
		);
	}
	const artifacts = join(rootDirectory, "artifacts");
	mkdirSync(artifacts, { recursive: true });
	const packed = await runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", artifacts], {
		cwd: directory,
	});
	const [metadata] = JSON.parse(packed.stdout);
	const path = join(artifacts, metadata.filename);
	const bytes = readFileSync(path);
	assert.equal(metadata.integrity, sri(bytes));
	return { version, path, bytes, integrity: metadata.integrity, shasum: metadata.shasum };
}

async function withRegistry(release, callback) {
	const requests = [];
	const server = createServer(async (request, response) => {
		requests.push(request.url ?? "");
		if (request.url === "/jouzu" || request.url?.startsWith("/jouzu?")) {
			const tarball = `http://127.0.0.1:${server.address().port}/jouzu/-/${basename(release.path)}`;
			const packument = {
				name: "jouzu",
				"dist-tags": { latest: release.version },
				versions: {
					[release.version]: {
						name: "jouzu",
						version: release.version,
						dist: {
							tarball,
							integrity: release.integrity,
							shasum: release.shasum,
						},
					},
				},
			};
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(packument));
			return;
		}
		if (request.url === `/jouzu/-/${basename(release.path)}`) {
			response.writeHead(200, {
				"content-type": "application/octet-stream",
				"content-length": release.bytes.length,
			});
			response.end(release.bytes);
			return;
		}
		try {
			const upstream = await fetch(`https://registry.npmjs.org${request.url ?? "/"}`, {
				headers: { accept: request.headers.accept ?? "application/json" },
			});
			const bytes = Buffer.from(await upstream.arrayBuffer());
			response.writeHead(upstream.status, {
				"content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
				"content-length": bytes.length,
			});
			response.end(bytes);
		} catch (error) {
			response.writeHead(502, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "upstream_failed", reason: String(error) }));
		}
	});
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	try {
		const address = server.address();
		assert.ok(address && typeof address === "object");
		await callback(`http://127.0.0.1:${address.port}/`, requests);
	} finally {
		await new Promise((resolvePromise, reject) => {
			server.close((error) => (error ? reject(error) : resolvePromise()));
		});
	}
}

function globalBin(prefix) {
	return process.platform === "win32" ? join(prefix, "jouzu.cmd") : join(prefix, "bin", "jouzu");
}

function globalInvocation(prefix, args) {
	return process.platform === "win32"
		? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", globalBin(prefix), ...args] }
		: { command: globalBin(prefix), args };
}

function runGlobal(prefix, args, options = {}) {
	const invocation = globalInvocation(prefix, args);
	return run(invocation.command, invocation.args, options);
}

function globalResult(prefix, args, options = {}) {
	const invocation = globalInvocation(prefix, args);
	return commandResult(invocation.command, invocation.args, options);
}

async function installCurrent(current, prefix) {
	await runNpm(
		["install", "--global", "--prefix", prefix, current.path, "--ignore-scripts", "--no-audit", "--no-fund"],
		{ cwd: root },
	);
}

function updateEnvironment(temp, prefix, home, registry) {
	return {
		...process.env,
		JOUZU_HOME: home,
		npm_config_prefix: prefix,
		npm_config_registry: registry,
		"npm_config_@earendil-works:registry": "https://registry.npmjs.org/",
		npm_config_cache: join(temp, "npm-cache"),
		npm_config_update_notifier: "false",
	};
}

const temp = mkdtempSync(join(tmpdir(), "jouzu-auto-update-"));
let smokeError;
try {
	const current = await createPackage(temp, currentVersion);
	const next = await createPackage(temp, nextVersion);
	const broken = await createPackage(temp, brokenVersion, true);

	const successPrefix = join(temp, "success-prefix");
	const successHome = join(temp, "success-home");
	await installCurrent(current, successPrefix);
	await withRegistry(next, async (registry, requests) => {
		const env = updateEnvironment(temp, successPrefix, successHome, registry);
		const update = await runGlobal(successPrefix, ["self-update", "apply"], {
			cwd: temp,
			env,
			timeout: updateApplyTimeout,
		});
		assert.match(update.stdout, new RegExp(`Updated Jouzu to ${escapeRegex(nextVersion)}`));
		assert.ok(requests.some((request) => request === "/jouzu" || request.startsWith("/jouzu?")));
		assert.ok(requests.includes(`/jouzu/-/${basename(next.path)}`));
		const version = await runGlobal(successPrefix, ["--version"], {
			cwd: temp,
			env: { ...env, JOUZU_NO_UPDATE: "1" },
		});
		assert.match(version.stdout, new RegExp(`^jouzu ${escapeRegex(nextVersion)}$`, "m"));
		const state = JSON.parse(readFileSync(join(successHome, "state", "self-update.json"), "utf8"));
		assert.equal(state.lastResult, "updated");
		assert.equal(state.installedVersion, nextVersion);
		assert.equal(state.previousVersion, currentVersion);
	});

	const rollbackPrefix = join(temp, "rollback-prefix");
	const rollbackHome = join(temp, "rollback-home");
	await installCurrent(current, rollbackPrefix);
	await withRegistry(broken, async (registry) => {
		const env = updateEnvironment(temp, rollbackPrefix, rollbackHome, registry);
		const update = await globalResult(rollbackPrefix, ["self-update", "apply"], {
			cwd: temp,
			env,
			timeout: updateApplyTimeout,
		});
		assert.equal(update.signal, null);
		assert.equal(update.status, 4, update.stderr || update.stdout);
		assert.match(update.stderr, new RegExp(`failed verification and ${escapeRegex(currentVersion)} was restored`));
		const version = await runGlobal(rollbackPrefix, ["--version"], {
			cwd: temp,
			env: { ...env, JOUZU_NO_UPDATE: "1" },
		});
		assert.match(version.stdout, new RegExp(`^jouzu ${escapeRegex(currentVersion)}$`, "m"));
		const state = JSON.parse(readFileSync(join(rollbackHome, "state", "self-update.json"), "utf8"));
		assert.equal(state.lastResult, "failed");
		assert.equal(state.lastErrorCode, "update-rolled-back");
	});

	console.log(
		`automatic update smoke installed ${nextVersion} and restored ${currentVersion} after a broken ${brokenVersion}`,
	);
} catch (error) {
	smokeError = error;
}
try {
	rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
} catch (cleanupError) {
	const code =
		cleanupError && typeof cleanupError === "object" && "code" in cleanupError ? cleanupError.code : undefined;
	if (process.platform === "win32" && (code === "EBUSY" || code === "EPERM")) {
		console.warn("automatic update smoke could not remove its temporary directory after bounded Windows retries");
	} else if (smokeError) {
		console.warn("automatic update smoke also failed to remove its temporary directory");
	} else {
		smokeError = cleanupError;
	}
}
if (smokeError) throw smokeError;
