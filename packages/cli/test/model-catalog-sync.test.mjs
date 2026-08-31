import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CatalogSourceStore } from "../dist/catalog-sources.js";
import { MODEL_CATALOG_MAX_BYTES } from "../dist/model-catalog.js";
import {
	acceptQuarantinedCatalog,
	getCatalogStatuses,
	loadActiveModelCatalog,
	loadActiveModelCatalogs,
	refreshAllModelCatalogs,
	refreshModelCatalog,
	resolveCatalogEndpoint,
} from "../dist/model-catalog-sync.js";
import { resolveJouzuPaths } from "../dist/paths.js";

const fixture = JSON.parse(
	readFileSync(join(import.meta.dirname, "..", "catalog", "fixtures", "account-snapshot-v1.json"), "utf8"),
);

function paths(temporary) {
	return resolveJouzuPaths({ homeOverride: join(temporary, "jouzu"), cwd: "/" });
}

function env(url = "https://catalog.example.test/v1/jouzu/model-catalog") {
	return { JOUZU_MODEL_CATALOG_URL: url, JOUZU_MODEL_CATALOG_TOKEN: "fixture-token" };
}

function response(document, status = 200, headers = {}) {
	return new Response(status === 304 ? null : JSON.stringify(document), {
		status,
		headers: {
			...(status === 304 ? {} : { "Content-Type": "application/vnd.jouzu.model-catalog+json; version=1" }),
			ETag: `"fixture-${document?.sequence ?? 1}"`,
			...headers,
		},
	});
}

function snapshot(sequence, models = fixture.modelOfferings) {
	const document = structuredClone(fixture);
	document.sequence = String(sequence);
	document.revision = `fixture-${sequence}`;
	document.generatedAt = `2026-08-${String(20 + sequence).padStart(2, "0")}T00:00:00Z`;
	document.modelOfferings = structuredClone(models);
	return document;
}

