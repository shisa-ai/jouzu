import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
	checkUserInputAdapterGrant,
	USER_INPUT_ADAPTERS_MAX_BYTES,
	userInputAdapterGrantsPath,
} from "../dist/flow-control/user-input-grants.js";

const ADAPTER = "test-input";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "user-input-grants-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const extension = join(root, "extensions", "pi", "index.ts");
	mkdirSync(dirname(extension), { recursive: true });
	writeFileSync(extension, "export default () => {};\n");
	const configPath = userInputAdapterGrantsPath(agentDir);
	return {
		root,
		agentDir,
		extension,
		configPath,
		/** Grant file body for one or more entries. */
		write(grants) {
			writeFileSync(configPath, `${JSON.stringify({ schemaVersion: 1, grants }, null, 2)}\n`);
		},
		/** Run the check against this fixture's resolved agent directory and entry path. */
		check(overrides = {}) {
			return checkUserInputAdapterGrant({
				agentDir,
				loaderExtensionPath: extension,
				adapterId: ADAPTER,
				...overrides,
			});
		},
	};
}

test("a missing grants file denies and is not created", async (t) => {
	const setup = fixture(t);
	assert.equal(existsSync(setup.configPath), false);
	assert.deepEqual(await setup.check(), {
		authorized: false,
		code: "unauthorized",
		reason: "no user-input adapter grants are configured",
	});
	assert.equal(existsSync(setup.configPath), false);
});

test("only the exact extension entry path and adapter ID are authorized", async (t) => {
	const setup = fixture(t);
	setup.write([{ extensionPath: setup.extension, adapterId: ADAPTER }]);
	assert.deepEqual(await setup.check(), {
		authorized: true,
		grant: { extensionPath: realpathSync(setup.extension), adapterId: ADAPTER },
	});

	const sibling = join(dirname(setup.extension), "sibling.ts");
	const otherDirectory = join(setup.root, "extensions", "other", "index.ts");
	for (const path of [sibling, otherDirectory]) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "export default () => {};\n");
	}
	const denied = {
		authorized: false,
		code: "unauthorized",
		reason: "no grant authorizes this extension path and adapter ID",
	};
	for (const overrides of [
		{ adapterId: "test-input-2" },
		{ adapterId: "input" },
		{ loaderExtensionPath: sibling },
		{ loaderExtensionPath: otherDirectory },
		{ loaderExtensionPath: dirname(setup.extension) },
	]) {
		assert.deepEqual(await setup.check(overrides), denied);
	}

	// A grant for another entry path does not authorize this extension.
	setup.write([{ extensionPath: otherDirectory, adapterId: ADAPTER }]);
	assert.deepEqual(await setup.check(), denied);
});

test("symlinked entry paths canonicalize to the installed identity", async (t) => {
	const setup = fixture(t);
	const alias = join(setup.root, "extensions", "alias.ts");
	const chained = join(setup.root, "extensions", "chained.ts");
	symlinkSync(setup.extension, alias);
	symlinkSync(alias, chained);

	setup.write([{ extensionPath: setup.extension, adapterId: ADAPTER }]);
	for (const loaderExtensionPath of [alias, chained]) {
		assert.equal((await setup.check({ loaderExtensionPath })).authorized, true);
	}

	for (const grantedPath of [alias, chained]) {
		setup.write([{ extensionPath: grantedPath, adapterId: ADAPTER }]);
		assert.equal((await setup.check()).authorized, true);
		assert.equal((await setup.check({ loaderExtensionPath: chained })).authorized, true);
	}

	const dangling = join(setup.root, "extensions", "dangling.ts");
	symlinkSync(join(setup.root, "extensions", "missing.ts"), dangling);
	setup.write([{ extensionPath: setup.extension, adapterId: ADAPTER }]);
	assert.deepEqual(await setup.check({ loaderExtensionPath: dangling }), {
		authorized: false,
		code: "unauthorized",
		reason: "the extension identity does not resolve to an installed entry path",
	});
});

test("duplicate grants for one identity and adapter are rejected as ambiguous", async (t) => {
	const setup = fixture(t);
	const alias = join(setup.root, "extensions", "alias.ts");
	symlinkSync(setup.extension, alias);
	const entry = { extensionPath: setup.extension, adapterId: ADAPTER };
	for (const grants of [
		[entry, { ...entry }],
		[entry, { extensionPath: alias, adapterId: ADAPTER }],
	]) {
		setup.write(grants);
		const decision = await setup.check();
		assert.equal(decision.authorized, false);
		assert.equal(decision.code, "invalid-config");
		assert.match(decision.reason, /duplicates an earlier grant/u);
	}
});

