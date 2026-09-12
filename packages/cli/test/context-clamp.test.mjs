import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	activeContextClamp,
	clampContextWindow,
	clampModelContextWindow,
	contextPolicyPath,
	CONTEXT_CLAMP_CHOICES,
	formatContextClamp,
	loadContextPolicy,
	modelsExceedContextClamp,
	stepContextClamp,
	writeContextPolicy,
} from "../dist/context-clamp.js";
import { resolveJouzuPaths } from "../dist/paths.js";

function setup() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-context-clamp-"));
	const paths = resolveJouzuPaths({ homeOverride: join(root, "jouzu") });
	mkdirSync(paths.configDir, { recursive: true });
	return { root, paths };
}

test("a stored clamp round-trips and turning it off removes the file", () => {
	const { root, paths } = setup();
	try {
		assert.deepEqual(loadContextPolicy(paths), {});
		assert.equal(activeContextClamp(paths), undefined);

		writeContextPolicy(paths, 384_000);
		assert.equal(activeContextClamp(paths), 384_000);
		assert.deepEqual(loadContextPolicy(paths), { maxContextTokens: 384_000 });
		assert.deepEqual(JSON.parse(readFileSync(contextPolicyPath(paths), "utf8")), {
			schemaVersion: 1,
			maxContextTokens: 384_000,
		});

		writeContextPolicy(paths, 512_000);
		assert.equal(activeContextClamp(paths), 512_000);

		writeContextPolicy(paths, undefined);
		assert.equal(existsSync(contextPolicyPath(paths)), false);
		assert.equal(activeContextClamp(paths), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a rejected policy reports an error and leaves the clamp off", () => {
	const { root, paths } = setup();
	try {
		const path = contextPolicyPath(paths);
		for (const [name, contents] of [
			["unknown key", '{"schemaVersion":1,"maxContextTokens":384000,"extra":true}'],
			["wrong schema", '{"schemaVersion":2,"maxContextTokens":384000}'],
			["fractional tokens", '{"schemaVersion":1,"maxContextTokens":384000.5}'],
			["below the floor", '{"schemaVersion":1,"maxContextTokens":12}'],
			["not an object", "[]"],
			["broken json", "{"],
		]) {
			writeFileSync(path, contents);
			const loaded = loadContextPolicy(paths);
			assert.ok(loaded.error, `${name} is rejected`);
			assert.equal(loaded.maxContextTokens, undefined, `${name} leaves the clamp off`);
			assert.equal(activeContextClamp(paths), undefined);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a symlinked policy is rejected without following it", () => {
	const { root, paths } = setup();
	try {
		const target = join(root, "target.json");
		writeFileSync(target, '{"schemaVersion":1,"maxContextTokens":384000}');
		symlinkSync(target, contextPolicyPath(paths));
		const loaded = loadContextPolicy(paths);
		assert.match(loaded.error ?? "", /regular file/u);
		assert.equal(loaded.maxContextTokens, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the preset ladder steps between ceilings and off", () => {
	assert.equal(stepContextClamp(undefined, -1), undefined);
	assert.equal(stepContextClamp(undefined, 1), CONTEXT_CLAMP_CHOICES[0]);
	assert.equal(stepContextClamp(128_000, -1), undefined);
	assert.equal(stepContextClamp(384_000, 1), 512_000);
	assert.equal(stepContextClamp(384_000, -1), 256_000);
	assert.equal(stepContextClamp(1_000_000, 1), undefined);
	// A hand-edited value that is not on the ladder steps to the next preset.
	assert.equal(stepContextClamp(393_216, 1), 512_000);
	assert.equal(stepContextClamp(393_216, -1), 384_000);
});

test("ceiling labels render as round token counts", () => {
	assert.equal(formatContextClamp(undefined), "Off");
	assert.equal(formatContextClamp(128_000), "128K");
	assert.equal(formatContextClamp(384_000), "384K");
	assert.equal(formatContextClamp(393_216), "393K");
	assert.equal(formatContextClamp(1_000_000), "1M");
});

test("clamping composes through min and ignores models already below the ceiling", () => {
	assert.equal(clampContextWindow(1_000_000, 384_000), 384_000);
	assert.equal(clampContextWindow(200_000, 384_000), 200_000);
	assert.equal(clampContextWindow(1_000_000, undefined), 1_000_000);
	assert.equal(clampContextWindow(undefined, 384_000), undefined);

	const model = { id: "big", contextWindow: 1_000_000 };
	assert.deepEqual(clampModelContextWindow(model, 384_000), { id: "big", contextWindow: 384_000 });
	assert.equal(clampModelContextWindow(model, 2_000_000), model, "an untouched model keeps its identity");
	assert.equal(clampModelContextWindow(model, undefined), model);

	assert.equal(modelsExceedContextClamp([{ contextWindow: 1_000_000 }], 384_000), true);
	assert.equal(modelsExceedContextClamp([{ contextWindow: 384_000 }], 384_000), false);
	assert.equal(modelsExceedContextClamp([{ contextWindow: 1_000_000 }], undefined), false);
});
