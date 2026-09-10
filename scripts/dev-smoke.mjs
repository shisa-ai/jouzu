#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A fresh Windows runtime can spend over 15 seconds loading the bundled extensions.
export function smokeDevelopmentRuntime(entrypoint, { timeout = process.platform === "win32" ? 60_000 : 15_000 } = {}) {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-dev-smoke-"));
	try {
		const result = spawnSync(
			process.execPath,
			[
				resolve(entrypoint),
				"--jouzu-profile",
				"core",
				"--mode",
				"rpc",
				"--no-session",
				"--no-context-files",
				"--no-approve",
			],
			{
				cwd: temporary,
				encoding: "utf8",
				input: '{"id":"dev-build","type":"get_state"}\n',
				timeout,
				killSignal: "SIGKILL",
				maxBuffer: 1_000_000,
				env: {
					...process.env,
					JOUZU_HOME: join(temporary, "Jouzu 上手"),
					JOUZU_NO_UPDATE: "1",
					PI_OFFLINE: "1",
					PI_SKIP_VERSION_CHECK: "1",
					PI_TELEMETRY: "0",
				},
			},
		);
		if (result.error || result.status !== 0) throw new Error("dev-build: Jouzu RPC smoke failed or timed out");
		let records;
		try {
			records = result.stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		} catch {
			throw new Error("dev-build: Jouzu RPC smoke returned invalid output");
		}
		const response = records.find((record) => record?.id === "dev-build" && record.type === "response");
		if (
			!response?.success ||
			response.command !== "get_state" ||
			response.data?.isStreaming !== false ||
			response.data.sessionFile !== undefined
		) {
			throw new Error("dev-build: Jouzu RPC smoke returned invalid output");
		}
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (!process.argv[2]) throw new Error("dev-build: provide the built CLI entrypoint");
		smokeDevelopmentRuntime(process.argv[2]);
		console.log("dev-build: Jouzu RPC smoke passed");
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