test("a stale grant does not deny authorization to another adapter", async (t) => {
	const setup = fixture(t);
	setup.write([
		{ extensionPath: join(setup.root, "extensions", "removed", "index.ts"), adapterId: "removed-adapter" },
		{ extensionPath: setup.extension, adapterId: ADAPTER },
	]);
	assert.equal((await setup.check()).authorized, true);
	assert.equal((await setup.check({ adapterId: "removed-adapter" })).authorized, false);
});

test("malformed configuration is rejected as invalid-config", async (t) => {
	const setup = fixture(t);
	const entry = { extensionPath: "/opt/jouzu/extensions/pi/index.ts", adapterId: ADAPTER };
	const body = (grants) => JSON.stringify({ schemaVersion: 1, grants });
	const many = Array.from({ length: 65 }, (_, index) => ({
		extensionPath: `/opt/jouzu/extensions/${index}.ts`,
		adapterId: ADAPTER,
	}));
	const cases = [
		["", /expected a JSON value/u],
		["null", /must be a JSON object/u],
		["[]", /must be a JSON object/u],
		[JSON.stringify({ schemaVersion: 2, grants: [] }), /require schemaVersion 1/u],
		[JSON.stringify({ grants: [] }), /require schemaVersion 1/u],
		[JSON.stringify({ schemaVersion: 1 }), /require a grants array/u],
		[JSON.stringify({ schemaVersion: 1, grants: {} }), /require a grants array/u],
		[JSON.stringify({ schemaVersion: 1, grants: [], extra: true }), /unknown field: extra/u],
		['{"schemaVersion":1,"schemaVersion":1,"grants":[]}', /duplicate object key/u],
		[body(["grant"]), /grants\[0\] must be an object/u],
		[body([{ ...entry, label: "Test Input" }]), /grants\[0\] contains an unknown field: label/u],
		[body([{ ...entry, extensionPath: 42 }]), /grants\[0\]\.extensionPath must be a string/u],
		[body([{ ...entry, extensionPath: "" }]), /grants\[0\]\.extensionPath must be an absolute path/u],
		[body([{ ...entry, extensionPath: "extensions/pi/index.ts" }]), /must be an absolute path/u],
		[body([{ ...entry, extensionPath: "./extensions/pi/index.ts" }]), /must be an absolute path/u],
		[body([{ ...entry, extensionPath: "~/extensions/pi/index.ts" }]), /must be an absolute path/u],
		[body([{ ...entry, extensionPath: "/opt/jouzu/extensions/*/index.ts" }]), /must not contain glob characters/u],
		[body([{ ...entry, extensionPath: "/opt/jouzu/extensions/pi/../index.ts" }]), /must be a canonical path/u],
		[body([{ ...entry, extensionPath: "/opt/jouzu/extensions//index.ts" }]), /must be a canonical path/u],
		[body([{ ...entry, extensionPath: "/opt/jouzu/extensions/pi/" }]), /must be a canonical path/u],
		[body([{ ...entry, adapterId: 7 }]), /grants\[0\]\.adapterId must be a string/u],
		[body([{ ...entry, adapterId: "Test Input" }]), /grants\[0\]\.adapterId must be a bounded lowercase identifier/u],
		[body([{ ...entry, adapterId: "" }]), /grants\[0\]\.adapterId must be a bounded lowercase identifier/u],
		[body([{ ...entry, adapterId: "a".repeat(65) }]), /bounded lowercase identifier/u],
		[body(many), /allow at most 64 entries/u],
		[
			'{"schemaVersion":1,"grants":[{"extensionPath":"/opt/\\ud800/index.ts","adapterId":"test-input"}]}',
			/unpaired surrogate/u,
		],
	];
	for (const [contents, expected] of cases) {
		writeFileSync(setup.configPath, contents);
		const decision = await setup.check();
		assert.equal(decision.authorized, false, contents.slice(0, 120));
		assert.equal(decision.code, "invalid-config", contents.slice(0, 120));
		assert.match(decision.reason, expected, contents.slice(0, 120));
	}
});

test("the grants file is bounded by bytes and tolerates a byte-order mark", async (t) => {
	const setup = fixture(t);
	const body = `${JSON.stringify(
		{ schemaVersion: 1, grants: [{ extensionPath: setup.extension, adapterId: ADAPTER }] },
		null,
		2,
	)}\n`;
	const exact = body.padEnd(USER_INPUT_ADAPTERS_MAX_BYTES, " ");
	assert.equal(Buffer.byteLength(exact), USER_INPUT_ADAPTERS_MAX_BYTES);
	writeFileSync(setup.configPath, exact);
	assert.equal((await setup.check()).authorized, true);

	writeFileSync(setup.configPath, `\uFEFF${body}`);
	assert.equal((await setup.check()).authorized, true);

	writeFileSync(setup.configPath, `${exact} `);
	assert.deepEqual(await setup.check(), {
		authorized: false,
		code: "invalid-config",
		reason: `user-input adapter grants must be no larger than ${USER_INPUT_ADAPTERS_MAX_BYTES} bytes`,
	});
	assert.equal(readFileSync(setup.configPath, "utf8"), `${exact} `);
});

