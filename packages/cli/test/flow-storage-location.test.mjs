import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openLocalFlowSession } from "../dist/flow-control/local-storage.js";
import { BACKGROUND_CONTEXT, setValue, value } from "../dist/flow-control/scalar-storage.js";

const DIGEST = "0123456789abcdef";

async function base(t) {
	const root = await mkdtemp(join(tmpdir(), "flow-location-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

async function save(session, data) {
	await session.mutate(
		(mutation) => mutation.commit([setValue(value("probe", "input"), data)], BACKGROUND_CONTEXT),
		BACKGROUND_CONTEXT,
	);
}

async function journalWith(directory, cwd) {
	const folder = join(directory, "sessions", "flow");
	await mkdir(folder, { recursive: true, mode: 0o700 });
	const header = { v: 4, kind: "header", id: "flow", storageVersion: 1, createdAt: 1789344000000, cwd };
	const row = { kind: "value", op: "set", seq: 1, namespace: "probe", key: "input", value: "kept" };
	await writeFile(
		join(folder, "2026-09-14T00-00-00-000Z_flow.jsonl"),
		`${JSON.stringify(header)}\n${JSON.stringify(row)}\n`,
	);
}

test("flow storage keeps its records when the home folder moves", async (t) => {
	const root = await base(t);
	const before = join(root, "old-home", "state", "flow", DIGEST);
	let session = await openLocalFlowSession(before);
	await save(session, "before the move");
	await session.close(BACKGROUND_CONTEXT);

	await rename(join(root, "old-home"), join(root, "new-home"));
	const after = join(root, "new-home", "state", "flow", DIGEST);
	session = await openLocalFlowSession(after);
	try {
		assert.equal((await session.getValue(value("probe", "input"), BACKGROUND_CONTEXT)).value, "before the move");
		await save(session, "after the move");
		assert.equal((await session.getValue(value("probe", "input"), BACKGROUND_CONTEXT)).value, "after the move");
	} finally {
		await session.close(BACKGROUND_CONTEXT);
	}
});

test("a journal written under a Windows home opens from another absolute path", async (t) => {
	const root = await base(t);
	const directory = join(root, "state", "flow", DIGEST);
	await journalWith(directory, `C:\\Users\\former\\AppData\\Local\\jouzu\\state\\flow\\${DIGEST}`);
	const session = await openLocalFlowSession(directory);
	try {
		assert.equal((await session.getValue(value("probe", "input"), BACKGROUND_CONTEXT)).value, "kept");
	} finally {
		await session.close(BACKGROUND_CONTEXT);
	}
});

test("a journal of another flow store is refused and left unchanged", async (t) => {
	const root = await base(t);
	const directory = join(root, "state", "flow", DIGEST);
	await journalWith(directory, join(root, "state", "flow", "fedcba9876543210"));
	const [file] = await readdir(join(directory, "sessions", "flow"));
	const path = join(directory, "sessions", "flow", file);
	const before = await readFile(path, "utf8");
	await assert.rejects(openLocalFlowSession(directory), /metadata is missing or inconsistent/u);
	assert.equal(await readFile(path, "utf8"), before);
});
