import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveJouzuPaths } from "../dist/paths.js";
import { DEFAULT_SHISA_DASHBOARD_URL, readShisaAccountStatus, shisaDashboardUrl } from "../dist/shisa-link/account.js";
import { setShisaSignedOut, writeShisaLoginCredential } from "../dist/shisa-link/credentials.js";
import { newShisaInstallId, shisaLinkStatePath, writeShisaLinkState } from "../dist/shisa-link/state.js";

function linkState(extra = {}) {
	return {
		install_id: newShisaInstallId(),
		authorization_id: "authorization",
		api_key_uuid: "key",
		org: { id: "org", name: "Example Org", slug: "example" },
		endpoints: {
			openai_base_url: "https://api.example.test/v1",
			model_catalog_url: "https://api.example.test/catalog",
			asr_realtime_url: "wss://api.example.test/asr",
		},
		link_token: "link-secret",
		acked: true,
		...extra,
	};
}

async function paths(t) {
	const home = mkdtempSync(join(tmpdir(), "jouzu-account-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const resolved = resolveJouzuPaths({ homeOverride: home });
	t.after(() => setShisaSignedOut(resolved, false));
	return resolved;
}

test("the dashboard follows the gateway that issued the sign-in", () => {
	assert.equal(shisaDashboardUrl(), DEFAULT_SHISA_DASHBOARD_URL);
	assert.equal(shisaDashboardUrl("https://gateway.shisa.ai"), "https://platform.shisa.ai/en/dashboard");
	assert.equal(shisaDashboardUrl("https://gateway.staging.shisa.ai"), "https://platform.staging.shisa.ai/en/dashboard");
	assert.equal(shisaDashboardUrl("http://localhost:8080"), "http://localhost:8080/en/dashboard");
});

test("an unusable gateway falls back to the production dashboard", () => {
	for (const gateway of [
		"",
		"not a url",
		"http://gateway.shisa.ai",
		"https://user:secret@gateway.shisa.ai",
		"https://gateway.shisa.ai?next=/admin",
		"https://gateway.shisa.ai#fragment",
	])
		assert.equal(shisaDashboardUrl(gateway), DEFAULT_SHISA_DASHBOARD_URL, gateway);
});

test("account status reads local state only and reports the organization", async (t) => {
	const resolved = await paths(t);
	assert.deepEqual(readShisaAccountStatus(resolved, {}), {
		signedIn: false,
		dashboardUrl: DEFAULT_SHISA_DASHBOARD_URL,
	});
	await writeShisaLinkState(
		shisaLinkStatePath(resolved),
		linkState({ gateway_url: "https://gateway.shisa.ai", bonus: { status: "granted", amount_usd: 10 } }),
		resolved.stateDir,
	);
	await writeShisaLoginCredential(resolved, {
		access: "shsk:test",
		type: "oauth",
		expires: Date.now() + 3_600_000,
		refresh: "",
	});
	const status = readShisaAccountStatus(resolved, {});
	assert.equal(status.signedIn, true);
	assert.equal(status.org, "Example Org");
	assert.equal(status.dashboardUrl, "https://platform.shisa.ai/en/dashboard");
	assert.equal(status.bonusUsd, 10);
});

test("signing out suppresses the account without touching the saved link", async (t) => {
	const resolved = await paths(t);
	await writeShisaLinkState(shisaLinkStatePath(resolved), linkState(), resolved.stateDir);
	await writeShisaLoginCredential(resolved, {
		access: "shsk:test",
		type: "oauth",
		expires: Date.now() + 3_600_000,
		refresh: "",
	});
	setShisaSignedOut(resolved, true);
	const status = readShisaAccountStatus(resolved, {});
	assert.equal(status.signedIn, false);
	assert.equal(status.org, undefined, "a suppressed account reports no organization");
});

test("an environment key counts as signed in", async (t) => {
	const resolved = await paths(t);
	assert.equal(readShisaAccountStatus(resolved, { SHISA_API_KEY: "shsk:env" }).signedIn, true);
	assert.equal(readShisaAccountStatus(resolved, { SHISA_API_KEY: "   " }).signedIn, false);
});
