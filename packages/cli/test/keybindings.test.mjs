import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	applyKeybindings,
	ensureDefaultKeybindings,
	JOUZU_KEYBINDING_DEFAULTS,
	KeybindingConflictError,
	keybindingStatePath,
	planKeybindings,
	readKeybindingConfig,
	resetKeybindings,
} from "../dist/keybindings.js";

function fixture(label = "jouzu-keybindings-") {
	const root = mkdtempSync(join(tmpdir(), label));
	const paths = {
		agentDir: join(root, "設定", "agent"),
		stateDir: join(root, "状態", "state"),
		cacheDir: join(root, "cache"),
		sessionDir: join(root, "状態", "state", "sessions"),
		profileStatePath: join(root, "状態", "state", "profile-state.json"),
		backupDir: join(root, "状態", "state", "backups"),
	};
	return { root, paths, configPath: join(paths.agentDir, "keybindings.json") };
}

function writeConfig(context, value) {
	mkdirSync(context.paths.agentDir, { recursive: true });
	writeFileSync(context.configPath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeV1OwnedDefaults(context, config = {}) {
	writeConfig(context, {
		"app.message.followUp": "tab",
		"app.message.dequeue": "ctrl+up",
		...config,
	});
	mkdirSync(context.paths.stateDir, { recursive: true });
	writeFileSync(
		keybindingStatePath(context.paths),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				defaultsVersion: 1,
				policy: "applied",
				transactionId: "v0.1.0-seed",
				updatedAt: "2026-08-20T12:00:00.000Z",
				createdConfig: true,
				insertedBindings: [
					{ action: "app.message.dequeue", binding: "ctrl+up" },
					{ action: "app.message.followUp", binding: "tab" },
				],
			},
			null,
			2,
		)}\n`,
	);
}

test("keybinding plans report modified-arrow and platform portability without changing defaults", () => {
	const context = fixture();
	try {
		const linux = planKeybindings(context.paths, { platform: "linux", env: {} });
		assert.equal(
			linux.portabilityWarnings.some((warning) => /ctrl\+enter.*Kitty.*modifyOtherKeys/.test(warning)),
			true,
		);
		assert.equal(
			linux.portabilityWarnings.some((warning) => /tmux.*csi-u/.test(warning)),
			true,
		);
		const mac = planKeybindings(context.paths, { platform: "darwin", env: {} });
		assert.equal(
			mac.portabilityWarnings.some((warning) => /Mission Control/.test(warning)),
			true,
		);
		const dumb = planKeybindings(context.paths, { platform: "linux", env: { TERM: "dumb" } });
		assert.equal(
			dumb.portabilityWarnings.some((warning) => /TERM=dumb/.test(warning)),
			true,
		);
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("a first interactive bootstrap seeds Jouzu defaults once and converges", () => {
	const context = fixture();
	try {
		const initial = planKeybindings(context.paths);
		assert.equal(initial.status, "uninitialized");
		assert.deepEqual(
			initial.actions.map((action) => [action.type, action.action, action.binding]),
			[
				["set", "app.message.followUp", "ctrl+enter"],
				["set", "app.message.dequeue", "ctrl+up"],
			],
		);
		assert.deepEqual(ensureDefaultKeybindings(context.paths, {}), { changed: true });
		assert.deepEqual(readKeybindingConfig(context.configPath), JOUZU_KEYBINDING_DEFAULTS);
		const state = JSON.parse(readFileSync(keybindingStatePath(context.paths), "utf8"));
		assert.equal(state.policy, "applied");
		assert.equal(state.createdConfig, true);
		assert.deepEqual(
			state.insertedBindings.map((entry) => entry.action),
			["app.message.dequeue", "app.message.followUp"],
		);
		assert.equal(planKeybindings(context.paths).status, "converged");
		assert.deepEqual(ensureDefaultKeybindings(context.paths, {}), { changed: false });
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("v0.1.0-owned Tab defaults migrate to Ctrl+Enter with a backup", () => {
	const context = fixture();
	try {
		const previous = {
			"app.message.followUp": "tab",
			"app.message.dequeue": "ctrl+up",
			"tui.editor.cursorWordLeft": "alt+b",
		};
		writeV1OwnedDefaults(context, { "tui.editor.cursorWordLeft": "alt+b" });
		assert.deepEqual(
			planKeybindings(context.paths).actions.map((action) => [
				action.type,
				action.action,
				action.binding,
				action.observed,
				action.reason,
			]),
			[["set", "app.message.followUp", "ctrl+enter", "tab", "owned-default-upgrade"]],
		);
		assert.deepEqual(ensureDefaultKeybindings(context.paths, {}), { changed: true });
		assert.deepEqual(readKeybindingConfig(context.configPath), {
			"app.message.followUp": "ctrl+enter",
			"app.message.dequeue": "ctrl+up",
			"tui.editor.cursorWordLeft": "alt+b",
		});
		const state = JSON.parse(readFileSync(keybindingStatePath(context.paths), "utf8"));
		assert.equal(state.defaultsVersion, 2);
		assert.deepEqual(state.insertedBindings, [
			{ action: "app.message.dequeue", binding: "ctrl+up" },
			{ action: "app.message.followUp", binding: "ctrl+enter" },
		]);
		const [transaction] = readdirSync(join(context.paths.backupDir, "keybindings"));
		assert.deepEqual(
			JSON.parse(readFileSync(join(context.paths.backupDir, "keybindings", transaction, "keybindings.json"), "utf8")),
			previous,
		);
		assert.deepEqual(ensureDefaultKeybindings(context.paths, {}), { changed: false });
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("the v0.1.0 upgrade drops stale ownership without changing user-modified bindings", () => {
	const context = fixture();
	try {
		writeV1OwnedDefaults(context, { "app.message.followUp": "ctrl+f" });
		const before = readFileSync(context.configPath);
		assert.deepEqual(ensureDefaultKeybindings(context.paths, {}), { changed: true });
		assert.deepEqual(readFileSync(context.configPath), before);
		const state = JSON.parse(readFileSync(keybindingStatePath(context.paths), "utf8"));
		assert.equal(state.defaultsVersion, 2);
		assert.deepEqual(state.insertedBindings, [{ action: "app.message.dequeue", binding: "ctrl+up" }]);
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("the v0.1.0 upgrade restores Tab when Ctrl+Enter is already claimed", () => {
	const context = fixture();
	try {
		writeV1OwnedDefaults(context, { "app.model.select": "ctrl+enter" });
		const result = ensureDefaultKeybindings(context.paths, {});
		assert.equal(result.changed, true);
		assert.match(result.message, /removed its previous tab binding.*assigned to app\.model\.select/);
		assert.deepEqual(readKeybindingConfig(context.configPath), {
			"app.message.dequeue": "ctrl+up",
			"app.model.select": "ctrl+enter",
		});
		const state = JSON.parse(readFileSync(keybindingStatePath(context.paths), "utf8"));
		assert.equal(state.defaultsVersion, 2);
		assert.deepEqual(state.insertedBindings, [{ action: "app.message.dequeue", binding: "ctrl+up" }]);
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("an existing exact personal map is adopted without a Jouzu write or ownership receipt", () => {
	const context = fixture();
	try {
		writeConfig(context, JOUZU_KEYBINDING_DEFAULTS);
		const before = readFileSync(context.configPath);
		assert.deepEqual(ensureDefaultKeybindings(context.paths, {}), { changed: false });
		assert.deepEqual(readFileSync(context.configPath), before);
		assert.equal(existsSync(keybindingStatePath(context.paths)), false);
		assert.equal(planKeybindings(context.paths).status, "converged");
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("Pi legacy message action names are recognized without rewriting before Pi migrates them", () => {
	const context = fixture();
	try {
		writeConfig(context, { followUp: "ctrl+enter", dequeue: "ctrl+up" });
		const before = readFileSync(context.configPath);
		const plan = planKeybindings(context.paths);
		assert.equal(plan.status, "converged");
		assert.deepEqual(plan.actions, []);
		assert.deepEqual(ensureDefaultKeybindings(context.paths, {}), { changed: false });
		assert.deepEqual(readFileSync(context.configPath), before);
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("startup preserves an existing user file while explicit apply merges missing defaults", () => {
	const context = fixture();
	try {
		writeConfig(context, { "tui.editor.historyPrevious": "ctrl+p" });
		const before = readFileSync(context.configPath);
		assert.deepEqual(ensureDefaultKeybindings(context.paths, {}), { changed: false });
		assert.deepEqual(readFileSync(context.configPath), before);

		const result = applyKeybindings(context.paths, new Date("2026-08-20T12:00:00.000Z"));
		assert.equal(result.changed, true);
		assert.ok(result.backupDir);
		assert.equal(existsSync(join(result.backupDir, "keybindings.json")), true);
		assert.deepEqual(readKeybindingConfig(context.configPath), {
			"tui.editor.historyPrevious": "ctrl+p",
			"app.message.followUp": "ctrl+enter",
			"app.message.dequeue": "ctrl+up",
		});
		const state = JSON.parse(readFileSync(keybindingStatePath(context.paths), "utf8"));
		assert.equal(state.createdConfig, false);
		assert.equal(state.updatedAt, "2026-08-20T12:00:00.000Z");
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("user overrides and competing editor actions conflict before any write", () => {
	for (const config of [
		{ "app.message.followUp": "alt+enter" },
		{ "app.model.select": "ctrl+enter" },
		{ "tui.editor.historyPrevious": "ctrl+up" },
	]) {
		const context = fixture();
		try {
			writeConfig(context, config);
			const before = readFileSync(context.configPath);
			const plan = planKeybindings(context.paths);
			assert.equal(
				plan.actions.some((action) => action.type === "conflict"),
				true,
			);
			assert.throws(() => applyKeybindings(context.paths), KeybindingConflictError);
			assert.deepEqual(readFileSync(context.configPath), before);
			assert.equal(existsSync(keybindingStatePath(context.paths)), false);
		} finally {
			rmSync(context.root, { recursive: true, force: true });
		}
	}
});

test("reset removes only Jouzu-inserted entries, retains user entries, and disables reseeding", () => {
	const context = fixture();
	try {
		writeConfig(context, { "tui.editor.cursorWordLeft": "alt+b" });
		applyKeybindings(context.paths);
		const result = resetKeybindings(context.paths, new Date("2026-08-20T13:00:00.000Z"));
		assert.equal(result.changed, true);
		assert.deepEqual(readKeybindingConfig(context.configPath), { "tui.editor.cursorWordLeft": "alt+b" });
		const state = JSON.parse(readFileSync(keybindingStatePath(context.paths), "utf8"));
		assert.equal(state.policy, "disabled");
		assert.deepEqual(state.insertedBindings, []);
		assert.deepEqual(ensureDefaultKeybindings(context.paths, {}), { changed: false });
		const plan = planKeybindings(context.paths);
		assert.equal(plan.status, "customized");
		assert.equal(plan.policy, "disabled");
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("reset refuses to remove a Jouzu-seeded binding after the user changes it", () => {
	const context = fixture();
	try {
		ensureDefaultKeybindings(context.paths, {});
		writeConfig(context, { "app.message.followUp": "ctrl+f", "app.message.dequeue": "ctrl+up" });
		const before = readFileSync(context.configPath);
		assert.throws(() => resetKeybindings(context.paths), KeybindingConflictError);
		assert.deepEqual(readFileSync(context.configPath), before);
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("resetting a Jouzu-created file removes it but leaves a durable opt-out", () => {
	const context = fixture();
	try {
		ensureDefaultKeybindings(context.paths, {});
		resetKeybindings(context.paths);
		assert.equal(existsSync(context.configPath), false);
		const plan = planKeybindings(context.paths);
		assert.equal(plan.status, "uninitialized");
		assert.equal(plan.policy, "disabled");
		assert.deepEqual(ensureDefaultKeybindings(context.paths, {}), { changed: false });
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});

test("malformed and symlink configs fail closed without touching their targets", () => {
	const malformed = fixture();
	try {
		writeConfig(malformed, { "app.message.followUp": 42 });
		assert.throws(() => planKeybindings(malformed.paths), /must be a key or array/);
		assert.match(ensureDefaultKeybindings(malformed.paths, {}).message, /must be a key or array/);
	} finally {
		rmSync(malformed.root, { recursive: true, force: true });
	}

	if (process.platform !== "win32") {
		const linked = fixture();
		try {
			mkdirSync(linked.paths.agentDir, { recursive: true });
			const target = join(linked.root, "user-owned.json");
			writeFileSync(target, '{"sentinel":true}\n');
			symlinkSync(target, linked.configPath);
			assert.throws(() => planKeybindings(linked.paths), /regular file/);
			assert.equal(readFileSync(target, "utf8"), '{"sentinel":true}\n');
		} finally {
			rmSync(linked.root, { recursive: true, force: true });
		}
	}
});

test("one-run opt-out and an active operation lock prevent mutation", () => {
	const context = fixture();
	try {
		assert.deepEqual(ensureDefaultKeybindings(context.paths, { JOUZU_NO_KEYBINDING_DEFAULTS: "1" }), {
			changed: false,
		});
		assert.equal(existsSync(context.configPath), false);
		mkdirSync(context.paths.stateDir, { recursive: true });
		const lock = join(context.paths.stateDir, "keybindings.lock");
		writeFileSync(lock, "owned elsewhere\n");
		assert.throws(() => applyKeybindings(context.paths), /another keybinding operation/);
		assert.equal(readFileSync(lock, "utf8"), "owned elsewhere\n");
		assert.equal(existsSync(context.configPath), false);
	} finally {
		rmSync(context.root, { recursive: true, force: true });
	}
});
