import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, JsonlSessionRepo, type Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { ensurePrivateDirectory } from "../private-fs.js";
import { FlowOwnershipError } from "./ownership.js";

/**
 * Version of the durable record shapes in this directory. State written under an earlier version is
 * isolated rather than migrated: flow control is opt-in and has no released users, so a migration
 * would be written for shapes that will never be produced again. Bump this whenever a persisted
 * record changes shape.
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

/** Called only inside the per-branch writer reservation. Pi owns file naming and replay. */
export async function openLocalFlowSession(directory: string): Promise<Session> {
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
	const repo = new JsonlSessionRepo({ fileSystem: new NodeExecutionEnv({ cwd: directory }), sessionsRoot: root });
	try {
		const metadata = await repo.list(undefined, BACKGROUND_CONTEXT);
		if (
			metadata.length !== files.length ||
			metadata.some((item) => item.id !== "flow" || item.cwd !== directory || !files.includes(item.path))
		)
			throw new FlowOwnershipError("storage", "Flow session metadata is missing or inconsistent.");
		return metadata.length
			? await repo.open(metadata[0], BACKGROUND_CONTEXT)
			: await repo.create({ id: "flow", cwd: directory }, BACKGROUND_CONTEXT);
	} finally {
		// Pi repository close releases discovery resources; the returned Session owns its storage handle.
		await repo.close(BACKGROUND_CONTEXT);
	}
}
