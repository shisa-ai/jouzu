import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";
import { createInterface } from "node:readline/promises";
import type { JouzuPaths } from "./paths.js";
import { validatePrivateDirectory, writeFilePrivateAtomic, writeFilePrivateExclusive } from "./private-fs.js";
import { acquireStateLock } from "./state-lock.js";

const IMPORT_FILE_LIMIT = 10 * 1024 * 1024;
const IMPORT_STATE_FIELDS = new Set(["schemaVersion", "models", "auth", "decidedAt"]);
const IMPORT_ITEM_FIELDS = new Set(["status", "source"]);

export type PiImportStatus = "imported" | "declined" | "not-found" | "invalid-source" | "destination-exists";
export type PiImportSource = "inherited" | "default";

export interface PiImportItemResult {
	status: PiImportStatus;
	source?: PiImportSource;
}

export interface PiImportReceipt {
	schemaVersion: 1;
	models: PiImportItemResult;
	auth: PiImportItemResult;
	decidedAt: string;
}

export interface PiImportOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	cwd?: string;
	inheritedAgentDir?: string;
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
	now?: Date;
	maxFileBytes?: number;
	ask?: (question: string) => Promise<string>;
}

interface ImportCandidate {
	kind: "models" | "auth";
	filename: "models.json" | "auth.json";
	sourcePath?: string;
	source?: PiImportSource;
	contents?: Buffer;
	status: "candidate" | Exclude<PiImportStatus, "imported" | "declined">;
}

export class PiImportError extends Error {
	readonly exitCode = 1;

	constructor(message: string) {
		super(message);
		this.name = "PiImportError";
	}
}

function pathApi(platform: NodeJS.Platform) {
	return platform === "win32" ? win32 : posix;
}

function nonEmpty(value: string | undefined): string | undefined {
	return value && value.trim().length > 0 ? value : undefined;
}

function absolutePath(value: string, home: string, cwd: string, platform: NodeJS.Platform): string {
	const api = pathApi(platform);
	const expanded =
		value === "~" ? home : value.startsWith("~/") || value.startsWith("~\\") ? api.join(home, value.slice(2)) : value;
	return api.resolve(cwd, expanded);
}

export function defaultPiAgentDir(platform: NodeJS.Platform, home: string): string {
	return pathApi(platform).join(home, ".pi", "agent");
}

export function parsePiImportAnswer(answer: string): boolean {
	return /^(?:y|yes)$/iu.test(answer.trim());
}

function importStatePath(paths: JouzuPaths, platform: NodeJS.Platform): string {
	return pathApi(platform).join(paths.stateDir, "pi-import.json");
}

function validateItem(value: unknown): value is PiImportItemResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const item = value as Record<string, unknown>;
	if (!Object.keys(item).every((key) => IMPORT_ITEM_FIELDS.has(key))) return false;
	if (
		!(["imported", "declined", "not-found", "invalid-source", "destination-exists"] as unknown[]).includes(item.status)
	) {
		return false;
	}
	return item.source === undefined || item.source === "inherited" || item.source === "default";
}

