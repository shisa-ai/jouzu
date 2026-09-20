import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { setCatalogSourceToken } from "../dist/catalog-sources.js";
import { isInteractivePiStartup } from "../dist/interactive-startup.js";
import { resolveJouzuPaths } from "../dist/paths.js";
import { readShisaLoginToken, writeShisaLoginCredential } from "../dist/shisa-link/credentials.js";
import { offerShisaOnboarding, shisaOnboardingPath } from "../dist/shisa-link/onboarding.js";
import { readShisaLinkState, shisaLinkStatePath } from "../dist/shisa-link/state.js";

const code = {
	device_code: "device-secret",
	user_code: "JOUZU-TEST-1234",
	verification_uri: "https://example.test/connect",
	authorization_id: "authorization",
	expires_in: 900,
	interval: 5,
};
const token = {
	user: { email: "test@example.test" },
	api_key: { uuid: "key", secret: "shsk:test-secret", label: "Jouzu" },
	org: { id: "org", name: "Example", slug: "example" },
	endpoints: {
		openai_base_url: "https://api.example.test/v1",
		model_catalog_url: "https://api.example.test/catalog",
		asr_realtime_url: "wss://api.example.test/asr",
	},
	link_token: "link-secret",
	authorization_id: "authorization",
};
function response(status, body) {
	return new Response(body ? JSON.stringify(body) : null, { status, headers: { "content-type": "application/json" } });
}
function harness(t, extra = {}) {
	const home = mkdtempSync(join(tmpdir(), "jouzu-onboarding-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const paths = resolveJouzuPaths({ homeOverride: home });
	let text = "";
	const output = new PassThrough();
	output.columns = 48;
	output.on("data", (data) => {
		text += data;
	});
	return {
		paths,
		output,
		text: () => text,
		options: {
			paths,
			output,
			interactive: true,
			env: {},
			jouzuVersion: "0.1.9",
			ask: async () => "n",
			fetchImpl: () => assert.fail("unexpected network"),
			sleep: async () => {},
			...extra,
		},
	};
}

test("skip is private, persists across launches, and wraps the offer at 48 columns", async (t) => {
	const h = harness(t);
	await offerShisaOnboarding(h.options);
	assert.match(h.text(), /\$10 instant credits/);
	assert.match(h.text(), /\$25 more/);
	assert.match(h.text(), /\/login shisa/);
	for (const line of h.text().split("\n")) assert.ok(visibleWidth(line) <= 48, line);
	const path = shisaOnboardingPath(h.paths);
	assert.equal(JSON.parse(readFileSync(path, "utf8")).choice, "skip");
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
	await offerShisaOnboarding({ ...h.options, ask: () => assert.fail("offered twice") });
});

for (const answer of ["", "no", "maybe"]) {
	test(`only affirmative answers connect (${JSON.stringify(answer)})`, async (t) => {
		const h = harness(t, { ask: async () => answer });
		await offerShisaOnboarding(h.options);
		assert.equal(JSON.parse(readFileSync(shisaOnboardingPath(h.paths), "utf8")).choice, "skip");
	});
}

for (const args of [["--print", "hello"], ["--mode", "rpc"], ["--mode=json"], ["--help"]]) {
	test(`noninteractive startup does not offer or write (${args.join(" ")})`, async (t) => {
		const interactive = isInteractivePiStartup(args, { stdinIsTTY: true, stdoutIsTTY: true, env: {} });
		assert.equal(interactive, false);
		const h = harness(t, { interactive, ask: () => assert.fail("prompted") });
		await offerShisaOnboarding(h.options);
		assert.equal(h.text(), "");
		assert.equal(existsSync(shisaOnboardingPath(h.paths)), false);
	});
}

for (const source of ["environment", "login", "catalog token"]) {
	test(`existing ${source} credentials suppress the offer`, async (t) => {
		const h = harness(t, { ask: () => assert.fail("prompted") });
		if (source === "environment") h.options.env = { SHISA_API_KEY: "configured" };
		else if (source === "catalog token") setCatalogSourceToken(h.paths, "shisa-api", "configured");
		else
			await writeShisaLoginCredential(h.paths, {
				type: "oauth",
				access: "configured",
				refresh: "",
				expires: Number.MAX_SAFE_INTEGER,
			});
		await offerShisaOnboarding(h.options);
		assert.equal(h.text(), "");
		assert.equal(existsSync(shisaOnboardingPath(h.paths)), false);
	});
}

test("acceptance runs device login, saves before acknowledgement, and preserves other providers", async (t) => {
	const h = harness(t, { ask: async () => "YES" });
	mkdirSync(h.paths.agentDir, { recursive: true });
	writeFileSync(
		join(h.paths.agentDir, "auth.json"),
		JSON.stringify({ other: { type: "api_key", key: "other-secret" } }),
	);
	const calls = [];
	await offerShisaOnboarding({
		...h.options,
		fetchImpl: async (url) => {
			calls.push(url);
			if (url.endsWith("/code")) return response(201, code);
			if (url.endsWith("/token")) return response(200, token);
			assert.equal(readShisaLoginToken(h.paths), token.api_key.secret);
			assert.equal(readShisaLinkState(shisaLinkStatePath(h.paths)).acked, false);
			return response(204);
		},
	});
	assert.equal(calls.length, 3);
	assert.equal(readShisaLinkState(shisaLinkStatePath(h.paths)).acked, true);
	assert.match(h.text(), /https:\/\/example.test\/connect/);
	assert.match(h.text(), /JOUZU-TEST-1234/);
	assert.match(h.text(), /Signed in to Shisa AI/);
	assert.doesNotMatch(h.text(), /device-secret|link-secret|shsk:test-secret|other-secret/);
	assert.equal(JSON.parse(readFileSync(join(h.paths.agentDir, "auth.json"))).other.key, "other-secret");
});

test("network failure allows startup to continue with manual recovery and no repeated offer", async (t) => {
	const h = harness(t, {
		ask: async () => "y",
		fetchImpl: async () => {
			throw new Error("secret-in-error");
		},
	});
	await offerShisaOnboarding(h.options);
	assert.match(h.text(), /could not complete/);
	assert.match(h.text(), /\/login shisa/);
	assert.doesNotMatch(h.text(), /secret-in-error/);
	await offerShisaOnboarding({ ...h.options, ask: () => assert.fail("prompted twice") });
});

test("cancellation during login aborts the network and removes the process listener", async (t) => {
	const controller = new AbortController();
	const listeners = process.listenerCount("SIGINT");
	const h = harness(t, { ask: async () => "y", signal: controller.signal });
	await offerShisaOnboarding({
		...h.options,
		fetchImpl: async (_url, { signal }) => {
			controller.abort();
			signal.throwIfAborted();
		},
	});
	assert.match(h.text(), /cancelled/);
	assert.equal(process.listenerCount("SIGINT"), listeners);
	assert.equal(readShisaLoginToken(h.paths), undefined);
});

test("cancellation before an answer does not record consent", async (t) => {
	const controller = new AbortController();
	const h = harness(t, {
		signal: controller.signal,
		ask: async () => {
			controller.abort();
			return "y";
		},
	});
	await offerShisaOnboarding(h.options);
	assert.equal(existsSync(shisaOnboardingPath(h.paths)), false);
});

test("storage failure does not start login", async (t) => {
	const h = harness(t, { ask: async () => "y" });
	mkdirSync(join(h.paths.stateDir, ".."), { recursive: true });
	writeFileSync(h.paths.stateDir, "not a directory");
	await offerShisaOnboarding(h.options);
	assert.match(h.text(), /storage permissions/);
	assert.equal(readShisaLoginToken(h.paths), undefined);
});

test("the readline prompt accepts Enter as skip and closes its input listener", async (t) => {
	const h = harness(t);
	const input = new PassThrough();
	h.output.on("data", (data) => {
		if (data.toString().includes("[y/N]")) queueMicrotask(() => input.write("\n"));
	});
	await offerShisaOnboarding({ ...h.options, ask: undefined, input });
	assert.equal(JSON.parse(readFileSync(shisaOnboardingPath(h.paths))).choice, "skip");
	assert.equal(input.listenerCount("data"), 0);
});

test("EOF cancels an unanswered readline prompt without recording a decision", { timeout: 2000 }, async (t) => {
	const h = harness(t);
	const input = new PassThrough();
	h.output.on("data", (data) => {
		if (data.toString().includes("[y/N]")) queueMicrotask(() => input.end());
	});
	await offerShisaOnboarding({ ...h.options, ask: undefined, input });
	assert.equal(existsSync(shisaOnboardingPath(h.paths)), false);
	assert.match(h.text(), /cancelled/);
});

test("credential storage failure is reported without acknowledgement", async (t) => {
	const h = harness(t, { ask: async () => "y" });
	mkdirSync(join(h.paths.agentDir, "auth.json"), { recursive: true });
	await offerShisaOnboarding({
		...h.options,
		fetchImpl: async (url) => {
			if (url.endsWith("/code")) return response(201, code);
			if (url.endsWith("/token")) return response(200, token);
			assert.fail("must not acknowledge failed storage");
		},
	});
	assert.match(h.text(), /storage permissions/);
	assert.doesNotMatch(h.text(), /Signed in to Shisa AI/);
});

test("unknown terminal width uses readable prose wrapping", async (t) => {
	const h = harness(t);
	h.output.columns = 0;
	await offerShisaOnboarding(h.options);
	assert.match(h.text(), /Connect to Shisa AI for access/);
});

const ESCAPE = "\u001b";
const MARKER_LINE = "  \u25c6 Connect to Shisa AI";

test("offer lines carry a marker and stay plain without color", async (t) => {
	const h = harness(t);
	await offerShisaOnboarding(h.options);
	assert.ok(h.text().includes(MARKER_LINE), h.text());
	assert.ok(h.text().includes("  \u25c6 New signups"), h.text());
	assert.ok(!h.text().includes(ESCAPE), h.text());
});

test("color styles the marker and the prompt hint without touching the copy", async (t) => {
	let asked = "";
	const h = harness(t, {
		colorEnabled: true,
		ask: async (question) => {
			asked = question;
			return "n";
		},
	});
	await offerShisaOnboarding(h.options);
	assert.ok(asked.includes("[y/N]"), asked);
	assert.ok(asked.includes(`${ESCAPE}[2m(or later with /login shisa)${ESCAPE}[0m`), asked);
	assert.ok(h.text().includes(`  ${ESCAPE}[36m\u25c6${ESCAPE}[0m Connect to Shisa AI`), h.text());
	for (const line of h.text().split("\n")) assert.ok(visibleWidth(line) <= 48, line);
});

test("NO_COLOR and dumb terminals keep the marker and drop the escapes", async (t) => {
	for (const env of [{ NO_COLOR: "1", TERM: "xterm-256color" }, { TERM: "dumb" }]) {
		const h = harness(t, { env });
		h.output.isTTY = true;
		await offerShisaOnboarding(h.options);
		assert.ok(h.text().includes(MARKER_LINE), h.text());
		assert.ok(!h.text().includes(ESCAPE), h.text());
	}
});
