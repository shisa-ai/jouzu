import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveJouzuPaths } from "../dist/paths.js";
import {
	defaultPiAgentDir,
	offerPiConfigurationImport,
	PiImportError,
	parsePiImportAnswer,
	readPiImportReceipt,
} from "../dist/pi-import.js";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "jouzu-pi-import-"));
	return {
		root,
		paths: resolveJouzuPaths({ homeOverride: join(root, "jouzu") }),
		source: join(root, "stock-pi"),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("resolves Pi's default agent root on Linux, macOS, and Windows", () => {
	assert.equal(defaultPiAgentDir("linux", "/home/上手"), "/home/上手/.pi/agent");
	assert.equal(defaultPiAgentDir("darwin", "/Users/上手"), "/Users/上手/.pi/agent");
	assert.equal(defaultPiAgentDir("win32", "C:\\Users\\上手"), "C:\\Users\\上手\\.pi\\agent");
});

test("requires affirmative consent independently for models and credentials", async () => {
	const { paths, source, cleanup } = fixture();
	try {
		mkdirSync(source, { recursive: true });
		const models = '{"providers":{"local":{"baseUrl":"http://127.0.0.1:1234"}}}\n';
		const auth = '{"anthropic":{"type":"api_key","key":"secret"}}\n';
		writeFileSync(join(source, "models.json"), models);
		writeFileSync(join(source, "auth.json"), auth);
		const questions = [];
		const answers = ["", "yes"];
		let output = "";
		const receipt = await offerPiConfigurationImport(paths, {
			inheritedAgentDir: source,
			homeDir: join(paths.stateDir, "unused-home"),
			output: {
				write(value) {
					output += value;
				},
			},
			ask: async (question) => {
				questions.push(question);
				return answers.shift();
			},
			now: new Date("2026-08-26T00:00:00Z"),
		});
		assert.equal(questions.length, 2);
		assert.match(questions[0], /models\.json/);
		assert.match(questions[1], /provider credentials/);
		assert.deepEqual(receipt.models, { status: "declined", source: "inherited" });
		assert.deepEqual(receipt.auth, { status: "imported", source: "inherited" });
		assert.equal(readFileSync(join(source, "models.json"), "utf8"), models);
		assert.throws(() => readFileSync(join(paths.agentDir, "models.json")), /ENOENT/);
		assert.equal(readFileSync(join(paths.agentDir, "auth.json"), "utf8"), auth);
		assert.equal(readFileSync(join(source, "auth.json"), "utf8"), auth);
		if (process.platform !== "win32") {
			assert.equal(statSync(join(paths.agentDir, "auth.json")).mode & 0o777, 0o600);
		}
		assert.doesNotMatch(output, /secret|anthropic/);
		assert.equal(readPiImportReceipt(join(paths.stateDir, "pi-import.json")).decidedAt, "2026-08-26T00:00:00.000Z");
	} finally {
		cleanup();
	}
});

test("uses the inherited root before the default root and does not repeat a recorded offer", async () => {
	const { root, paths, source, cleanup } = fixture();
	try {
		const defaultRoot = join(root, "home", ".pi", "agent");
		mkdirSync(source, { recursive: true });
		mkdirSync(defaultRoot, { recursive: true });
		writeFileSync(join(source, "models.json"), '{"source":"inherited"}\n');
		writeFileSync(join(defaultRoot, "models.json"), '{"source":"default"}\n');
		let prompts = 0;
		const first = await offerPiConfigurationImport(paths, {
			inheritedAgentDir: source,
			homeDir: join(root, "home"),
			output: { write() {} },
			ask: async () => {
				prompts += 1;
				return "y";
			},
		});
		assert.deepEqual(first.models, { status: "imported", source: "inherited" });
		assert.equal(JSON.parse(readFileSync(join(paths.agentDir, "models.json"), "utf8")).source, "inherited");
		const second = await offerPiConfigurationImport(paths, {
			inheritedAgentDir: source,
			homeDir: join(root, "home"),
			ask: async () => {
				throw new Error("receipt should suppress prompts");
			},
		});
		assert.deepEqual(second, first);
		assert.equal(prompts, 1);
	} finally {
		cleanup();
	}
});

test("discovers the default Pi root when no inherited root is configured", async () => {
	const { root, paths, cleanup } = fixture();
	try {
		const home = join(root, "home");
		const source = join(home, ".pi", "agent");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "models.json"), "{}\n");
		const receipt = await offerPiConfigurationImport(paths, {
			homeDir: home,
			env: {},
			output: { write() {} },
			ask: async () => "yes",
		});
		assert.deepEqual(receipt.models, { status: "imported", source: "default" });
		assert.equal(readFileSync(join(paths.agentDir, "models.json"), "utf8"), "{}\n");
	} finally {
		cleanup();
	}
});

