import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, JsonlSessionRepo, type Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { ensurePrivateDirectory } from "../private-fs.js";
import { FlowOwnershipError } from "./ownership.js";

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
