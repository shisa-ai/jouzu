import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CatalogSourceStore, setCatalogSourceToken } from "../../dist/catalog-sources.js";
import { runMainCli } from "../../dist/main-cli.js";
import { MODEL_CATALOG_MEDIA_TYPE } from "../../dist/model-catalog.js";
import { getCatalogStatuses, loadActiveModelCatalogs, refreshModelCatalog } from "../../dist/model-catalog-sync.js";
import { resolveJouzuPaths } from "../../dist/paths.js";
import { configurePiProcess } from "../../dist/runtime.js";

const scenario = JSON.parse(process.argv[2]);
const paths = resolveJouzuPaths();
const document = JSON.parse(
	readFileSync(new URL("../../catalog/fixtures/account-snapshot-v1.json", import.meta.url), "utf8"),
);
const response = (body = document) =>
	new Response(JSON.stringify(body), { headers: { "content-type": MODEL_CATALOG_MEDIA_TYPE } });
for (const path of [paths.agentDir, paths.stateDir]) mkdirSync(path, { recursive: true, mode: 0o700 });
// These tests concern an existing installation, not first-run onboarding/import prompts.
writeFileSync(join(paths.stateDir, "shisa-onboarding.json"), "{}");
writeFileSync(
	join(paths.stateDir, "pi-import.json"),
	JSON.stringify({
		schemaVersion: 1,
		models: { status: "declined" },
		auth: { status: "declined" },
		decidedAt: new Date().toISOString(),
	}),
);
if (scenario.credential === "login") {
	writeFileSync(
		join(paths.agentDir, "auth.json"),
		JSON.stringify({
			shisa: { type: "oauth", access: "saved-login-key", refresh: "", expires: Number.MAX_SAFE_INTEGER },
		}),
		{ mode: 0o600 },
	);
} else if (scenario.credential === "token") {
	setCatalogSourceToken(paths, "shisa-api", "saved-catalog-key");
} else if (scenario.credential === "env") {
	process.env.SHISA_API_KEY = "environment-key";
}
if (scenario.cache) {
	const seeded = await refreshModelCatalog(paths, {
		fetch: async () => response(),
		now: new Date("2020-01-01T00:00:00Z"),
	});
	assert.equal(seeded.status, "activated");
} else {
	assert.deepEqual(loadActiveModelCatalogs(paths), []);
}
if (scenario.disabled) new CatalogSourceStore(paths).setEnabled("shisa-api", false);
if (scenario.local) {
	writeFileSync(
		join(paths.agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"local-fixture": {
					api: "openai-completions",
					baseUrl: "http://127.0.0.1:1/v1",
					apiKey: "local-key",
					models: [{ id: "local-model", name: "Local Model", contextWindow: 4096, maxTokens: 1024 }],
				},
			},
		}),
	);
}

const requests = [];
const catalogTimeouts = [];
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
	if (ms === 30_000) {
		catalogTimeouts.push(ms);
		// Exercise the actual catalog abort path without making the suite wait 30 seconds.
		if (scenario.refresh === "timeout") ms = 20;
	}
	return originalSetTimeout(callback, ms, ...args);
};
let refreshSettled = false;
globalThis.fetch = async (url, init) => {
	assert.equal(String(url), "https://api.shisa.ai/v1/jouzu/model-catalog", "no unrelated network requests");
	requests.push({ url: String(url), authorization: new Headers(init.headers).get("authorization") });
	try {
		await delay(scenario.refresh === "timeout" ? 60_000 : 2_000, undefined, { signal: init.signal });
		if (scenario.refresh === "network") throw new TypeError("fetch failed");
		if (scenario.refresh === "invalid") return response({ invalid: true });
		const updated = structuredClone(document);
		updated.revision = "fixture-2";
		updated.sequence = "2";
		updated.modelOfferings[0].name = "Refreshed Model";
		return response(updated);
	} finally {
		refreshSettled = true;
	}
};

// Run the real launcher and Pi initial-model resolver. Replace only the terminal
// loop: inspect the first runtime before session_start can change the selection.
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
configurePiProcess(paths);
const { InteractiveMode } = await import("@earendil-works/pi-coding-agent");
let observed;
InteractiveMode.prototype.run = async function () {
	const model = this.session.model;
	const runtime = this.runtimeHost.services.modelRuntime;
	observed = {
		model,
		apiKey: model && model.provider !== "unknown" ? (await runtime.prepareRequest(model)).options.apiKey : undefined,
		requests: [...requests],
		catalogTimeouts: [...catalogTimeouts],
		refreshSettled,
		catalog: getCatalogStatuses(paths),
	};
	await this.runtimeHost.dispose();
};
await runMainCli(["--no-session", "--no-context-files", "--no-extensions", "--no-skills"]);
assert.ok(observed, "Pi entered its first interactive runtime");
writeFileSync(join(paths.configDir, "observed.json"), JSON.stringify(observed));
// The real terminal loop normally owns process lifetime; no terminal was started here.
process.exit(0);
