import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SESSION_UI_RUNTIME_IDS, SYSTEM_SESSION_UI_CLOCK } from "../dist/index.js";

test("centralizes runtime-only identity without persisted configuration", () => {
	assert.deepEqual(SESSION_UI_RUNTIME_IDS, {
		extension: "jouzu-session-ui",
		sessionLineWidget: "jouzu-session-line",
	});
	assert.equal(Object.isFrozen(SESSION_UI_RUNTIME_IDS), true);
	const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(packageJson.private, true);
});

test("keeps time injectable behind the session UI contract", () => {
	const before = Date.now();
	const observed = SYSTEM_SESSION_UI_CLOCK.now();
	assert.ok(observed >= before && observed <= Date.now());
});
