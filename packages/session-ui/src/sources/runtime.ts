import { readdir } from "node:fs/promises";
import type { SessionUiCommandRunner } from "./command.js";

export interface RuntimeSnapshot {
	id: string;
	version?: string;
}

interface RuntimeCandidate {
	id: string;
	markers: readonly string[];
	command: string;
	args: readonly string[];
	parse(output: string): string | undefined;
}

const firstVersion =
	(pattern: RegExp) =>
	(output: string): string | undefined =>
		output.match(pattern)?.[1];
const plainVersion = (output: string): string | undefined => output.trim().split(/\s+/)[0] || undefined;

const RUNTIMES: readonly RuntimeCandidate[] = [
	{ id: "bun", markers: ["bun.lock", "bun.lockb"], command: "bun", args: ["--version"], parse: plainVersion },
	{
		id: "deno",
		markers: ["deno.json", "deno.jsonc", "deno.lock"],
		command: "deno",
		args: ["--version"],
		parse: firstVersion(/deno\s+([^\s]+)/i),
	},
	{
		id: "node",
		markers: ["package.json", ".nvmrc", ".node-version"],
		command: "node",
		args: ["--version"],
		parse: plainVersion,
	},
	{
		id: "python",
		markers: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile", ".python-version"],
		command: "python3",
		args: ["--version"],
		parse: firstVersion(/Python\s+([^\s]+)/i),
	},
	{
		id: "go",
		markers: ["go.mod"],
		command: "go",
		args: ["version"],
		parse: firstVersion(/go version go([^\s]+)/i),
	},
	{
		id: "rust",
		markers: ["Cargo.toml"],
		command: "rustc",
		args: ["--version"],
		parse: firstVersion(/rustc\s+([^\s]+)/i),
	},
	{
		id: "java",
		markers: ["pom.xml", "build.gradle", "build.gradle.kts"],
		command: "java",
		args: ["-version"],
		parse: (output) => output.match(/"([^"]+)"/)?.[1] ?? output.match(/version\s+([^\s]+)/i)?.[1],
	},
	{
		id: "ruby",
		markers: ["Gemfile", ".ruby-version"],
		command: "ruby",
		args: ["--version"],
		parse: firstVersion(/ruby\s+([^\s]+)/i),
	},
	{
		id: "php",
		markers: ["composer.json"],
		command: "php",
		args: ["--version"],
		parse: firstVersion(/PHP\s+([^\s]+)/i),
	},
	{
		id: "lua",
		markers: ["stylua.toml", ".stylua.toml", ".luarc.json", ".luarc.jsonc", "init.lua", "lua"],
		command: "lua",
		args: ["-v"],
		parse: firstVersion(/Lua\s+([^\s]+)/i),
	},
];

export function detectRuntime(entries: readonly string[]): RuntimeCandidate | undefined {
	const names = new Set(entries);
	return RUNTIMES.find((runtime) => runtime.markers.some((marker) => names.has(marker)));
}

export async function readRuntimeSnapshot(
	cwd: string,
	run: SessionUiCommandRunner,
	signal?: AbortSignal,
): Promise<RuntimeSnapshot | undefined> {
	let entries: string[];
	try {
		entries = await readdir(cwd);
	} catch {
		return undefined;
	}
	const runtime = detectRuntime(entries);
	if (!runtime) return undefined;
	const result = await run(runtime.command, [...runtime.args], {
		cwd,
		timeout: 2500,
		...(signal ? { signal } : {}),
	});
	if (result.code !== 0 || result.killed) return { id: runtime.id };
	const version = runtime.parse(`${result.stdout}\n${result.stderr}`.trim());
	return { id: runtime.id, ...(version ? { version: version.startsWith("v") ? version : `v${version}` } : {}) };
}
