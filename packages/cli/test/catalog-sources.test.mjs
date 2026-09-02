import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	CatalogSourceError,
	CatalogSourceStore,
	catalogEndpointCandidates,
	catalogSourceConflict,
	discoverCatalogEndpoint,
	loadCatalogSourceRegistry,
	resolveCatalogBearer,
	resolveCatalogSources,
} from "../dist/catalog-sources.js";
import { resolveJouzuPaths } from "../dist/paths.js";

const fixture = JSON.parse(
	readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
);

function setup() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-catalog-sources-"));
	const paths = resolveJouzuPaths({ homeOverride: join(root, "jouzu") });
	return { root, paths, registryPath: join(paths.configDir, "catalogs.json") };
}

function response(
	document = fixture,
	status = 200,
	contentType = "application/vnd.jouzu.model-catalog+json; version=1",
) {
	return new Response(status === 204 ? null : JSON.stringify(document), {
		status,
		headers: { "Content-Type": contentType },
	});
}

test("catalog source store persists labels and credential references without bearer values", () => {
	const { root, paths, registryPath } = setup();
	try {
		const store = new CatalogSourceStore(paths, { env: { SHISA_CATALOG_TOKEN: "must-not-be-written" } });
		const source = store.add({
			label: "Office pool 上手",
			url: "http://127.0.0.1:8989/v1/jouzu/model-catalog",
			auth: { type: "bearer", credentialRef: "env:SHISA_CATALOG_TOKEN" },
		});
		assert.equal(source.id, "office-pool");
		assert.equal(source.label, "Office pool 上手");
		assert.equal(source.enabled, true);
		assert.equal(loadCatalogSourceRegistry(paths).sources[0].label, "Office pool 上手");
		const bytes = readFileSync(registryPath, "utf8");
		assert.doesNotMatch(bytes, /must-not-be-written/u);
		assert.equal(JSON.parse(bytes).schemaVersion, 1);

		assert.equal(store.setEnabled(source.id, false).enabled, false);
		assert.deepEqual(
			resolveCatalogSources(paths, {}).map((candidate) => candidate.id),
			["shisa-api"],
		);
		assert.equal(store.setEnabled(source.id, true).enabled, true);
		assert.equal(store.remove(source.id).id, source.id);
		assert.deepEqual(loadCatalogSourceRegistry(paths).sources, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("single-source environment setup migrates only when no registry exists", () => {
	const { root, paths } = setup();
	try {
		const env = {
			JOUZU_MODEL_CATALOG_URL: "https://catalog.example/v1/jouzu/model-catalog",
			JOUZU_MODEL_CATALOG_TOKEN: "secret",
		};
		const migrated = resolveCatalogSources(paths, env, { includeDisabled: true });
		assert.deepEqual(
			migrated.map((source) => source.id),
			["shisa-api", "default"],
		);
		assert.deepEqual(migrated[1], {
			id: "default",
			label: "Environment catalog",
			url: "https://catalog.example/v1/jouzu/model-catalog",
			enabled: true,
			auth: { type: "bearer", credentialRef: "env:JOUZU_MODEL_CATALOG_TOKEN" },
		});

		new CatalogSourceStore(paths, { env }).add({
			label: "Community",
			url: "https://community.example/v1/jouzu/model-catalog",
			auth: { type: "none" },
		});
		assert.deepEqual(
			resolveCatalogSources(paths, env, { includeDisabled: true }).map((source) => source.id),
			["shisa-api", "default", "community"],
		);
		// The code-owned built-in is never materialized into the user registry.
		assert.deepEqual(
			loadCatalogSourceRegistry(paths).sources.map((source) => source.id),
			["default", "community"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("built-in Shisa API source resolves without a registry and never stores the key", () => {
	const { root, paths, registryPath } = setup();
	try {
		const resolved = resolveCatalogSources(paths, {});
		assert.deepEqual(resolved, [
			{
				id: "shisa-api",
				label: "Shisa API",
				url: "https://api.shisa.ai/v1/jouzu/model-catalog",
				enabled: true,
				auth: { type: "bearer", credentialRef: "env:SHISA_API_KEY" },
			},
		]);
		// Resolution is pure: no registry or overrides file is written.
		assert.equal(existsSync(registryPath), false);
		assert.equal(existsSync(join(paths.configDir, "catalog-overrides.json")), false);
		// A missing key fails before any request can be constructed.
		assert.throws(() => resolveCatalogBearer(resolved[0], {}), /SHISA_API_KEY is not set/u);
		assert.equal(resolveCatalogBearer(resolved[0], { SHISA_API_KEY: "sk-test" }), "sk-test");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a matching manual registration supersedes the built-in descriptor", () => {
	const { root, paths } = setup();
	try {
		const store = new CatalogSourceStore(paths, { env: {} });
		const manual = store.add({
			id: "shisa",
			label: "My Shisa",
			url: "https://api.shisa.ai/v1/jouzu/model-catalog",
			auth: { type: "bearer", credentialRef: "env:SHISA_API_KEY" },
		});
		store.setEnabled(manual.id, false);
		const resolved = resolveCatalogSources(paths, {}, { includeDisabled: true });
		assert.deepEqual(
			resolved.map((source) => source.id),
			["shisa"],
		);
		assert.equal(resolved[0].label, "My Shisa");
		assert.equal(resolved[0].enabled, false);
		assert.equal(catalogSourceConflict(resolved[0]), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a conflicting registry entry claims the reserved id and blocks the built-in source", () => {
	const { root, paths, registryPath } = setup();
	try {
		// The store suffixes colliding adds, so a conflict only arrives through a
		// hand-edited registry file.
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(
			registryPath,
			`${JSON.stringify({
				schemaVersion: 1,
				sources: [
					{
						id: "shisa-api",
						label: "Elsewhere",
						url: "https://catalog.example/v1/jouzu/model-catalog",
						enabled: true,
						auth: { type: "none" },
					},
				],
			})}\n`,
		);
		const resolved = resolveCatalogSources(paths, {}, { includeDisabled: true });
		assert.deepEqual(
			resolved.map((source) => source.id),
			["shisa-api"],
		);
		assert.equal(resolved[0].url, "https://catalog.example/v1/jouzu/model-catalog");
		assert.match(catalogSourceConflict(resolved[0]) ?? "", /reserved for the built-in Shisa API catalog/u);
		assert.equal(catalogSourceConflict(resolved[0])?.includes("catalog.example"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("disabling the code-owned built-in writes only an override and re-enabling removes it", () => {
	const { root, paths, registryPath } = setup();
	try {
		const overridesPath = join(paths.configDir, "catalog-overrides.json");
		const store = new CatalogSourceStore(paths, { env: {} });
		const builtin = store.list().find((source) => source.id === "shisa-api");
		assert.equal(store.isCodeOwned(builtin), true);

		const disabled = store.setEnabled("shisa-api", false);
		assert.equal(disabled.enabled, false);
		assert.equal(existsSync(registryPath), false);
		const bytes = readFileSync(overridesPath, "utf8");
		assert.deepEqual(JSON.parse(bytes), { schemaVersion: 1, overrides: { "shisa-api": { enabled: false } } });
		assert.doesNotMatch(bytes, /SHISA_API_KEY|sk-/u);
		assert.equal(
			resolveCatalogSources(paths, {}).some((source) => source.id === "shisa-api"),
			false,
		);
		assert.equal(resolveCatalogSources(paths, {}, { includeDisabled: true })[0].enabled, false);

		store.setEnabled("shisa-api", true);
		assert.equal(existsSync(overridesPath), false);
		assert.equal(resolveCatalogSources(paths, {})[0].id, "shisa-api");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the code-owned built-in cannot be edited or removed", () => {
	const { root, paths } = setup();
	try {
		const store = new CatalogSourceStore(paths, { env: {} });
		assert.throws(
			() => store.update("shisa-api", { label: "x", url: "https://example.test/catalog", auth: { type: "none" } }),
			/can only be enabled or disabled/u,
		);
		assert.throws(() => store.remove("shisa-api"), /can only be enabled or disabled/u);
		// A label colliding with the reserved id gets a suffixed id instead.
		const added = store.add({
			label: "Shisa API",
			url: "https://community.example/v1/jouzu/model-catalog",
			auth: { type: "none" },
		});
		assert.equal(added.id, "shisa-api-2");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("catalog overrides reject unsafe files", () => {
	const { root, paths } = setup();
	try {
		const overridesPath = join(paths.configDir, "catalog-overrides.json");
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(overridesPath, '{"schemaVersion":1,"overrides":[]}');
		assert.throws(() => resolveCatalogSources(paths, {}), /overrides object/u);
		writeFileSync(overridesPath, '{"schemaVersion":1,"overrides":{"shisa-api":{"enabled":"no"}}}');
		assert.throws(() => resolveCatalogSources(paths, {}), /enabled must be boolean/u);
		writeFileSync(overridesPath, '{"schemaVersion":1,"overrides":{"shisa-api":{"url":"https://x.test"}}}');
		assert.throws(() => resolveCatalogSources(paths, {}), /unknown field/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("endpoint candidates preserve exact URLs and complete host or partial v1 inputs", () => {
	assert.deepEqual(catalogEndpointCandidates("http://127.0.0.1:8989"), [
		"http://127.0.0.1:8989/",
		"http://127.0.0.1:8989/v1/jouzu/model-catalog",
	]);
	assert.deepEqual(catalogEndpointCandidates("127.0.0.1:8989/v1"), [
		"http://127.0.0.1:8989/v1",
		"http://127.0.0.1:8989/v1/jouzu/model-catalog",
	]);
	assert.deepEqual(catalogEndpointCandidates("catalog.example/custom"), [
		"https://catalog.example/custom",
		"https://catalog.example/custom/v1/jouzu/model-catalog",
	]);
	assert.deepEqual(catalogEndpointCandidates("https://catalog.example/exact.json"), [
		"https://catalog.example/exact.json",
		"https://catalog.example/exact.json/v1/jouzu/model-catalog",
	]);
});

test("endpoint discovery tries exact then conventional path with source-scoped bearer auth", async () => {
	const calls = [];
	const result = await discoverCatalogEndpoint("127.0.0.1:8989", {
		auth: { type: "bearer", credentialRef: "env:POOL_TOKEN" },
		env: { POOL_TOKEN: "fixture-token" },
		fetch: async (url, init) => {
			calls.push({ url: String(url), headers: new Headers(init.headers), redirect: init.redirect });
			return calls.length === 1 ? response({}, 200, "text/html") : response();
		},
	});
	assert.equal(result.url, "http://127.0.0.1:8989/v1/jouzu/model-catalog");
	assert.equal(result.document.catalogId, fixture.catalogId);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].headers.get("authorization"), "Bearer fixture-token");
	assert.equal(calls[1].redirect, "error");
});

test("endpoint discovery explains missing and rejected bearer credentials", async () => {
	await assert.rejects(
		discoverCatalogEndpoint("127.0.0.1:8989", {
			auth: { type: "bearer", credentialRef: "env:POOL_TOKEN" },
			env: {},
			fetch: async () => response({}, 401),
		}),
		(error) => {
			assert.match(error.message, /POOL_TOKEN is not set in this Jouzu process/u);
			assert.match(error.message, /Export it before starting Jouzu/u);
			return true;
		},
	);

	await assert.rejects(
		discoverCatalogEndpoint("127.0.0.1:8989", {
			auth: { type: "bearer", credentialRef: "env:POOL_TOKEN" },
			env: { POOL_TOKEN: "rejected-token" },
			fetch: async () => response({}, 401),
		}),
		(error) => {
			assert.match(error.message, /Catalog authentication failed \(HTTP 401\)/u);
			assert.match(error.message, /POOL_TOKEN/u);
			assert.doesNotMatch(error.message, /rejected-token/u);
			return true;
		},
	);
});

test("catalog registry rejects unsafe files, labels, sources, and credential references", () => {
	const { root, paths, registryPath } = setup();
	try {
		mkdirSync(paths.configDir, { recursive: true });
		writeFileSync(registryPath, '{"schemaVersion":1,"sources":[],"sources":[]}');
		assert.throws(() => loadCatalogSourceRegistry(paths), /duplicate object key/u);
		writeFileSync(registryPath, '{"schemaVersion":1,"sources":[]}');
		const target = join(root, "target.json");
		writeFileSync(target, '{"schemaVersion":1,"sources":[]}');
		rmSync(registryPath);
		symlinkSync(target, registryPath);
		assert.throws(() => loadCatalogSourceRegistry(paths), /regular file/u);
		rmSync(registryPath);

		const store = new CatalogSourceStore(paths);
		assert.throws(
			() => store.add({ label: "bad\u001b", url: "https://example.test/catalog", auth: { type: "none" } }),
			CatalogSourceError,
		);
		assert.throws(
			() =>
				store.add({
					label: "Bad auth",
					url: "https://example.test/catalog",
					auth: { type: "bearer", credentialRef: "literal-secret" },
				}),
			/environment credential reference/u,
		);
		assert.throws(
			() => store.add({ label: "Cleartext", url: "http://example.test/catalog", auth: { type: "none" } }),
			/HTTPS/u,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
