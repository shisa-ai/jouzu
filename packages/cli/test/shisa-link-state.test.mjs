import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveJouzuPaths } from "../dist/paths.js";
import {
	clearShisaLinkState,
	newShisaInstallId,
	parseShisaLinkState,
	readShisaLinkState,
	shisaLinkStatePath,
	writeShisaLinkState,
} from "../dist/shisa-link/state.js";

function tempHome() {
	return mkdtempSync(join(tmpdir(), "jouzu-shisa-link-"));
}

function sampleState(overrides = {}) {
	return {
		install_id: "3f6b8c1e-0d5a-4c7e-9a2b-6e1f0d8c4b5a",
		authorization_id: "auth-123",
		api_key_uuid: "key-456",
		org: { id: "org-1", name: "Shisa", slug: "shisa" },
		endpoints: {
			openai_base_url: "https://gateway.shisa.ai/v1",
			model_catalog_url: "https://gateway.shisa.ai/catalog",
			asr_realtime_url: "wss://gateway.shisa.ai/asr",
		},
		link_token: "link-token-secret",
		acked: false,
		...overrides,
	};
}

test("shisa link state path lives in the state directory", () => {
	const home = tempHome();
	try {
		const paths = resolveJouzuPaths({ homeOverride: home });
		assert.equal(shisaLinkStatePath(paths), join(paths.stateDir, "shisa-link.json"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("shisa link state round-trips through the private state file", async () => {
	const home = tempHome();
	try {
		const paths = resolveJouzuPaths({ homeOverride: home });
		const path = shisaLinkStatePath(paths);
		const state = sampleState({ bonus: { status: "available", amount_usd: 10 } });
		await writeShisaLinkState(path, state, paths.stateDir);
		assert.deepEqual(readShisaLinkState(path), state);
		// The stored document is plain JSON with the exact contract fields.
		const stored = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(stored.authorization_id, "auth-123");
		assert.equal(stored.bonus.status, "available");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("shisa link state file is written with private-file semantics", async () => {
	const home = tempHome();
	try {
		const paths = resolveJouzuPaths({ homeOverride: home });
		const path = shisaLinkStatePath(paths);
		mkdirSync(paths.stateDir, { recursive: true });
		// A pre-existing wide-open file must converge to the private mode on rewrite.
		writeFileSync(path, "{}\n", { mode: 0o644 });
		if (process.platform !== "win32") chmodSync(path, 0o644);
		await writeShisaLinkState(path, sampleState(), paths.stateDir);
		if (process.platform !== "win32") {
			const mode = statSync(path).mode & 0o777;
			assert.equal(mode, 0o600, "shisa link state must not be readable by group or others");
		}
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("shisa link state refuses to persist an incomplete state object", async () => {
	const home = tempHome();
	try {
		const paths = resolveJouzuPaths({ homeOverride: home });
		const path = shisaLinkStatePath(paths);
		await assert.rejects(
			() => writeShisaLinkState(path, sampleState({ link_token: undefined }), paths.stateDir),
			/incomplete/i,
		);
		assert.equal(existsSync(path), false, "nothing may be written for an invalid state");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("shisa link state reads resolve to undefined for absent or corrupt files", () => {
	const home = tempHome();
	try {
		const paths = resolveJouzuPaths({ homeOverride: home });
		const path = shisaLinkStatePath(paths);
		assert.equal(readShisaLinkState(path), undefined, "missing file reads as unlinked");
		mkdirSync(paths.stateDir, { recursive: true });
		writeFileSync(path, "not json at all");
		assert.equal(readShisaLinkState(path), undefined, "corrupt file reads as unlinked");
		writeFileSync(path, JSON.stringify({ install_id: "nope" }));
		assert.equal(readShisaLinkState(path), undefined, "partial state reads as unlinked");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("install_id is a random UUID that stays stable across loads", async () => {
	const home = tempHome();
	try {
		const paths = resolveJouzuPaths({ homeOverride: home });
		const path = shisaLinkStatePath(paths);
		const first = newShisaInstallId();
		const second = newShisaInstallId();
		assert.notEqual(first, second, "each generated install id is fresh");
		assert.match(first, /^[0-9a-f-]{36}$/u);
		await writeShisaLinkState(path, sampleState({ install_id: first }), paths.stateDir);
		const loaded = readShisaLinkState(path);
		assert.equal(loaded?.install_id, first);
		assert.equal(readShisaLinkState(path)?.install_id, first, "repeated loads keep the same install id");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("parseShisaLinkState rejects malformed payloads without throwing", () => {
	assert.equal(parseShisaLinkState(undefined), undefined);
	assert.equal(parseShisaLinkState("string"), undefined);
	assert.equal(parseShisaLinkState([]), undefined);
	assert.equal(parseShisaLinkState(sampleState({ install_id: "not-a-uuid" })), undefined);
	assert.equal(parseShisaLinkState(sampleState({ acked: "yes" })), undefined);
	assert.equal(parseShisaLinkState(sampleState({ org: { id: "o", name: "n" } })), undefined);
	assert.equal(
		parseShisaLinkState(sampleState({ endpoints: { ...sampleState().endpoints, asr_realtime_url: "" } })),
		undefined,
	);
	assert.equal(parseShisaLinkState(sampleState({ bonus: { amount_usd: 10 } })), undefined);
	const parsed = parseShisaLinkState(sampleState({ bonus: { status: "available" } }));
	assert.deepEqual(parsed?.bonus, { status: "available" });
});

test("clearShisaLinkState removes the file and tolerates absence", async () => {
	const home = tempHome();
	try {
		const paths = resolveJouzuPaths({ homeOverride: home });
		const path = shisaLinkStatePath(paths);
		clearShisaLinkState(path);
		await writeShisaLinkState(path, sampleState(), paths.stateDir);
		assert.ok(existsSync(path));
		clearShisaLinkState(path);
		assert.equal(existsSync(path), false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
