import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CatalogSourceStore } from "../dist/catalog-sources.js";
import { MODEL_CATALOG_MAX_BYTES } from "../dist/model-catalog.js";
import {
	acceptQuarantinedCatalog,
	getCatalogStatuses,
	loadActiveModelCatalogs,
	pendingStartupCatalogSources,
	refreshAllModelCatalogs,
	refreshAvailableModelCatalogs,
	refreshModelCatalog,
	refreshModelCatalogSources,
	rejectHeldCatalog,
} from "../dist/model-catalog-sync.js";
import { resolveJouzuPaths } from "../dist/paths.js";
import { acquireStateLock } from "../dist/state-lock.js";

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

function manyOfferings(count, offset = 0) {
	return Array.from({ length: count }, (_, index) => ({
		...fixture.modelOfferings[0],
		id: `ai.example.gateway/model-${offset + index}`,
		modelId: `model-${offset + index}`,
	}));
}

function catalogOriginDirectory(jouzuPaths, environment = env()) {
	const endpoint = new URL(environment.JOUZU_MODEL_CATALOG_URL).href;
	return join(jouzuPaths.cacheDir, "model-catalog", createHash("sha256").update(endpoint).digest("hex"));
}

test("first catalog failure persists a safe cause and successful activation clears it", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-first-failure-"));
	try {
		const jouzuPaths = paths(temporary);
		const result = await refreshModelCatalog(jouzuPaths, {
			env: env(),
			fetch: async () => {
				throw new TypeError("fetch failed fixture-token", {
					cause: Object.assign(new Error("private host fixture-token"), { code: "ENOTFOUND" }),
				});
			},
		});
		assert.equal(result.code, "dns_error");
		assert.equal(result.catalogStatus.status, "empty");
		assert.equal(result.catalogStatus.lastError.code, "dns_error");
		const persisted = getCatalogStatuses(jouzuPaths, env());
		assert.equal(persisted.status, "degraded");
		assert.equal(
			persisted.sources.find((source) => source.endpoint === env().JOUZU_MODEL_CATALOG_URL).lastError.code,
			"dns_error",
		);
		const origin = join(catalogOriginDirectory(jouzuPaths), "origin.json");
		assert.doesNotMatch(readFileSync(origin, "utf8"), /fixture-token|private host/u);
		assert.equal(
			(await refreshModelCatalog(jouzuPaths, { env: env(), fetch: async () => response(snapshot(1)) })).status,
			"activated",
		);
		assert.equal(
			getCatalogStatuses(jouzuPaths, env()).sources.find((source) => source.endpoint === env().JOUZU_MODEL_CATALOG_URL)
				.lastError,
			undefined,
		);
		assert.equal(JSON.parse(readFileSync(origin, "utf8")).lastError, undefined);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("HTTP authentication, account access, proxy authentication and server failures stay distinct", async () => {
	for (const [status, code] of [
		[401, "auth_rejected"],
		[403, "access_denied"],
		[407, "proxy_auth_required"],
		[503, "http_error"],
	]) {
		const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-http-error-"));
		try {
			const jouzuPaths = paths(temporary);
			const result = await refreshModelCatalog(jouzuPaths, {
				env: env(),
				fetch: async () => new Response("fixture-token", { status }),
			});
			assert.equal(result.code, code);
			assert.match(result.message, new RegExp(`HTTP ${status}`));
			assert.doesNotMatch(result.message, /fixture-token/u);
			assert.equal(
				getCatalogStatuses(jouzuPaths, env()).sources.find(
					(source) => source.endpoint === env().JOUZU_MODEL_CATALOG_URL,
				).lastError.code,
				code,
			);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	}
});

test("missing credentials and bounded validation errors survive first-refresh status", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-first-auth-"));
	try {
		const jouzuPaths = paths(temporary);
		const source = new CatalogSourceStore(jouzuPaths).add({
			label: "Private",
			url: "https://private.example/catalog",
			auth: { type: "bearer", credentialRef: "env:PRIVATE_TOKEN" },
		});
		let calls = 0;
		const fetch = async () => {
			calls++;
			return new Response("", { headers: { "content-type": `text/fixture-token${"x".repeat(1000)}` } });
		};
		const missing = await refreshModelCatalog(jouzuPaths, { sourceId: source.id, env: {}, fetch });
		assert.equal(missing.code, "auth_required");
		assert.equal(missing.catalogStatus.lastError.code, "auth_required");
		assert.equal(calls, 0);
		const invalid = await refreshModelCatalog(jouzuPaths, {
			sourceId: source.id,
			env: { PRIVATE_TOKEN: "fixture-token" },
			fetch,
		});
		assert.equal(invalid.code, "catalog_sync_error");
		assert.equal(invalid.message.length, 512);
		assert.doesNotMatch(invalid.message, /fixture-token/u);
		assert.equal(invalid.catalogStatus.lastError.message, invalid.message);
		assert.equal(calls, 1);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("local cache failures are not called network errors and invalid origin state is preserved", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-local-error-"));
	try {
		const jouzuPaths = paths(temporary);
		mkdirSync(jouzuPaths.configDir, { recursive: true });
		writeFileSync(jouzuPaths.cacheDir, "fixture file blocking cache directory");
		let calls = 0;
		const options = {
			env: env(),
			fetch: async () => {
				calls++;
				return response(snapshot(1));
			},
		};
		const blocked = await refreshModelCatalog(jouzuPaths, options);
		assert.ok(["filesystem_error", "cache_error"].includes(blocked.code), blocked.code);
		assert.equal(calls, 0);
		rmSync(jouzuPaths.cacheDir);
		await refreshModelCatalog(jouzuPaths, options);
		const origin = join(catalogOriginDirectory(jouzuPaths), "origin.json");
		writeFileSync(origin, "invalid fixture state");
		const invalid = await refreshModelCatalog(jouzuPaths, options);
		assert.equal(invalid.code, "catalog_sync_error");
		assert.equal(readFileSync(origin, "utf8"), "invalid fixture state");
		assert.equal(calls, 1);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

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
		assert.equal(
			result.catalogStatus.message,
			"No model catalog endpoint is configured. Jouzu continues using Pi and local model configuration.",
		);
		assert.equal(calls, 0);
		assert.equal(loadActiveModelCatalogs(paths(temporary), {})[0]?.document, undefined);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a missing catalog source keeps its code and English message", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-source-missing-"));
	try {
		const result = await refreshModelCatalog(paths(temporary), { env: env(), sourceId: "does-not-exist" });
		assert.equal(result.status, "error");
		assert.equal(result.code, "source_not_found");
		assert.equal(result.message, "catalog source not found or disabled: does-not-exist");
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
		assert.equal(loadActiveModelCatalogs(jouzuPaths, env())[0]?.document.revision, "fixture-1");

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
		assert.equal(status.configured, 3);
		assert.equal(status.active, 2);
		assert.deepEqual(
			status.sources.map((source) => source.sourceId),
			["shisa-api", "public-models", "private-pool"],
		);
		assert.equal(status.sources[0].status, "empty");
		assert.equal(status.sources[0].credentialName, "SHISA_API_KEY");
		assert.equal(status.sources[0].credentialAvailable, false);
		assert.deepEqual(
			status.sources.slice(1).map((source) => source.offeringCount),
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

test("the refresh timeout remains active while the response body is stalled", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-body-timeout-"));
	try {
		const result = await refreshModelCatalog(paths(temporary), {
			env: env(),
			timeoutMs: 10,
			fetch: async (_url, init) => {
				const body = new ReadableStream({
					start(controller) {
						init.signal.addEventListener(
							"abort",
							() => controller.error(new DOMException("catalog request timed out", "AbortError")),
							{ once: true },
						);
					},
				});
				return new Response(body, {
					status: 200,
					headers: { "Content-Type": "application/vnd.jouzu.model-catalog+json; version=1" },
				});
			},
		});
		assert.equal(result.status, "error");
		assert.equal(result.code, "timeout");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("an unreadable origin state returns a rejection and releases the refresh lock", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-origin-corrupt-"));
	try {
		const jouzuPaths = paths(temporary);
		await refreshModelCatalog(jouzuPaths, { env: env(), fetch: async () => response(snapshot(1)) });
		const originDirectory = catalogOriginDirectory(jouzuPaths);
		writeFileSync(join(originDirectory, "origin.json"), "{ broken");

		const result = await refreshModelCatalog(jouzuPaths, {
			env: env(),
			fetch: async () => {
				throw new Error("must not fetch");
			},
		});
		assert.equal(result.status, "rejected");
		assert.equal(result.code, "catalog_sync_error");
		assert.equal(existsSync(join(originDirectory, "refresh.lock")), false);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("an unreadable account state does not replace the refresh failure or leak its lock", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-account-corrupt-"));
	try {
		const jouzuPaths = paths(temporary);
		await refreshModelCatalog(jouzuPaths, { env: env(), fetch: async () => response(snapshot(1)) });
		const originDirectory = catalogOriginDirectory(jouzuPaths);
		const accountRefHash = createHash("sha256")
			.update(`${fixture.catalogId}\0${fixture.scope.accountRef}`)
			.digest("hex");
		writeFileSync(join(originDirectory, "accounts", accountRefHash, "state.json"), "{ broken");

		const result = await refreshModelCatalog(jouzuPaths, {
			env: env(),
			fetch: async () => {
				throw new Error("must not fetch");
			},
		});
		assert.equal(result.status, "rejected");
		assert.equal(result.code, "catalog_sync_error");
		assert.equal(existsSync(join(originDirectory, "refresh.lock")), false);
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
		assert.equal(loadActiveModelCatalogs(jouzuPaths, env())[0]?.document.revision, "fixture-2");

		const lower = await refreshModelCatalog(jouzuPaths, { env: env(), fetch: async () => response(snapshot(1)) });
		assert.equal(lower.status, "rejected");
		assert.match(lower.message, /sequence decreased/);
		assert.equal(loadActiveModelCatalogs(jouzuPaths, env())[0]?.document.revision, "fixture-2");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a revision that removes or renames most models activates as delivered", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-large-change-"));
	try {
		const jouzuPaths = paths(temporary);
		const many = manyOfferings(60);
		await refreshModelCatalog(jouzuPaths, { env: env(), fetch: async () => response(snapshot(3, many)) });
		const removal = await refreshModelCatalog(jouzuPaths, {
			env: env(),
			fetch: async () => response(snapshot(4, many.slice(0, 5))),
		});
		assert.equal(removal.status, "activated");
		assert.equal(loadActiveModelCatalogs(jouzuPaths, env())[0]?.document.modelOfferings.length, 5);

		// A namespace cutover replaces every ID: each old ID is removed and each new one added.
		const renamed = manyOfferings(24, 100).map((offering) => ({ ...offering, id: `shisa/${offering.id}` }));
		const cutover = await refreshModelCatalog(jouzuPaths, {
			env: env(),
			fetch: async () => response(snapshot(5, renamed)),
		});
		assert.equal(cutover.status, "activated");
		assert.equal(cutover.catalogStatus.quarantined, 0);
		assert.equal(loadActiveModelCatalogs(jouzuPaths, env())[0]?.document.revision, "fixture-5");

		const addition = await refreshModelCatalog(jouzuPaths, {
			env: env(),
			fetch: async () => response(snapshot(6, [...renamed, ...manyOfferings(80, 200)])),
		});
		assert.equal(addition.status, "activated");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("an empty catalog is held with its change summary until revision and digest are accepted", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-held-"));
	try {
		const jouzuPaths = paths(temporary);
		const many = manyOfferings(60);
		await refreshModelCatalog(jouzuPaths, { env: env(), fetch: async () => response(snapshot(3, many)) });
		const held = await refreshModelCatalog(jouzuPaths, {
			env: env(),
			fetch: async () => response(snapshot(4, [])),
			now: new Date("2026-08-26T04:00:00Z"),
		});
		assert.equal(held.status, "quarantined");
		assert.deepEqual(held.reasons, ["empty_catalog"]);
		assert.deepEqual(held.changes, { activeCount: 60, candidateCount: 0, added: 0, removed: 60 });
		assert.equal(loadActiveModelCatalogs(jouzuPaths, env())[0]?.document.revision, "fixture-3");
		const status = getCatalogStatuses(jouzuPaths, env()).sources.find(
			(source) => source.endpoint === env().JOUZU_MODEL_CATALOG_URL,
		);
		assert.equal(status.quarantined, 1);
		assert.deepEqual(status.held, [
			{
				revision: "fixture-4",
				digest: held.digest,
				sequence: "4",
				reasons: ["empty_catalog"],
				receivedAt: "2026-08-26T04:00:00.000Z",
				changes: { activeCount: 60, candidateCount: 0, added: 0, removed: 60 },
			},
		]);

		const accepted = acceptQuarantinedCatalog(
			jouzuPaths,
			held.revision,
			held.digest,
			env(),
			new Date("2026-08-26T05:00:00Z"),
		);
		assert.equal(accepted.status, "active");
		assert.equal(accepted.quarantined, 0);
		assert.equal(accepted.held, undefined);
		assert.equal(accepted.lastError, undefined);
		assert.equal(loadActiveModelCatalogs(jouzuPaths, env())[0]?.document.revision, "fixture-4");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("rejecting a held catalog keeps the active catalog and clears the hold", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-reject-"));
	try {
		const jouzuPaths = paths(temporary);
		await refreshModelCatalog(jouzuPaths, {
			env: env(),
			fetch: async () => response(snapshot(3, manyOfferings(10))),
		});
		const held = await refreshModelCatalog(jouzuPaths, { env: env(), fetch: async () => response(snapshot(4, [])) });
		assert.equal(held.status, "quarantined");
		const rejected = rejectHeldCatalog(jouzuPaths, held.revision, held.digest, env());
		assert.equal(rejected.status, "active");
		assert.equal(rejected.quarantined, 0);
		assert.equal(rejected.lastError, undefined);
		assert.equal(loadActiveModelCatalogs(jouzuPaths, env())[0]?.document.revision, "fixture-3");
		assert.throws(
			() => acceptQuarantinedCatalog(jouzuPaths, held.revision, held.digest, env()),
			/exact quarantined catalog candidate was not found/u,
		);
		assert.throws(() => rejectHeldCatalog(jouzuPaths, held.revision, held.digest, env()), /was not found/u);
		// The publisher still serves the empty catalog, so the next refresh holds it again.
		const again = await refreshModelCatalog(jouzuPaths, { env: env(), fetch: async () => response(snapshot(4, [])) });
		assert.equal(again.status, "quarantined");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a newer activation drops held revisions it supersedes", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-stale-held-"));
	try {
		const jouzuPaths = paths(temporary);
		const many = manyOfferings(60);
		await refreshModelCatalog(jouzuPaths, { env: env(), fetch: async () => response(snapshot(3, many)) });
		const held = await refreshModelCatalog(jouzuPaths, {
			env: env(),
			fetch: async () => response(snapshot(4, [])),
		});
		assert.equal(held.status, "quarantined");
		const next = await refreshModelCatalog(jouzuPaths, { env: env(), fetch: async () => response(snapshot(5, many)) });
		assert.equal(next.status, "activated");
		assert.equal(next.catalogStatus.quarantined, 0);

		assert.throws(
			() => acceptQuarantinedCatalog(jouzuPaths, held.revision, held.digest, env()),
			/exact quarantined catalog candidate was not found/u,
		);
		assert.equal(loadActiveModelCatalogs(jouzuPaths, env())[0]?.document.revision, "fixture-5");
		const origin = catalogOriginDirectory(jouzuPaths);
		const account = JSON.parse(readFileSync(join(origin, "origin.json"))).activeAccountRefHash;
		assert.deepEqual(readdirSync(join(origin, "accounts", account, "quarantine")), []);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a held revision recorded under an earlier rule activates on the next refresh", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-legacy-held-"));
	try {
		const jouzuPaths = paths(temporary);
		const many = manyOfferings(60);
		await refreshModelCatalog(jouzuPaths, { env: env(), fetch: async () => response(snapshot(3, many)) });
		const origin = catalogOriginDirectory(jouzuPaths);
		const account = JSON.parse(readFileSync(join(origin, "origin.json"))).activeAccountRefHash;
		const directory = join(origin, "accounts", account);
		const statePath = join(directory, "state.json");
		const candidate = JSON.stringify(snapshot(4, many.slice(0, 40)));
		const digest = createHash("sha256").update(candidate).digest("hex");
		mkdirSync(join(directory, "quarantine"), { recursive: true });
		writeFileSync(join(directory, "quarantine", `${digest}.json`), candidate);
		const state = JSON.parse(readFileSync(statePath));
		state.quarantined = [
			{
				digest,
				revision: "fixture-4",
				sequence: "4",
				document: `quarantine/${digest}.json`,
				reasons: ["mass_removal"],
				receivedAt: "2026-08-26T04:00:00.000Z",
				bytes: Buffer.byteLength(candidate),
			},
		];
		state.lastError = { code: "quarantined", message: "mass_removal", at: "2026-08-26T04:00:00.000Z" };
		writeFileSync(statePath, JSON.stringify(state));
		const before = getCatalogStatuses(jouzuPaths, env()).sources.find(
			(source) => source.endpoint === env().JOUZU_MODEL_CATALOG_URL,
		);
		assert.equal(before.held?.[0]?.changes, undefined);

		const refreshed = await refreshModelCatalog(jouzuPaths, {
			env: env(),
			fetch: async () => response(snapshot(4, many.slice(0, 40))),
		});
		assert.equal(refreshed.status, "activated");
		assert.equal(refreshed.catalogStatus.quarantined, 0);
		assert.equal(refreshed.catalogStatus.lastError, undefined);
		assert.equal(loadActiveModelCatalogs(jouzuPaths, env())[0]?.document.revision, "fixture-4");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("startup refresh contacts only sources with available credentials", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-startup-"));
	try {
		const jouzuPaths = paths(temporary);
		let calls = 0;
		const none = await refreshAvailableModelCatalogs(jouzuPaths, {
			env: {},
			fetch: async () => {
				calls += 1;
				throw new Error("must not fetch");
			},
		});
		assert.equal(none, undefined);
		assert.equal(calls, 0);

		const requests = [];
		const result = await refreshAvailableModelCatalogs(jouzuPaths, {
			env: { SHISA_API_KEY: "sk-fixture" },
			fetch: async (url, init) => {
				requests.push({ url: String(url), headers: new Headers(init.headers), redirect: init.redirect });
				return response(snapshot(1));
			},
			now: new Date("2026-09-02T00:00:00Z"),
		});
		assert.equal(result.status, "complete");
		assert.deepEqual(
			requests.map((request) => request.url),
			["https://api.shisa.ai/v1/jouzu/model-catalog"],
		);
		assert.equal(requests[0].headers.get("authorization"), "Bearer sk-fixture");
		assert.equal(requests[0].redirect, "error");
		assert.equal(
			loadActiveModelCatalogs(jouzuPaths, { SHISA_API_KEY: "sk-fixture" })[0]?.document.revision,
			"fixture-1",
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a disabled built-in override produces no startup request", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-disabled-"));
	try {
		const jouzuPaths = paths(temporary);
		new CatalogSourceStore(jouzuPaths, { env: {} }).setEnabled("shisa-api", false);
		let calls = 0;
		const result = await refreshAvailableModelCatalogs(jouzuPaths, {
			env: { SHISA_API_KEY: "sk-fixture" },
			fetch: async () => {
				calls += 1;
				throw new Error("must not fetch");
			},
		});
		assert.equal(result, undefined);
		assert.equal(calls, 0);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("the startup gate lists only credentialed sources with no activated revision", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-startup-gate-"));
	try {
		const jouzuPaths = paths(temporary);
		const keyed = { SHISA_API_KEY: "sk-fixture" };
		const ids = (environment) => pendingStartupCatalogSources(jouzuPaths, environment).map((source) => source.id);

		// Without a credential there is nothing to fetch, so nothing may block startup.
		assert.deepEqual(ids({}), []);
		// With one and no revision, the picker has nothing cached to serve.
		assert.deepEqual(ids(keyed), ["shisa-api"]);

		await refreshModelCatalog(jouzuPaths, {
			env: keyed,
			fetch: async () => response(snapshot(1)),
			now: new Date("2026-09-02T00:00:00Z"),
		});
		assert.deepEqual(ids(keyed), [], "an activated revision serves the initial selection");

		// A later failure keeps the revision, so startup stays off the blocking path.
		await refreshModelCatalog(jouzuPaths, {
			env: keyed,
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
		});
		const stale = getCatalogStatuses(jouzuPaths, keyed).sources[0];
		assert.equal(stale.status, "stale");
		assert.ok(stale.lastError);
		assert.deepEqual(ids(keyed), []);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a failed first refresh leaves its source pending for the next startup", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-startup-pending-"));
	try {
		const jouzuPaths = paths(temporary);
		const keyed = { SHISA_API_KEY: "sk-fixture" };
		await refreshModelCatalog(jouzuPaths, {
			env: keyed,
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
		});
		const status = getCatalogStatuses(jouzuPaths, keyed).sources[0];
		assert.equal(status.status, "empty");
		assert.ok(status.lastError);
		assert.deepEqual(
			pendingStartupCatalogSources(jouzuPaths, keyed).map((source) => source.id),
			["shisa-api"],
		);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a targeted startup refresh contacts only sources without an activated revision", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-startup-target-"));
	try {
		const jouzuPaths = paths(temporary);
		const environment = { SHISA_API_KEY: "sk-fixture", PRIVATE_TOKEN: "fixture-token" };
		new CatalogSourceStore(jouzuPaths, { env: environment }).add({
			label: "Private pool",
			url: "https://private.example/v1/jouzu/model-catalog",
			auth: { type: "bearer", credentialRef: "env:PRIVATE_TOKEN" },
		});
		const requests = [];
		const fetch = async (url) => {
			requests.push(String(url));
			return response(snapshot(1));
		};
		const privatePool = pendingStartupCatalogSources(jouzuPaths, environment).filter(
			(source) => source.id === "private-pool",
		);
		assert.equal(
			(await refreshModelCatalogSources(jouzuPaths, privatePool, { env: environment, fetch })).status,
			"complete",
		);
		assert.deepEqual(requests, ["https://private.example/v1/jouzu/model-catalog"]);

		// The activated source drops out, so only the still-empty built-in source remains.
		const pending = pendingStartupCatalogSources(jouzuPaths, environment);
		assert.deepEqual(
			pending.map((source) => source.id),
			["shisa-api"],
		);
		requests.length = 0;
		const result = await refreshModelCatalogSources(jouzuPaths, pending, { env: environment, fetch });
		assert.deepEqual(requests, ["https://api.shisa.ai/v1/jouzu/model-catalog"]);
		assert.deepEqual(
			result.results.map(({ source }) => source.id),
			["shisa-api"],
		);
		// An empty list means "nothing to do", not a refresh that ran.
		assert.equal(await refreshModelCatalogSources(jouzuPaths, [], { env: environment, fetch }), undefined);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("explicit built-in refresh without a key reports auth_required without a request", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-nokey-"));
	try {
		const jouzuPaths = paths(temporary);
		let calls = 0;
		const result = await refreshModelCatalog(jouzuPaths, {
			sourceId: "shisa-api",
			env: {},
			fetch: async () => {
				calls += 1;
				throw new Error("must not fetch");
			},
		});
		assert.equal(result.status, "error");
		assert.equal(result.code, "auth_required");
		assert.match(result.message, /SHISA_API_KEY/);
		assert.equal(result.catalogStatus.credentialName, "SHISA_API_KEY");
		assert.equal(result.catalogStatus.credentialAvailable, false);
		assert.equal(calls, 0);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("a manual Shisa registration keeps its cache when the built-in descriptor takes over", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-migration-"));
	try {
		const jouzuPaths = paths(temporary);
		const store = new CatalogSourceStore(jouzuPaths, { env: {} });
		const manual = store.add({
			id: "shisa",
			label: "My Shisa",
			url: "https://api.shisa.ai/v1/jouzu/model-catalog",
			auth: { type: "bearer", credentialRef: "env:SHISA_API_KEY" },
		});
		const refreshed = await refreshModelCatalog(jouzuPaths, {
			sourceId: manual.id,
			env: { SHISA_API_KEY: "sk-fixture" },
			fetch: async () => response(snapshot(7)),
			now: new Date("2026-09-02T01:00:00Z"),
		});
		assert.equal(refreshed.status, "activated");
		assert.equal(refreshed.catalogStatus.sourceId, "shisa");

		// Removing the manual registration hands the same URL-keyed cache to the built-in.
		rmSync(join(jouzuPaths.configDir, "catalogs.json"));
		const resolved = loadActiveModelCatalogs(jouzuPaths, { SHISA_API_KEY: "sk-fixture" });
		assert.equal(resolved.length, 1);
		assert.equal(resolved[0].source.id, "shisa-api");
		assert.equal(resolved[0].document.revision, "fixture-7");
		const status = getCatalogStatuses(jouzuPaths, { SHISA_API_KEY: "sk-fixture" });
		assert.equal(status.sources[0].sourceId, "shisa-api");
		assert.equal(status.sources[0].status, "active");
		assert.equal(status.sources[0].credentialAvailable, true);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

for (const refresh of [refreshAllModelCatalogs, refreshAvailableModelCatalogs]) {
	test(`${refresh.name} waits for healthy sources when another source is locked`, async () => {
		const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-busy-"));
		let release;
		try {
			const jouzuPaths = paths(temporary);
			const store = new CatalogSourceStore(jouzuPaths, {});
			const busy = store.add({ label: "Busy", url: "https://busy.example/catalog", auth: { type: "none" } });
			store.add({ label: "Healthy", url: "https://healthy.example/catalog", auth: { type: "none" } });
			release = acquireStateLock({
				path: join(catalogOriginDirectory(jouzuPaths, { JOUZU_MODEL_CATALOG_URL: busy.url }), "refresh.lock"),
				describe: "test",
				onBusy: () => new Error("busy"),
			});
			let completed = false;
			const result = await refresh(jouzuPaths, {
				env: {},
				fetch: async () => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					completed = true;
					return response(snapshot(1));
				},
			});
			assert.equal(completed, true);
			assert.equal(result.status, "partial");
			assert.match(result.results[0].result.message, /busy/);
			assert.equal(result.results[1].result.status, "activated");
			assert.equal(loadActiveModelCatalogs(jouzuPaths, {}).length, 1);
		} finally {
			release?.();
			rmSync(temporary, { recursive: true, force: true });
		}
	});
}

test("activated document retention keeps active and previous revisions", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "jouzu-catalog-retention-"));
	try {
		const jouzuPaths = paths(temporary);
		for (let sequence = 1; sequence <= 5; sequence++) {
			assert.equal(
				(
					await refreshModelCatalog(jouzuPaths, {
						env: env(),
						fetch: async () => response(snapshot(sequence, manyOfferings(20))),
					})
				).status,
				"activated",
			);
		}
		const origin = catalogOriginDirectory(jouzuPaths);
		const account = JSON.parse(readFileSync(join(origin, "origin.json"))).activeAccountRefHash;
		const directory = join(origin, "accounts", account);
		const state = JSON.parse(readFileSync(join(directory, "state.json")));
		assert.equal(state.active.sequence, "5");
		assert.equal(state.previous.sequence, "4");
		assert.deepEqual(
			readdirSync(join(directory, "documents")).sort(),
			[`${state.active.digest}.json`, `${state.previous.digest}.json`].sort(),
		);
		const candidate = await refreshModelCatalog(jouzuPaths, {
			env: env(),
			fetch: async () => response(snapshot(6, [])),
		});
		assert.equal(candidate.status, "quarantined");
		acceptQuarantinedCatalog(jouzuPaths, candidate.revision, candidate.digest, env());
		const accepted = JSON.parse(readFileSync(join(directory, "state.json")));
		assert.equal(accepted.active.sequence, "6");
		assert.equal(accepted.previous.sequence, "5");
		assert.deepEqual(
			readdirSync(join(directory, "documents")).sort(),
			[`${accepted.active.digest}.json`, `${accepted.previous.digest}.json`].sort(),
		);
		for (const ref of [accepted.active, accepted.previous]) assert.ok(existsSync(join(directory, ref.document)));
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});
