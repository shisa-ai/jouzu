import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { catalogStatus, formatCatalogStatus, validateCatalogFile } from "../dist/catalog-command.js";

const paths = {
	agentDir: "/unused/agent",
	stateDir: "/unused/state",
	cacheDir: "/unused/cache",
	sessionDir: "/unused/sessions",
	profileStatePath: "/unused/state/profile-state.json",
	backupDir: "/unused/state/backups",
};

test("no catalog endpoint is a normal unconfigured state with no network work", () => {
	let fetchCount = 0;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		fetchCount += 1;
		throw new Error("network must not be reached");
	};
	try {
		const status = catalogStatus(paths, {});
		assert.deepEqual(status, {
			schemaVersion: 1,
			status: "unconfigured",
			configured: false,
			message: "No model catalog endpoint is configured. Jouzu continues using Pi and local model configuration.",
		});
		assert.equal(fetchCount, 0);
		assert.match(formatCatalogStatus(status), /unconfigured/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("catalog file validation fails gracefully", () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-command-"));
	try {
		const invalidPath = join(temporary, "invalid.json");
		writeFileSync(invalidPath, "[]\n");
		const invalid = validateCatalogFile(invalidPath, false);
		assert.equal(invalid.valid, false);
		assert.equal(invalid.error?.code, "invalid_record");

		const missing = validateCatalogFile(join(temporary, "missing.json"), true);
		assert.equal(missing.valid, false);
		assert.match(missing.error?.message ?? "", /does not exist/);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});
