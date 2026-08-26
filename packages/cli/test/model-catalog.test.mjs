import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
	catalogDocumentSha256,
	checkCatalogConformance,
	MODEL_CATALOG_MEDIA_TYPE,
	ModelCatalogError,
	parseAndValidateModelCatalog,
} from "../dist/model-catalog.js";

const catalogRoot = join(import.meta.dirname, "..", "catalog");
const fixture = (name) => readFileSync(join(catalogRoot, "fixtures", name), "utf8");

function accountSnapshot() {
	return JSON.parse(fixture("account-snapshot-v1.json"));
}

function invalid(document, mutate) {
	const copy = structuredClone(document);
	mutate(copy);
	return JSON.stringify(copy);
}

test("canonical account snapshot and local compatibility pack conform", () => {
	const snapshotText = fixture("account-snapshot-v1.json");
	const snapshot = parseAndValidateModelCatalog(snapshotText, { remote: true });
	assert.equal(snapshot.catalogId, "ai.example.test");
	assert.equal(snapshot.scope.accountRef, "acct_fixture");
	assert.equal(snapshot.modelOfferings[0].id, "ai.example.gateway/example-model");
	assert.equal(snapshot.modelOfferings[0].availability.status, "available");

	const pack = parseAndValidateModelCatalog(fixture("compatibility-pack-v1.json"));
	assert.equal(pack.kind, "compatibility-pack");
	assert.equal(pack.sequence, undefined);
	assert.equal(pack.matchRules.length, 1);
	assert.equal(MODEL_CATALOG_MEDIA_TYPE, "application/vnd.jouzu.model-catalog+json; version=1");
	assert.match(catalogDocumentSha256(snapshotText), /^[0-9a-f]{64}$/);
});

test("remote documents require a bounded uint64 sequence", () => {
	const base = accountSnapshot();
	for (const value of [undefined, "01", "18446744073709551616", 2]) {
		assert.throws(
			() =>
				parseAndValidateModelCatalog(
					invalid(base, (document) => {
						if (value === undefined) delete document.sequence;
						else document.sequence = value;
					}),
					{ remote: true },
				),
			(error) => error instanceof ModelCatalogError && error.code === "sequence_malformed",
		);
	}
});

test("strict parsing rejects duplicate keys, unsafe references, and credential fields", () => {
	const duplicate = fixture("account-snapshot-v1.json").replace(
		'"revision": "fixture-1",',
		'"revision": "fixture-1",\n  "revision": "fixture-2",',
	);
	assert.throws(
		() => parseAndValidateModelCatalog(duplicate, { remote: true }),
		(error) => error instanceof ModelCatalogError && error.code === "duplicate_key",
	);

	const base = accountSnapshot();
	assert.throws(
		() =>
			parseAndValidateModelCatalog(
				invalid(base, (document) => {
					document.modelOfferings[0].routeIds = ["missing-route"];
				}),
				{ remote: true },
			),
		(error) => error instanceof ModelCatalogError && error.code === "unresolved_reference",
	);
	assert.throws(
		() =>
			parseAndValidateModelCatalog(
				invalid(base, (document) => {
					document.extensions = { apiKey: "must-not-appear" };
				}),
				{ remote: true },
			),
		(error) => error instanceof ModelCatalogError && error.code === "credential_material",
	);
});

test("account scope, included classes, limits, and availability fail closed", () => {
	const base = accountSnapshot();
	for (const [code, mutate] of [
		[
			"invalid_scope",
			(document) => {
				delete document.scope.accountRef;
			},
		],
		[
			"invalid_scope",
			(document) => {
				document.scope.includes = document.scope.includes.filter((value) => value !== "routes");
			},
		],
		[
			"invalid_record",
			(document) => {
				document.modelOfferings[0].limits.contextWindow = 0;
			},
		],
		[
			"invalid_record",
			(document) => {
				document.modelOfferings[0].availability.status = "healthy";
			},
		],
	]) {
		assert.throws(
			() => parseAndValidateModelCatalog(invalid(base, mutate), { remote: true }),
			(error) => error instanceof ModelCatalogError && error.code === code,
		);
	}
});

test("schema artifact is valid JSON and declares the account-scoped envelope", () => {
	const schema = JSON.parse(readFileSync(join(catalogRoot, "model-catalog-v1.schema.json"), "utf8"));
	assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
	assert.deepEqual(schema.properties.kind.enum, ["snapshot", "compatibility-pack"]);
	assert.deepEqual(schema.$defs.scope.allOf[0].then.required, ["accountRef"]);
});

test("conformance result is machine-readable and never throws", () => {
	const valid = checkCatalogConformance(fixture("account-snapshot-v1.json"), { remote: true });
	assert.equal(valid.valid, true);
	assert.equal(valid.recordCounts.modelOfferings, 1);

	const invalidResult = checkCatalogConformance("[]", { remote: true });
	assert.deepEqual(
		{ valid: invalidResult.valid, code: invalidResult.error?.code, path: invalidResult.error?.path },
		{ valid: false, code: "invalid_record", path: "$" },
	);
});