export function readPiImportReceipt(path: string): PiImportReceipt | undefined {
	try {
		validatePrivateDirectory(dirname(path));
	} catch (error) {
		throw new PiImportError(error instanceof Error ? error.message : String(error));
	}
	if (!existsSync(path)) return undefined;
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) throw new PiImportError("import receipt must be a regular file");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new PiImportError(
			`import receipt is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new PiImportError("import receipt must be an object");
	const receipt = parsed as Record<string, unknown>;
	if (!Object.keys(receipt).every((key) => IMPORT_STATE_FIELDS.has(key))) {
		throw new PiImportError("import receipt has unknown fields");
	}
	if (
		receipt.schemaVersion !== 1 ||
		!validateItem(receipt.models) ||
		!validateItem(receipt.auth) ||
		typeof receipt.decidedAt !== "string" ||
		!Number.isFinite(Date.parse(receipt.decidedAt))
	) {
		throw new PiImportError("import receipt fields are invalid");
	}
	return receipt as unknown as PiImportReceipt;
}

function sourceRoots(paths: JouzuPaths, options: PiImportOptions): Array<{ path: string; source: PiImportSource }> {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const home = options.homeDir ?? homedir();
	const cwd = options.cwd ?? process.cwd();
	const api = pathApi(platform);
	const destination = api.resolve(paths.agentDir);
	const destinationKey = platform === "win32" ? destination.toLowerCase() : destination;
	const roots: Array<{ path: string; source: PiImportSource }> = [];
	const inherited = nonEmpty(options.inheritedAgentDir ?? env.PI_CODING_AGENT_DIR);
	if (inherited) roots.push({ path: absolutePath(inherited, home, cwd, platform), source: "inherited" });
	roots.push({ path: defaultPiAgentDir(platform, home), source: "default" });
	const seen = new Set<string>();
	return roots.filter((root) => {
		const resolved = api.resolve(root.path);
		const key = platform === "win32" ? resolved.toLowerCase() : resolved;
		if (key === destinationKey || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function readJsonObjectFile(path: string, maxFileBytes: number): Buffer | undefined {
	let descriptor: number | undefined;
	try {
		const before = lstatSync(path);
		if (!before.isFile() || before.isSymbolicLink() || before.size > maxFileBytes) return undefined;
		descriptor = openSync(path, constants.O_RDONLY);
		const opened = fstatSync(descriptor);
		const after = lstatSync(path);
		if (
			!opened.isFile() ||
			!after.isFile() ||
			after.isSymbolicLink() ||
			before.dev !== opened.dev ||
			before.ino !== opened.ino ||
			after.dev !== opened.dev ||
			after.ino !== opened.ino ||
			opened.size > maxFileBytes
		) {
			return undefined;
		}
		const contents = readFileSync(descriptor);
		if (contents.byteLength > maxFileBytes) return undefined;
		const text = contents.toString("utf8").replace(/^\uFEFF/u, "");
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? contents : undefined;
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function candidateFor(
	kind: "models" | "auth",
	filename: "models.json" | "auth.json",
	paths: JouzuPaths,
	roots: Array<{ path: string; source: PiImportSource }>,
	platform: NodeJS.Platform,
	maxFileBytes: number,
): ImportCandidate {
	const api = pathApi(platform);
	if (existsSync(api.join(paths.agentDir, filename))) return { kind, filename, status: "destination-exists" };
	for (const root of roots) {
		const sourcePath = api.join(root.path, filename);
		if (!existsSync(sourcePath)) continue;
		const contents = readJsonObjectFile(sourcePath, maxFileBytes);
		if (!contents) return { kind, filename, sourcePath, source: root.source, status: "invalid-source" };
		return { kind, filename, sourcePath, source: root.source, contents, status: "candidate" };
	}
	return { kind, filename, status: "not-found" };
}

function questionFor(candidate: ImportCandidate): string {
	if (candidate.kind === "models") {
		return (
			`Found existing Pi custom models at ${candidate.sourcePath}.\n` +
			"Copy models.json into Jouzu's isolated configuration? The Pi source will not be changed. [y/N] "
		);
	}
	return (
		`Found saved Pi provider credentials at ${candidate.sourcePath}.\n` +
		"Copy auth.json into Jouzu's private configuration? The Pi source will not be changed. [y/N] "
	);
}

async function offerPiConfigurationImportLocked(
	paths: JouzuPaths,
	options: PiImportOptions,
): Promise<PiImportReceipt | undefined> {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	if (env.JOUZU_NO_PI_IMPORT === "1") return undefined;
	const statePath = importStatePath(paths, platform);
	const existing = readPiImportReceipt(statePath);
	if (existing) return existing;

	const roots = sourceRoots(paths, options);
	const maxFileBytes = options.maxFileBytes ?? IMPORT_FILE_LIMIT;
	const candidates = [
		candidateFor("models", "models.json", paths, roots, platform, maxFileBytes),
		candidateFor("auth", "auth.json", paths, roots, platform, maxFileBytes),
	] as const;
	const output = options.output ?? process.stdout;
	let readline: ReturnType<typeof createInterface> | undefined;
	const ask =
		options.ask ??
		(async (question: string) => {
			readline ??= createInterface({ input: options.input ?? process.stdin, output });
			return readline.question(question);
		});

	const results: Partial<Record<"models" | "auth", PiImportItemResult>> = {};
	try {
		for (const candidate of candidates) {
			if (candidate.status !== "candidate") {
				results[candidate.kind] = {
					status: candidate.status,
					...(candidate.source ? { source: candidate.source } : {}),
				};
				if (candidate.status === "invalid-source") {
					output.write(`Existing Pi ${candidate.filename} was not imported because it is not a regular JSON object.\n`);
				}
				continue;
			}
			const accepted = parsePiImportAnswer(await ask(questionFor(candidate)));
			if (!accepted) {
				results[candidate.kind] = { status: "declined", source: candidate.source };
				continue;
			}
			if (!candidate.sourcePath || !candidate.source || !candidate.contents) {
				throw new PiImportError("import candidate is incomplete");
			}
			try {
				writeFilePrivateExclusive(
					pathApi(platform).join(paths.agentDir, candidate.filename),
					candidate.contents,
					paths.agentDir,
				);
				results[candidate.kind] = { status: "imported", source: candidate.source };
				output.write(`Imported ${candidate.filename} into Jouzu.\n`);
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "EEXIST") {
					results[candidate.kind] = { status: "destination-exists", source: candidate.source };
					output.write(`Skipped ${candidate.filename} because Jouzu already has one.\n`);
					continue;
				}
				throw new PiImportError(
					`could not import ${candidate.filename}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	} finally {
		readline?.close();
	}

	if (!results.models || !results.auth) throw new PiImportError("import decisions are incomplete");
	const receipt: PiImportReceipt = {
		schemaVersion: 1,
		models: results.models,
		auth: results.auth,
		decidedAt: (options.now ?? new Date()).toISOString(),
	};
	writeFilePrivateAtomic(statePath, `${JSON.stringify(receipt, null, 2)}\n`, paths.stateDir);
	return receipt;
}

export async function offerPiConfigurationImport(
	paths: JouzuPaths,
	options: PiImportOptions = {},
): Promise<PiImportReceipt | undefined> {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	if (env.JOUZU_NO_PI_IMPORT === "1") return undefined;
	const release = acquireStateLock({
		path: pathApi(platform).join(paths.stateDir, "pi-import.lock"),
		describe: "Pi import",
		now: options.now,
		onBusy: () => new PiImportError("another Pi import decision is in progress"),
	});
	try {
		return await offerPiConfigurationImportLocked(paths, options);
	} finally {
		release();
	}
}
