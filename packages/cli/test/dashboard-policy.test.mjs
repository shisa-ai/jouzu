import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	DASHBOARD_MODES,
	DashboardVisibility,
	dashboardPolicyPath,
	loadDashboardPolicy,
	writeDashboardPolicy,
} from "../dist/dashboard-policy.js";

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "dashboard-policy-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const paths = { configDir: join(root, "config"), stateDir: join(root, "state"), cwd: root };
	mkdirSync(paths.configDir);
	return paths;
}
test("dashboard policy defaults compact and roundtrips each saved mode privately", (t) => {
	const paths = fixture(t);
	assert.deepEqual(loadDashboardPolicy(paths), { mode: "compact" });
	for (const mode of DASHBOARD_MODES) {
		writeDashboardPolicy(paths, mode);
		assert.deepEqual(loadDashboardPolicy(paths), { mode });
		assert.equal(statSync(dashboardPolicyPath(paths)).mode & 0o777, 0o600);
	}
});
test("invalid dashboard policies report errors and are not overwritten", (t) => {
	const paths = fixture(t);
	for (const content of [
		"{",
		"null",
		"[]",
		'{"schemaVersion":2,"mode":"compact"}',
		'{"schemaVersion":1,"mode":"other"}',
		'{"schemaVersion":1,"mode":"compact","extra":true}',
		'{"schemaVersion":1,"mode":"hidden","mode":"compact"}',
		" ".repeat(8193),
	]) {
		writeFileSync(dashboardPolicyPath(paths), content);
		assert.ok(loadDashboardPolicy(paths).error);
		assert.throws(() => writeDashboardPolicy(paths, "expanded"));
		assert.equal(readFileSync(dashboardPolicyPath(paths), "utf8"), content);
	}
});
test("symlinks including dangling links are rejected", (t) => {
	const paths = fixture(t);
	symlinkSync(join(paths.cwd, "missing"), dashboardPolicyPath(paths));
	assert.ok(loadDashboardPolicy(paths).error);
	assert.throws(() => writeDashboardPolicy(paths, "compact"));
});
test("session visibility restores the saved mode and resets on attachment", () => {
	const visibility = new DashboardVisibility();
	for (const saved of DASHBOARD_MODES) {
		visibility.hide();
		assert.equal(visibility.mode(saved), "hidden");
		visibility.show();
		assert.equal(visibility.mode(saved), saved);
		visibility.hide();
		visibility.reset();
		assert.equal(visibility.mode(saved), saved);
	}
});
