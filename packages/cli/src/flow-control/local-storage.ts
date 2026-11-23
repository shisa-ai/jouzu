import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateDirectory } from "../private-fs.js";
import { createJournalSession, openJournalSession } from "./journal-storage.js";
import { FlowOwnershipError } from "./ownership.js";
import type { Session } from "./scalar-storage.js";

/**
 * Version of incompatible durable record shapes. Optional fields with validated defaults can be
 * added without isolating existing sessions. Incompatible changes require an explicit migration
 * or isolation policy before this version advances.
 */
export const FLOW_STATE_VERSION = 2;

/**
 * Isolate state written under an earlier version, so an older record can never be read as if it
 * matched the current shapes. Returns the path it was moved to, and nothing when there was nothing
 * to isolate. Called inside the writer reservation, before any store attaches.
 */
export async function reconcileFlowStateVersion(directory: string): Promise<string | undefined> {
	const marker = join(directory, "schema.json");
	const sessions = join(directory, "sessions");
	let current: number | undefined;
	try {
		const parsed: unknown = JSON.parse(await readFile(marker, "utf8"));
		const version = (parsed as { version?: unknown } | null)?.version;
		if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
			throw new FlowOwnershipError("storage", "Flow state version marker is unreadable.");
		current = version;
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") throw error;
	}
	let populated = false;
	try {
		populated = (await readdir(sessions)).length > 0;
	} catch (error) {
		if ((error as { code?: string }).code !== "ENOENT") throw error;
	}
	if (current === FLOW_STATE_VERSION) return undefined;
	let isolated: string | undefined;
	if (populated) {
		isolated = `${sessions}.v${current ?? "unversioned"}-${Date.now()}`;
		await rename(sessions, isolated);
	}
	await writeFile(marker, `${JSON.stringify({ version: FLOW_STATE_VERSION })}\n`, { flag: "w" });
	return isolated;
}

/**
 * A journal records the absolute folder it was created in. Its identity is the folder's location
 * inside the flow root: the owner's digest folder and the store folder that holds it. A home that
 * was moved, copied, or reached through another absolute path keeps that identity, so the
 * comparison uses only those last two components of either path style.
 */
function sameFlowLocation(recorded: string, directories: readonly string[]): boolean {
	const tail = (path: string) =>
		path
			.split(/[\\/]+/u)
			.filter(Boolean)
			.slice(-2)
			.join("/");
	const recordedTail = tail(recorded);
	return recordedTail.includes("/") && directories.some((directory) => tail(directory) === recordedTail);
}

/** Called only inside the per-branch writer reservation. Preserve existing journal paths and records. */
export async function openLocalFlowSession(
	directory: string,
	acceptedDirectories: readonly string[] = [],
): Promise<Session> {
	const root = join(directory, "sessions");
	ensurePrivateDirectory(root);
	const files: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.isSymbolicLink())
			throw new FlowOwnershipError("storage", "Unrecognized flow storage entry.");
		const folder = join(root, entry.name);
		for (const file of await readdir(folder, { withFileTypes: true })) {
			if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith(".jsonl"))
				throw new FlowOwnershipError("storage", "Unrecognized flow session file.");
			files.push(join(folder, file.name));
			if (files.length > 1) throw new FlowOwnershipError("storage", "Flow branch storage contains multiple sessions.");
		}
	}
	const path = files[0];
	if (!path) {
		const folder = join(root, "flow");
		ensurePrivateDirectory(root, folder);
		const createdAt = Date.now();
		const filename = `${new Date(createdAt).toISOString().replace(/[:.]/g, "-")}_flow.jsonl`;
		return createJournalSession(join(folder, filename), { id: "flow", cwd: directory, createdAt });
	}
	// Validate identity before opening can repair a torn tail or compact the journal.
	let header: Record<string, unknown>;
	try {
		const text = await readFile(path, "utf8");
		const end = text.indexOf("\n");
		if (end < 0) throw new Error("Missing complete header.");
		header = JSON.parse(text.slice(0, end));
		if (
			header?.v !== 4 ||
			header.kind !== "header" ||
			header.storageVersion !== 1 ||
			header.id !== "flow" ||
			typeof header.cwd !== "string" ||
			!sameFlowLocation(header.cwd, [directory, ...acceptedDirectories]) ||
			!Number.isSafeInteger(header.createdAt) ||
			Number(header.createdAt) < 0
		)
			throw new Error("Invalid journal identity.");
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") throw error;
		throw new FlowOwnershipError("storage", "Flow session metadata is missing or inconsistent.");
	}
	return openJournalSession(path, {
		validateMetadata: (metadata) => {
			if (
				metadata.id !== "flow" ||
				!sameFlowLocation(metadata.cwd, [directory, ...acceptedDirectories]) ||
				metadata.path !== path
			)
				throw new FlowOwnershipError("storage", "Flow session metadata is missing or inconsistent.");
		},
	});
}
