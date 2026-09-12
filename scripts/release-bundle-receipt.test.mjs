import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
	installedBundleEntries,
	RELEASE_BUNDLE_RECEIPT_SCHEMA_VERSION,
	readReleaseBundleReceipt,
	releaseBundleFingerprint,
	releaseBundleIsCurrent,
	releaseBundleReceiptPath,
	writeReleaseBundleReceipt,
} from "./release-bundle-receipt.mjs";

const FINGERPRINT_FILES = [
	"package-lock.json",
	"packages/cli/package.json",
	"packages/cli/package-lock.json",
	"scripts/install-release-extensions.mjs",
	"scripts/apply-background-flow.mjs",
	"scripts/apply-multiloop-wait-skill.mjs",
	"scripts/webaio-package-boundary.mjs",
];

/** A fixture root with the fingerprinted inputs and an installed bundle tree. */
function fixture(entries = ["pi-webaio", "pi-multiloop", "typebox"]) {
	const root = mkdtempSync(join(tmpdir(), "release-bundle-receipt-"));
	for (const relative of FINGERPRINT_FILES) {
		const path = join(root, relative);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${relative} contents\n`);
	}
	const cli = join(root, "packages", "cli");
	mkdirSync(join(cli, "node_modules"), { recursive: true });
	for (const entry of entries) {
		mkdirSync(join(cli, "node_modules", entry), { recursive: true });
	}
	return { root, cli, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a written receipt makes the same inputs current", () => {
	const { root, cli, cleanup } = fixture();
	try {
		const fingerprint = releaseBundleFingerprint(root);
		assert.equal(releaseBundleIsCurrent(cli, fingerprint), false);
		writeReleaseBundleReceipt(cli, fingerprint);
		assert.equal(releaseBundleIsCurrent(cli, fingerprint), true);
		const receipt = readReleaseBundleReceipt(cli);
		assert.equal(receipt.fingerprint, fingerprint);
		assert.deepEqual(receipt.entries, ["pi-multiloop", "pi-webaio", "typebox"]);
	} finally {
		cleanup();
	}
});

test("the receipt is not recorded as an installed entry", () => {
	const { root, cli, cleanup } = fixture();
	try {
		writeReleaseBundleReceipt(cli, releaseBundleFingerprint(root));
		assert.ok(!installedBundleEntries(cli).includes(".jouzu-release-bundle-receipt"));
		const stored = JSON.parse(readFileSync(releaseBundleReceiptPath(cli), "utf8"));
		assert.equal(stored.schemaVersion, RELEASE_BUNDLE_RECEIPT_SCHEMA_VERSION);
		assert.ok(!stored.entries.includes(".jouzu-release-bundle-receipt"));
	} finally {
		cleanup();
	}
});

test("a changed input invalidates the receipt", () => {
	const { root, cli, cleanup } = fixture();
	try {
		writeReleaseBundleReceipt(cli, releaseBundleFingerprint(root));
		writeFileSync(join(root, "packages", "cli", "package-lock.json"), "changed\n");
		const changed = releaseBundleFingerprint(root);
		assert.equal(releaseBundleIsCurrent(cli, changed), false);
	} finally {
		cleanup();
	}
});

test("a fingerprinted file that disappears changes the fingerprint", () => {
	const { root, cleanup } = fixture();
	try {
		const before = releaseBundleFingerprint(root);
		rmSync(join(root, "scripts", "apply-background-flow.mjs"));
		assert.notEqual(releaseBundleFingerprint(root), before);
	} finally {
		cleanup();
	}
});

test("a removed entry invalidates the receipt even when the file survives", () => {
	const { root, cli, cleanup } = fixture();
	try {
		const fingerprint = releaseBundleFingerprint(root);
		writeReleaseBundleReceipt(cli, fingerprint);
		// The root install replaces the nested layout and keeps only some entries.
		rmSync(join(cli, "node_modules", "pi-webaio"), { recursive: true, force: true });
		assert.equal(releaseBundleIsCurrent(cli, fingerprint), false);
	} finally {
		cleanup();
	}
});

test("a wiped tree invalidates the receipt", () => {
	const { root, cli, cleanup } = fixture();
	try {
		const fingerprint = releaseBundleFingerprint(root);
		writeReleaseBundleReceipt(cli, fingerprint);
		rmSync(join(cli, "node_modules"), { recursive: true, force: true });
		assert.equal(releaseBundleIsCurrent(cli, fingerprint), false);
		assert.equal(readReleaseBundleReceipt(cli), undefined);
	} finally {
		cleanup();
	}
});

test("a malformed receipt is not current", () => {
	const { root, cli, cleanup } = fixture();
	try {
		const fingerprint = releaseBundleFingerprint(root);
		const cases = [
			"not json",
			"[]",
			JSON.stringify({ schemaVersion: 99, fingerprint, entries: ["typebox"] }),
			JSON.stringify({ schemaVersion: 1, fingerprint: "", entries: ["typebox"] }),
			JSON.stringify({ schemaVersion: 1, fingerprint, entries: [] }),
			JSON.stringify({ schemaVersion: 1, fingerprint, entries: "typebox" }),
			JSON.stringify({ schemaVersion: 1, fingerprint, entries: ["../packages"] }),
			JSON.stringify({ schemaVersion: 1, fingerprint, entries: ["a/b"] }),
			JSON.stringify({ schemaVersion: 1, fingerprint, entries: [".."] }),
			JSON.stringify({ schemaVersion: 1, fingerprint, entries: [null] }),
		];
		for (const value of cases) {
			writeFileSync(releaseBundleReceiptPath(cli), value);
			assert.equal(readReleaseBundleReceipt(cli), undefined, `accepted: ${value}`);
			assert.equal(releaseBundleIsCurrent(cli, fingerprint), false, `current: ${value}`);
		}
	} finally {
		cleanup();
	}
});

test("a receipt for another fingerprint is not current", () => {
	const { root, cli, cleanup } = fixture();
	try {
		writeReleaseBundleReceipt(cli, releaseBundleFingerprint(root));
		assert.equal(releaseBundleIsCurrent(cli, "0".repeat(64)), false);
	} finally {
		cleanup();
	}
});
