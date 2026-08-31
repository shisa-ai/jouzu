import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	CatalogSourceError,
	CatalogSourceStore,
	catalogEndpointCandidates,
	discoverCatalogEndpoint,
	loadCatalogSourceRegistry,
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
		assert.equal(resolveCatalogSources(paths, {}).length, 0);
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
		assert.equal(migrated.length, 1);
		assert.deepEqual(migrated[0], {
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
			["default", "community"],
		);
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