test("rejects malformed, oversized, and symbolic-link sources without prompting", async () => {
	const cases = [
		{ setup: (path) => writeFileSync(path, "[]\n") },
		{ setup: (path) => writeFileSync(path, '{"tooLarge":true}\n'), maxFileBytes: 2 },
		{
			setup: (path, root) => {
				const target = join(root, "target.json");
				writeFileSync(target, "{}\n");
				symlinkSync(target, path);
			},
		},
	];
	for (const { setup, maxFileBytes } of cases) {
		const { root, paths, source, cleanup } = fixture();
		try {
			mkdirSync(source, { recursive: true });
			setup(join(source, "models.json"), root);
			let output = "";
			const receipt = await offerPiConfigurationImport(paths, {
				inheritedAgentDir: source,
				homeDir: join(root, "home"),
				maxFileBytes,
				output: {
					write: (value) => {
						output += value;
					},
				},
				ask: async () => {
					throw new Error("invalid files must not prompt");
				},
			});
			assert.equal(receipt.models.status, "invalid-source");
			assert.match(output, /not imported/);
		} finally {
			cleanup();
		}
	}
});

test("preserves an existing Jouzu destination and supports a one-run opt-out", async () => {
	const { root, paths, source, cleanup } = fixture();
	try {
		mkdirSync(source, { recursive: true });
		mkdirSync(paths.agentDir, { recursive: true });
		writeFileSync(join(source, "models.json"), '{"source":true}\n');
		writeFileSync(join(paths.agentDir, "models.json"), '{"destination":true}\n');
		assert.equal(
			await offerPiConfigurationImport(paths, {
				env: { JOUZU_NO_PI_IMPORT: "1" },
				inheritedAgentDir: source,
			}),
			undefined,
		);
		assert.throws(() => readFileSync(join(paths.stateDir, "pi-import.json")), /ENOENT/);
		const receipt = await offerPiConfigurationImport(paths, {
			inheritedAgentDir: source,
			homeDir: join(root, "home"),
			ask: async () => {
				throw new Error("existing destinations must not prompt");
			},
		});
		assert.equal(receipt.models.status, "destination-exists");
		assert.deepEqual(JSON.parse(readFileSync(join(paths.agentDir, "models.json"), "utf8")), { destination: true });
	} finally {
		cleanup();
	}
});

test("a live import lock prevents concurrent prompts", async () => {
	const { paths, cleanup } = fixture();
	try {
		mkdirSync(paths.stateDir, { recursive: true });
		writeFileSync(
			join(paths.stateDir, "pi-import.lock"),
			`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: "held" })}\n`,
		);
		await assert.rejects(
			offerPiConfigurationImport(paths, {
				ask: async () => {
					throw new Error("a busy import must not prompt");
				},
			}),
			PiImportError,
		);
		assert.equal(JSON.parse(readFileSync(join(paths.stateDir, "pi-import.lock"), "utf8")).token, "held");
	} finally {
		cleanup();
	}
});

test("answers default to no and malformed receipts fail closed", () => {
	assert.equal(parsePiImportAnswer(" y "), true);
	assert.equal(parsePiImportAnswer("YES"), true);
	for (const answer of ["", "n", "no", "later"]) assert.equal(parsePiImportAnswer(answer), false);
	const { root, paths, cleanup } = fixture();
	try {
		mkdirSync(paths.stateDir, { recursive: true });
		const target = join(root, "receipt-target.json");
		writeFileSync(target, "{}\n");
		symlinkSync(target, join(paths.stateDir, "pi-import.json"));
		assert.throws(() => readPiImportReceipt(join(paths.stateDir, "pi-import.json")), PiImportError);
	} finally {
		cleanup();
	}
});
