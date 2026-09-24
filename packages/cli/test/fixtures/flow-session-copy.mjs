import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const digest = (sessionId, branchId) =>
	createHash("sha256")
		.update(JSON.stringify([sessionId, branchId]))
		.digest("hex")
		.slice(0, 32);

async function journal(directory) {
	const files = [];
	for (const folder of await readdir(join(directory, "sessions"), { withFileTypes: true })) {
		assert.ok(folder.isDirectory() && !folder.isSymbolicLink());
		for (const file of await readdir(join(directory, "sessions", folder.name), { withFileTypes: true })) {
			assert.ok(file.isFile() && !file.isSymbolicLink() && file.name.endsWith(".jsonl"));
			files.push(join(directory, "sessions", folder.name, file.name));
		}
	}
	assert.equal(files.length, 1);
	return readFile(files[0], "utf8");
}

/** Copy evidence without opening a writer on the source. Only the copy's storage-location header changes. */
export async function copyFlowSession(sourceSession, sourceFlowRoot, destination) {
	const transcript = await readFile(sourceSession, "utf8");
	const sessionId = JSON.parse(transcript.slice(0, transcript.indexOf("\n"))).id;
	const registryKey = join("session-registry-v1", digest(sessionId, "registry"));
	const registry = await journal(join(sourceFlowRoot, registryKey));
	let state;
	for (const line of registry.trim().split("\n")) {
		const record = JSON.parse(line);
		for (const item of Array.isArray(record) ? record : [record])
			if (item.namespace === "jouzu.flow.session" && item.op === "set") state = item.value;
	}
	assert.equal(state.sessionId, sessionId);
	const branchKey = digest(sessionId, state.activeBranchId);
	const branch = await journal(join(sourceFlowRoot, branchKey));
	const root = join(destination, "flow");
	for (const [key, data] of [
		[registryKey, registry],
		[branchKey, branch],
	]) {
		const target = join(root, key);
		await mkdir(join(target, "sessions", "copy"), { recursive: true });
		const newline = data.indexOf("\n");
		const header = JSON.parse(data.slice(0, newline));
		header.cwd = target;
		await writeFile(join(target, "sessions", "copy", "flow.jsonl"), JSON.stringify(header) + data.slice(newline));
	}
	await copyFile(join(sourceFlowRoot, branchKey, "schema.json"), join(root, branchKey, "schema.json"));
	const sessionFile = join(destination, "session.jsonl");
	await writeFile(sessionFile, transcript);
	return { root, sessionFile };
}