test("every check rereads the file so revocation applies immediately", async (t) => {
	const setup = fixture(t);
	const granted = [{ extensionPath: setup.extension, adapterId: ADAPTER }];
	setup.write(granted);
	assert.equal((await setup.check()).authorized, true);

	setup.write([]);
	assert.deepEqual(await setup.check(), {
		authorized: false,
		code: "unauthorized",
		reason: "no grant authorizes this extension path and adapter ID",
	});

	setup.write(granted);
	assert.equal((await setup.check()).authorized, true);

	// A same-size rewrite still takes effect, so nothing is cached by file identity.
	setup.write([{ extensionPath: setup.extension, adapterId: "test-inpuu" }]);
	assert.equal((await setup.check()).authorized, false);

	rmSync(setup.configPath);
	assert.deepEqual(await setup.check(), {
		authorized: false,
		code: "unauthorized",
		reason: "no user-input adapter grants are configured",
	});
});

test("the grants file must be a private regular file", async (t) => {
	const setup = fixture(t);
	const real = join(setup.root, "elsewhere.json");
	writeFileSync(real, `${JSON.stringify({ schemaVersion: 1, grants: [] }, null, 2)}\n`);
	symlinkSync(real, setup.configPath);
	assert.deepEqual(await setup.check(), {
		authorized: false,
		code: "invalid-config",
		reason: "user-input adapter grants must be a real regular file",
	});
	rmSync(setup.configPath);

	mkdirSync(setup.configPath);
	assert.deepEqual(await setup.check(), {
		authorized: false,
		code: "invalid-config",
		reason: "user-input adapter grants must be a real regular file",
	});
	rmSync(setup.configPath, { recursive: true });

	const linkedAgentDir = join(setup.root, "linked-agent");
	symlinkSync(setup.agentDir, linkedAgentDir);
	assert.deepEqual(
		await checkUserInputAdapterGrant({
			agentDir: linkedAgentDir,
			loaderExtensionPath: setup.extension,
			adapterId: ADAPTER,
		}),
		{
			authorized: false,
			code: "invalid-config",
			reason: "the agent configuration directory must be a real directory",
		},
	);

	// Rejected checks never create or rewrite the configuration.
	assert.equal(existsSync(setup.configPath), false);
});

test("callers cannot supply or override the authorized identity", async (t) => {
	const setup = fixture(t);
	setup.write([{ extensionPath: setup.extension, adapterId: ADAPTER }]);
	const other = join(dirname(setup.extension), "other.ts");
	writeFileSync(other, "export default () => {};\n");

	const forged = await checkUserInputAdapterGrant({
		agentDir: setup.agentDir,
		loaderExtensionPath: other,
		adapterId: ADAPTER,
		authorized: true,
		grant: { extensionPath: setup.extension, adapterId: ADAPTER },
		origin: { kind: "extension", id: setup.extension },
	});
	assert.equal(forged.authorized, false);
	assert.equal(forged.code, "unauthorized");

	// Synthetic and relative loader identities name no installed entry path.
	for (const loaderExtensionPath of ["<inline>", "<runtime>", "extensions/pi/index.ts", ""]) {
		const decision = await setup.check({ loaderExtensionPath });
		assert.equal(decision.authorized, false, loaderExtensionPath);
		assert.equal(decision.code, "unauthorized", loaderExtensionPath);
	}

	const decision = await setup.check();
	assert.equal(decision.authorized, true);
	assert.equal(Object.isFrozen(decision.grant), true);
});

test("a malformed agent directory or adapter ID is denied", async (t) => {
	const setup = fixture(t);
	setup.write([{ extensionPath: setup.extension, adapterId: ADAPTER }]);
	assert.deepEqual(await setup.check({ agentDir: "agent" }), {
		authorized: false,
		code: "invalid-config",
		reason: "the agent configuration directory is not an absolute path",
	});
	for (const adapterId of ["Test Input", "", "test input", "test-input/", "a".repeat(65)]) {
		const decision = await setup.check({ adapterId });
		assert.equal(decision.authorized, false, adapterId);
		assert.equal(decision.code, "unauthorized", adapterId);
		assert.equal(decision.reason, "the adapter ID is not a bounded lowercase identifier", adapterId);
	}
});
