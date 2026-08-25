import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	copyFileSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export class PrivatePathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PrivatePathError";
	}
}

function lstatIfPresent(path: string) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export function validatePrivateDirectory(path: string): void {
	const metadata = lstatIfPresent(path);
	if (metadata && (metadata.isSymbolicLink() || !metadata.isDirectory())) {
		throw new PrivatePathError(`Jouzu-owned directory must be a real directory: ${path}`);
	}
}

function requireDirectory(path: string): void {
	validatePrivateDirectory(path);
	if (process.platform !== "win32") chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

/**
 * Create a Jouzu-owned root or descendant without following symlinks inside
 * that owned boundary. Existing caller-owned ancestors are left unchanged.
 */
export function ensurePrivateDirectory(root: string, directory: string = root): void {
	const resolvedRoot = resolve(root);
	const resolvedDirectory = resolve(directory);
	const relativeDirectory = relative(resolvedRoot, resolvedDirectory);
	if (relativeDirectory === ".." || relativeDirectory.startsWith(`..${sep}`) || isAbsolute(relativeDirectory)) {
		throw new PrivatePathError(`private directory escaped its Jouzu-owned root: ${directory}`);
	}

	if (lstatIfPresent(resolvedRoot) === undefined) {
		mkdirSync(resolvedRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	}
	requireDirectory(resolvedRoot);

	if (relativeDirectory === "") return;
	let current = resolvedRoot;
	for (const part of relativeDirectory.split(sep)) {
		current = resolve(current, part);
		if (lstatIfPresent(current) === undefined) mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE });
		requireDirectory(current);
	}
}

/** Copy a backup into a private owned directory without replacing a prior file. */
export function copyPrivateFile(source: string, destination: string, root: string): void {
	ensurePrivateDirectory(root, dirname(destination));
	copyFileSync(source, destination, constants.COPYFILE_EXCL);
	if (process.platform !== "win32") chmodSync(destination, PRIVATE_FILE_MODE);
}

/**
 * Durably replace a file inside a Jouzu-owned directory. The payload is written
 * to a uniquely named private temporary file, flushed, and renamed over the
 * destination, so a concurrent reader observes either the previous content or
 * the complete new content and never a partial write. The temporary file is
 * removed on every failure path.
 *
 * `root` is the Jouzu-owned boundary the destination must stay inside; it
 * defaults to the destination's own directory for callers that own that
 * directory directly.
 */
export function writeFilePrivateAtomic(
	path: string,
	contents: string | Uint8Array,
	root: string = dirname(path),
): void {
	const directory = dirname(path);
	ensurePrivateDirectory(root, directory);
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, "wx", PRIVATE_FILE_MODE);
		writeFileSync(descriptor, contents);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		rmSync(temporary, { force: true });
	}
}
