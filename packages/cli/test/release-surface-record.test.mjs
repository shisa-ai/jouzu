import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	inspectReleaseExtensions,
	RELEASE_SURFACES as RELEASE_SURFACES_FROM_EXTENSIONS,
	summarizeReleaseSurfaces as summarizeReleaseSurfacesFromExtensions,
} from "../dist/release-extensions.js";
import {
	RELEASE_SURFACE_PI_PROVENANCE,
	RELEASE_SURFACES,
	releaseSurfacesNeedingRecheck,
	summarizeReleaseSurfaces,
} from "../dist/release-surface-record.js";

const MANIFEST = JSON.parse(readFileSync(new URL("../release-extensions.json", import.meta.url), "utf8"));
const PI_LOCK = JSON.parse(readFileSync(new URL("../../../upstream/pi.lock.json", import.meta.url), "utf8"));

const OWNERS = new Set(["pi", "service", ...MANIFEST.packages.map((record) => record.name)]);
const RENDER_ROUTES = new Set(["Pi TUI", "extension", "browser"]);
const LOCALIZATION_HOOKS = new Set(["available", "none-known", "not-inspected"]);
const DISPOSITIONS = new Set(["translated", "upstream-owned", "not-inspected", "out-of-scope"]);

test("pins the surface total and the four disposition counts", () => {
	const summary = summarizeReleaseSurfaces();
	assert.deepEqual(summary, {
		total: 53,
		translated: 1,
		upstreamOwned: 42,
		notInspected: 1,
		outOfScope: 9,
		unknown: 0,
	});
	assert.equal(RELEASE_SURFACES.length, summary.total);
	assert.equal(
		summary.translated + summary.upstreamOwned + summary.notInspected + summary.outOfScope + summary.unknown,
		summary.total,
	);
});

test("keeps every surface record complete and in the recorded vocabulary", () => {
	const ids = new Set();
	for (const surface of RELEASE_SURFACES) {
		assert.ok(surface.surfaceId.length > 0, "surfaceId is required");
		assert.equal(ids.has(surface.surfaceId), false, `duplicate surfaceId ${surface.surfaceId}`);
		ids.add(surface.surfaceId);
		assert.ok(OWNERS.has(surface.owner), `unknown owner ${surface.owner}`);
		assert.ok(surface.version.length > 0, `missing version for ${surface.surfaceId}`);
		assert.ok(RENDER_ROUTES.has(surface.renderRoute), `unknown renderRoute for ${surface.surfaceId}`);
		assert.ok(LOCALIZATION_HOOKS.has(surface.localizationHook), `unknown hook for ${surface.surfaceId}`);
		assert.ok(DISPOSITIONS.has(surface.disposition), `unknown disposition for ${surface.surfaceId}`);
		assert.ok(surface.recheckOn.length > 0, `missing recheckOn for ${surface.surfaceId}`);
	}
});

test("gives every release extension a versioned display entry point without rewriting prior inspection", () => {
	for (const record of MANIFEST.packages) {
		const owned = RELEASE_SURFACES.filter((surface) => surface.owner === record.name);
		assert.ok(owned.length > 0, `no surface recorded for ${record.name}`);
		for (const surface of owned) {
			assert.equal(surface.renderRoute, "extension", `${surface.surfaceId} renderRoute`);
			assert.equal(surface.recheckOn, `${record.name}@${surface.version}`, `${surface.surfaceId} recheckOn`);
		}
	}
});

test("records the inspected Pi provenance and flags version changes for reinspection", () => {
	assert.deepEqual(RELEASE_SURFACE_PI_PROVENANCE, {
		version: "1.5.0",
		tag: "v1.5.0",
		commit: "f9a26365568127461c47a07a37dcb42c140a3ac5",
	});
	const pi = RELEASE_SURFACES.filter((candidate) => candidate.owner === "pi");
	for (const surface of pi) {
		assert.equal(surface.version, RELEASE_SURFACE_PI_PROVENANCE.version, surface.surfaceId);
		assert.equal(surface.recheckOn, `pi@${RELEASE_SURFACE_PI_PROVENANCE.version}`, surface.surfaceId);
	}
	assert.equal(
		releaseSurfacesNeedingRecheck({ pi: PI_LOCK.packages["@earendil-works/pi-coding-agent"].version }, pi).length,
		0,
	);
	assert.equal(releaseSurfacesNeedingRecheck({ pi: "1.0.0" }, pi).length, pi.length);
	assert.equal(releaseSurfacesNeedingRecheck({}, pi).length, pi.length);
});

test("never counts an unknown or missing disposition as translated", () => {
	const known = { surfaceId: "fixture.known", owner: "pi", version: "1.0.0" };
	const summary = summarizeReleaseSurfaces([
		{ ...known, surfaceId: "fixture.translated", disposition: "translated" },
		{ ...known, surfaceId: "fixture.unknown", disposition: "future-value" },
		{ ...known, surfaceId: "fixture.missing" },
		undefined,
	]);
	assert.deepEqual(summary, {
		total: 4,
		translated: 1,
		upstreamOwned: 0,
		notInspected: 0,
		outOfScope: 0,
		unknown: 3,
	});
});

test("decides a re-inspection by comparing each recorded pin with the installed version", async () => {
	const { VERSION: installedPiVersion } = await import("@earendil-works/pi-coding-agent");
	assert.equal(installedPiVersion, PI_LOCK.packages["@earendil-works/pi-coding-agent"].version);
	const versions = { pi: installedPiVersion };
	const status = inspectReleaseExtensions();
	assert.deepEqual(status.errors, []);
	for (const record of MANIFEST.packages) {
		if (record.source === "bundled" || record.adapter) {
			versions[record.name] = record.version;
			continue;
		}
		const root = status.resolvedPackageRoots[record.name];
		assert.ok(root, `${record.name} did not resolve`);
		const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		assert.equal(version, record.version);
		versions[record.name] = version;
	}
	const rechecks = releaseSurfacesNeedingRecheck(versions);
	assert.deepEqual(
		rechecks.map((row) => row.surfaceId),
		RELEASE_SURFACES.filter((row) => row.owner !== "service" && versions[row.owner] !== row.version).map(
			(row) => row.surfaceId,
		),
	);
	assert.equal(
		rechecks.some((row) => row.owner === "pi"),
		false,
	);
	assert.ok(rechecks.some((row) => row.owner === "@sting8k/pi-vcc"));
	assert.equal(
		rechecks.some((row) => row.owner === "service"),
		false,
	);
});

test("exposes the residual list and counts through release-extensions", () => {
	assert.equal(RELEASE_SURFACES_FROM_EXTENSIONS, RELEASE_SURFACES);
	assert.deepEqual(summarizeReleaseSurfacesFromExtensions(), summarizeReleaseSurfaces());
});
