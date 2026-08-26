import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	copyPrivateFile,
	ensurePrivateDirectory,
	PrivatePathError,
	writeFilePrivateAtomic,
	writeFilePrivateExclusive,
} from "../dist/private-fs.js";

function modeOf(path) {
	return statSync(path).mode & 0o777;
}

test(
	"private roots, cache descendants, backups, and files use deterministic modes",
	{ skip: process.platform === "win32" ? "POSIX permission assertion" : false },
	() => {
		const temporary = mkdtempSync(join(tmpdir(), "jouzu-private-fs-"));
		try {
			const callerRoot = join(temporary, "caller-home");
			mkdirSync(callerRoot, { mode: 0o755 });
			const stateRoot = join(callerRoot, "state");
			mkdirSync(stateRoot, { mode: 0o755 });
			ensurePrivateDirectory(stateRoot);
			assert.equal(modeOf(callerRoot), 0o755, "caller-owned parent mode changed");
			assert.equal(modeOf(stateRoot), 0o700, "existing Jouzu root was not repaired");

			const cacheRoot = join(callerRoot, "cache");
			const download = join(cacheRoot, "self-update-test");
			ensurePrivateDirectory(cacheRoot, download);
			assert.equal(modeOf(cacheRoot), 0o700);
			assert.equal(modeOf(download), 0o700);

			const source = join(temporary, "source.json");
			writeFileSync(source, "{}\n", { mode: 0o644 });
			const backup = join(stateRoot, "backups", "tx", "settings.json");
			copyPrivateFile(source, backup, stateRoot);
			assert.equal(modeOf(join(stateRoot, "backups")), 0o700);
			assert.equal(modeOf(join(stateRoot, "backups", "tx")), 0o700);
			assert.equal(modeOf(backup), 0o600);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	},
);

test(
	"private directory creation rejects root and descendant symlinks",
	{ skip: process.platform === "win32" ? "symlink fixture requires privileges" : false },
	() => {
		const temporary = mkdtempSync(join(tmpdir(), "jouzu-private-symlink-"));
		try {
			const outside = join(temporary, "outside");
			mkdirSync(outside);
			const linkedRoot = join(temporary, "state");
			symlinkSync(outside, linkedRoot);
			assert.throws(() => ensurePrivateDirectory(linkedRoot), PrivatePathError);
			assert.deepEqual(readdirSync(outside), []);

			const realRoot = join(temporary, "real-state");
			ensurePrivateDirectory(realRoot);
			const linkedBackup = join(realRoot, "backups");
			symlinkSync(outside, linkedBackup);
			assert.throws(() => ensurePrivateDirectory(realRoot, join(linkedBackup, "tx")), PrivatePathError);
			assert.deepEqual(readdirSync(outside), []);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	},
);

test("writeFilePrivateExclusive creates once and preserves an existing destination", () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-exclusive-"));
	try {
		const root = join(temporary, "state");
		const target = join(root, "nested", "value.json");
		writeFilePrivateExclusive(target, "first\n", root);
		assert.equal(readFileSync(target, "utf8"), "first\n");
		assert.throws(() => writeFilePrivateExclusive(target, "second\n", root), /EEXIST/);
		assert.equal(readFileSync(target, "utf8"), "first\n");
		if (process.platform !== "win32") assert.equal(modeOf(target), 0o600);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("writeFilePrivateAtomic replaces content and leaves no temporary file", () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-atomic-"));
	try {
		const root = join(temporary, "state");
		const target = join(root, "nested", "value.json");

		writeFilePrivateAtomic(target, "first\n", root);
		assert.equal(readFileSync(target, "utf8"), "first\n");

		writeFilePrivateAtomic(target, "second\n", root);
		assert.equal(readFileSync(target, "utf8"), "second\n", "an existing file is replaced, not appended");

		writeFilePrivateAtomic(target, new Uint8Array([0x7b, 0x7d]), root);
		assert.equal(readFileSync(target, "utf8"), "{}", "byte payloads are written verbatim");

		assert.deepEqual(
			readdirSync(join(root, "nested")).filter((entry) => entry.endsWith(".tmp")),
			[],
			"no temporary file survives a successful write",
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test(
	"writeFilePrivateAtomic creates private files and defaults its root to the destination",
	{ skip: process.platform === "win32" ? "POSIX permission assertion" : false },
	() => {
		const temporary = mkdtempSync(join(tmpdir(), "jouzu-atomic-mode-"));
		try {
			const target = join(temporary, "owned", "value.json");
			// Omitting the root treats the destination's own directory as the boundary.
			writeFilePrivateAtomic(target, "{}\n");
			assert.equal(modeOf(target), 0o600);
			assert.equal(modeOf(join(temporary, "owned")), 0o700);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	},
);

test("writeFilePrivateAtomic refuses a destination outside its owned root", () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-atomic-escape-"));
	try {
		const root = join(temporary, "state");
		ensurePrivateDirectory(root);
		assert.throws(
			() => writeFilePrivateAtomic(join(temporary, "elsewhere", "value.json"), "{}\n", root),
			PrivatePathError,
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});