test("missing endpoint performs no fetch and is a successful unconfigured state", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-unconfigured-"));
	try {
		let calls = 0;
		const result = await refreshModelCatalog(paths(temporary), {
			env: {},
			fetch: async () => {
				calls += 1;
				throw new Error("must not fetch");
			},
		});
		assert.equal(result.status, "unconfigured");
		assert.equal(result.catalogStatus.status, "unconfigured");
		assert.equal(calls, 0);
		assert.equal(loadActiveModelCatalog(paths(temporary), {}), undefined);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("configured refresh activates once and validates unchanged bytes with ETag", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-refresh-"));
	try {
		const jouzuPaths = paths(temporary);
		const requestHeaders = [];
		let call = 0;
		const fetch = async (_url, init) => {
			requestHeaders.push(new Headers(init.headers));
			call += 1;
			return call === 1 ? response(snapshot(1)) : response(undefined, 304, { ETag: '"fixture-1"' });
		};
		const first = await refreshModelCatalog(jouzuPaths, { env: env(), fetch, now: new Date("2026-08-26T01:00:00Z") });
		assert.equal(first.status, "activated");
		assert.equal(first.catalogStatus.status, "active");
		assert.equal(requestHeaders[0].get("authorization"), "Bearer fixture-token");
		assert.equal(requestHeaders[0].get("if-none-match"), null);
		assert.equal(loadActiveModelCatalog(jouzuPaths, env()).revision, "fixture-1");

		const second = await refreshModelCatalog(jouzuPaths, { env: env(), fetch, now: new Date("2026-08-26T02:00:00Z") });
		assert.equal(second.status, "not-modified");
		assert.equal(requestHeaders[1].get("if-none-match"), '"fixture-1"');
		assert.equal(second.catalogStatus.validatedAt, "2026-08-26T02:00:00.000Z");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("multiple sources refresh independently with optional authentication and aggregate status", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-multiple-"));
	try {
		const jouzuPaths = paths(temporary);
		const store = new CatalogSourceStore(jouzuPaths, { env: { PRIVATE_TOKEN: "fixture-token" } });
		store.add({
			label: "Public models",
			url: "https://public.example/v1/jouzu/model-catalog",
			auth: { type: "none" },
		});
		store.add({
			label: "Private pool",
			url: "https://private.example/v1/jouzu/model-catalog",
			auth: { type: "bearer", credentialRef: "env:PRIVATE_TOKEN" },
		});
		const headers = new Map();
		const fetch = async (url, init) => {
			headers.set(String(url), new Headers(init.headers));
			const document = snapshot(1);
			if (String(url).includes("public")) {
				document.catalogId = "org.example.public";
				document.scope.accountScoped = false;
				delete document.scope.accountRef;
			} else {
				document.catalogId = "org.example.private";
				document.scope.accountRef = "acct_private";
			}
			return response(document);
		};
		const refreshed = await refreshAllModelCatalogs(jouzuPaths, {
			env: { PRIVATE_TOKEN: "fixture-token" },
			fetch,
			now: new Date("2026-08-28T01:00:00Z"),
		});
		assert.equal(refreshed.status, "complete");
		assert.deepEqual(
			refreshed.results.map((result) => result.source.label),
			["Public models", "Private pool"],
		);
		assert.equal(headers.get("https://public.example/v1/jouzu/model-catalog").get("authorization"), null);
		assert.equal(
			headers.get("https://private.example/v1/jouzu/model-catalog").get("authorization"),
			"Bearer fixture-token",
		);
		const active = loadActiveModelCatalogs(jouzuPaths, { PRIVATE_TOKEN: "fixture-token" });
		assert.deepEqual(
			active.map(({ source, document }) => [source.label, document.catalogId]),
			[
				["Public models", "org.example.public"],
				["Private pool", "org.example.private"],
			],
		);
		const status = getCatalogStatuses(jouzuPaths, { PRIVATE_TOKEN: "fixture-token" });
		assert.equal(status.status, "active");
		assert.equal(status.active, 2);
		assert.deepEqual(
			status.sources.map((source) => source.offeringCount),
			[fixture.modelOfferings.length, fixture.modelOfferings.length],
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("all-source refresh activates healthy sources while reporting partial failure", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-partial-"));
	try {
		const jouzuPaths = paths(temporary);
		const store = new CatalogSourceStore(jouzuPaths);
		store.add({ label: "Healthy", url: "https://healthy.example/catalog", auth: { type: "none" } });
		store.add({ label: "Offline", url: "https://offline.example/catalog", auth: { type: "none" } });
		const result = await refreshAllModelCatalogs(jouzuPaths, {
			env: {},
			fetch: async (url) => {
				if (String(url).includes("offline")) throw new Error("offline");
				const document = snapshot(1);
				document.catalogId = "org.example.healthy";
				document.scope.accountScoped = false;
				delete document.scope.accountRef;
				return response(document);
			},
		});
		assert.equal(result.status, "partial");
		assert.deepEqual(
			result.results.map((entry) => entry.result.status),
			["activated", "error"],
		);
		assert.equal(loadActiveModelCatalogs(jouzuPaths, {}).length, 1);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("streaming refresh cancels an understated response above the byte limit", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-bounded-stream-"));
	try {
		let cancelled = false;
		let pull = 0;
		const body = new ReadableStream({
			pull(controller) {
				if (pull < 2) controller.enqueue(new Uint8Array(MODEL_CATALOG_MAX_BYTES / 2));
				else controller.enqueue(Uint8Array.of(1));
				pull += 1;
			},
			cancel() {
				cancelled = true;
			},
		});
		const result = await refreshModelCatalog(paths(temporary), {
			env: env(),
			fetch: async () =>
				new Response(body, {
					status: 200,
					headers: {
						"Content-Type": "application/vnd.jouzu.model-catalog+json; version=1",
						"Content-Length": "1",
					},
				}),
		});
		assert.equal(result.status, "rejected");
		assert.equal(result.code, "catalog_sync_error");
		assert.match(result.message, /exceeds 16 MiB/u);
		assert.equal(cancelled, true);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("network and invalid updates preserve the active last-known-good catalog", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-lkg-"));
	try {
		const jouzuPaths = paths(temporary);
		await refreshModelCatalog(jouzuPaths, { env: env(), fetch: async () => response(snapshot(2)) });
		const network = await refreshModelCatalog(jouzuPaths, {
			env: env(),
			fetch: async () => {
				throw new Error("offline");
			},
		});
		assert.equal(network.status, "error");
		assert.equal(network.catalogStatus.status, "stale");
		assert.equal(loadActiveModelCatalog(jouzuPaths, env()).revision, "fixture-2");

		const lower = await refreshModelCatalog(jouzuPaths, { env: env(), fetch: async () => response(snapshot(1)) });
		assert.equal(lower.status, "rejected");
		assert.match(lower.message, /sequence decreased/);
		assert.equal(loadActiveModelCatalog(jouzuPaths, env()).revision, "fixture-2");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("mass removal quarantines exact bytes until revision and digest are accepted", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-quarantine-"));
	try {
		const jouzuPaths = paths(temporary);
		const many = Array.from({ length: 60 }, (_, index) => ({
			...fixture.modelOfferings[0],
			id: `ai.example.gateway/model-${index}`,
			modelId: `model-${index}`,
		}));
		await refreshModelCatalog(jouzuPaths, { env: env(), fetch: async () => response(snapshot(3, many)) });
		const quarantined = await refreshModelCatalog(jouzuPaths, {
			env: env(),
			fetch: async () => response(snapshot(4, many.slice(0, 40))),
			now: new Date("2026-08-26T04:00:00Z"),
		});
		assert.equal(quarantined.status, "quarantined");
		assert.deepEqual(quarantined.reasons, ["mass_removal"]);
		assert.equal(loadActiveModelCatalog(jouzuPaths, env()).revision, "fixture-3");

		const accepted = acceptQuarantinedCatalog(
			jouzuPaths,
			quarantined.revision,
			quarantined.digest,
			env(),
			new Date("2026-08-26T05:00:00Z"),
		);
		assert.equal(accepted.status, "active");
		assert.equal(accepted.quarantined, 0);
		assert.equal(loadActiveModelCatalog(jouzuPaths, env()).revision, "fixture-4");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("endpoint configuration forbids credentials and non-local cleartext", () => {
	assert.throws(() => resolveCatalogEndpoint({ JOUZU_MODEL_CATALOG_URL: "http://example.test/catalog" }), /HTTPS/);
	assert.throws(
		() => resolveCatalogEndpoint({ JOUZU_MODEL_CATALOG_URL: "https://user:pass@example.test/catalog" }),
		/credentials/,
	);
	assert.equal(
		resolveCatalogEndpoint({ JOUZU_MODEL_CATALOG_URL: "http://localhost:8080/catalog" }).url,
		"http://localhost:8080/catalog",
	);
});
