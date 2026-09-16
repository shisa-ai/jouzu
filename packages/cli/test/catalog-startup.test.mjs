import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { catalogRuntimeProvider } from "../dist/model-catalog-projection.js";

const provider = catalogRuntimeProvider(
	"ai.example.test",
	"ai.example.gateway",
	"https://api.shisa.ai/v1/jouzu/model-catalog",
);

function startup(scenario) {
	const root = mkdtempSync(join(tmpdir(), "jouzu-catalog-startup-"));
	try {
		const home = join(root, "jouzu");
		const result = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("./fixtures/catalog-startup.mjs", import.meta.url)), JSON.stringify(scenario)],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH,
					SystemRoot: process.env.SystemRoot,
					TEMP: process.env.TEMP,
					TMP: process.env.TMP,
					HOME: root,
					USERPROFILE: root,
					TERM: "xterm-256color",
					JOUZU_HOME: home,
					JOUZU_PROFILE: "core",
					JOUZU_NO_UPDATE: "1",
					JOUZU_FLOW_CONTROL: "0",
					PI_OFFLINE: "1",
				},
				encoding: "utf8",
				// Allow the real 15-second catalog abort plus runtime startup overhead.
				timeout: 35_000,
			},
		);
		assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
		return JSON.parse(readFileSync(join(home, "observed.json"), "utf8"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

for (const [credential, key] of [
	["login", "saved-login-key"],
	["token", "saved-catalog-key"],
	["env", "environment-key"],
]) {
	test(`empty catalog + ${credential}: delayed refresh participates in Pi's initial model selection`, () => {
		const result = startup({ credential, refresh: "success" });
		assert.equal(result.refreshSettled, true, "startup waits for the delayed catalog response");
		assert.equal(result.model?.provider, provider);
		assert.equal(result.model?.id, "example-model");
		assert.equal(result.model?.name, "Refreshed Model");
		assert.equal(result.apiKey, key, "the initial model can prepare an authenticated request");
		assert.deepEqual(
			result.requests.map((request) => request.authorization),
			[`Bearer ${key}`],
		);
		assert.equal(result.startupTimeoutMs, 15_000, "startup has a 15-second catalog budget");
		assert.equal(result.catalogAbortAfterMs, null);
	});
}

test("stale catalog: refreshed metadata is used by initial model resolution", () => {
	const result = startup({ credential: "login", cache: true, refresh: "success" });
	assert.equal(result.refreshSettled, true);
	assert.equal(result.model?.provider, provider);
	assert.equal(result.model?.name, "Refreshed Model");
	assert.equal(result.apiKey, "saved-login-key");
});

for (const scenario of [{}, { credential: "login", disabled: true }]) {
	test(`${scenario.disabled ? "disabled source" : "missing credential"}: no startup network wait`, () => {
		const result = startup({ ...scenario, local: true });
		assert.deepEqual(result.requests, []);
		assert.equal(result.catalogAbortAfterMs, null);
		assert.equal(result.model?.provider, "local-fixture");
		assert.equal(result.apiKey, "local-key");
	});
}

for (const refresh of ["network", "invalid", "timeout"]) {
	test(`${refresh} refresh failure preserves the cached model and status diagnostic at startup`, () => {
		const result = startup({ credential: "login", cache: true, refresh });
		assert.equal(result.refreshSettled, true);
		assert.equal(result.requests.length, 1);
		assert.equal(result.model?.provider, provider);
		assert.equal(result.model?.name, "Example Model");
		assert.equal(result.apiKey, "saved-login-key");
		assert.ok(result.catalog.sources[0].lastError, "refresh failure remains diagnosable");
		assert.equal(result.startupTimeoutMs, 15_000, "startup has a 15-second catalog budget");
		if (refresh === "timeout") {
			assert.equal(result.catalog.sources[0].lastError.code, "timeout");
			assert.ok(
				result.catalogAbortAfterMs >= 14_900 && result.catalogAbortAfterMs < 20_000,
				`the catalog signal must abort after 15 seconds (observed ${result.catalogAbortAfterMs} ms)`,
			);
		} else {
			assert.equal(result.catalogAbortAfterMs, null);
		}
	});
}

test("failed refresh without a cached catalog still starts with a local model", () => {
	const result = startup({ credential: "login", local: true, refresh: "network" });
	assert.equal(result.refreshSettled, true);
	assert.equal(result.model?.provider, "local-fixture");
	assert.equal(result.apiKey, "local-key");
	assert.ok(result.catalog.sources[0].lastError);
});
